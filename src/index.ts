// Cloudflare Worker entry. Serves the notepad HTML shell, R2 image uploads
// and downloads, and KV-backed note storage. The client module is embedded
// as a function and served at /client.js.

import { htmlShell } from "./html";
import clientRun from "./client.js";
import { buildZip, extractMediaUrls, resolveUrl } from "./zip";


export interface Env {
  NOTES: KVNamespace;
  IMAGES: R2Bucket;
  PUBLIC_ORIGIN: string;
}

const NOTE_ID_RE = /^[a-z0-9]{4,32}$/;
const IMG_KEY_RE = /^img_[a-zA-Z0-9_-]{8,64}\.[a-z0-9]{1,8}$/;

const MAX_NOTE_BYTES = 8 * 1024 * 1024; // 8 MiB per note (well below 25 MiB KV cap)
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MiB per image

// image/* + video/* + svg
const ALLOWED_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "image/svg+xml",
  "video/mp4", "video/webm", "video/quicktime", "video/ogg",
]);

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function methodNotAllowed(allowed: string[]): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: allowed.join(", ") },
  });
}

function badRequest(msg: string): Response {
  return json({ error: msg }, { status: 400 });
}

function serverError(msg: string): Response {
  return json({ error: msg }, { status: 500 });
}

function publicOrigin(req: Request, env: Env): string {
  // Prefer configured origin; fall back to request URL origin.
  if (env.PUBLIC_ORIGIN && !env.PUBLIC_ORIGIN.includes("localhost")) {
    return env.PUBLIC_ORIGIN;
  }
  return new URL(req.url).origin;
}

function page(req: Request, env: Env, id: string): Response {
  const origin = publicOrigin(req, env);
  const body = htmlShell({ id, origin });
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readNote(env: Env, id: string): Promise<string | null> {
  const v = await env.NOTES.get(id);
  return v;
}

async function writeNote(env: Env, id: string, html: string): Promise<void> {
  // KV measures storage in bytes, not JS string length (UTF-16 units).
  // A CJK-heavy note can blow past 256 KiB byte-wise while still being
  // well under 256 KiB characters. Check the UTF-8 byte length.
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_NOTE_BYTES) {
    throw new Error(`note too large: ${bytes} bytes (max ${MAX_NOTE_BYTES})`);
  }
  await env.NOTES.put(id, html, {
    metadata: { updatedAt: Date.now(), bytes },
  });
}

async function uploadImage(req: Request, env: Env): Promise<Response> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    return badRequest("multipart/form-data required");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return badRequest(`malformed multipart body: ${(e as Error).message ?? "unknown"}`);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return badRequest("file field required");

  if (!ALLOWED_MEDIA_TYPES.has(file.type)) {
    return badRequest(`unsupported type: ${file.type}`);
  }
  if (file.size === 0) return badRequest("empty file");
  if (file.size > MAX_MEDIA_BYTES) return badRequest("file too large");

  // Map mime -> preferred extension.
  const mimeExt = {
    "image/svg+xml": "svg",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/ogg": "ogv",
  };
  const ext = (mimeExt as Record<string, string>)[file.type] ?? file.type.split("/")[1].replace(/[^a-z0-9]/gi, "");
  // crypto-random key
  const rand = new Uint8Array(12);
  crypto.getRandomValues(rand);
  const randB64 = btoa(String.fromCharCode(...rand)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  const key = `img_${randB64}.${ext}`;

  await env.IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { uploadedAt: String(Date.now()) },
  });

  const url = `${publicOrigin(req, env)}/img/${key}`;
  return json({ url, key });
}

async function buildNoteZip(req: Request, env: Env, id: string): Promise<Response> {
  if (!NOTE_ID_RE.test(id)) return badRequest("invalid note id");

  const html = await readNote(env, id);
  if (html == null) return notFound();

  // Plain text representation. We do the same walk the client does for copy.
  const plain = htmlToPlainText(html);

  // Collect media URLs and fetch from R2.
  const origin = publicOrigin(req, env);
  const urls = extractMediaUrls(html);
  const fetched: { name: string; data: Uint8Array }[] = [];
  const seenKeys = new Set<string>();
  const errors: string[] = [];

  // We process sequentially to avoid hammering R2 with concurrent reads for
  // very large notes. Workers have generous subrequest limits, but order is
  // nicer for the user (and easier to debug).
  for (let i = 0; i < urls.length; i++) {
    const abs = resolveUrl(urls[i], origin);
    if (!abs) continue;
    const u = new URL(abs);
    const m = u.pathname.match(/^\/img\/([A-Za-z0-9._-]+)$/);
    if (!m) continue;
    const key = m[1];
    if (!IMG_KEY_RE.test(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const obj = await env.IMAGES.get(key);
    if (!obj) { errors.push(key); continue; }
    // Read into bytes. obj.body is a ReadableStream; collect via Response.
    const buf = await new Response(obj.body).arrayBuffer();
    fetched.push({ name: key, data: new Uint8Array(buf) });
  }

  const entries = [
    { name: "note.txt", data: new TextEncoder().encode(plain) },
    ...fetched.map((f) => ({ name: `files/${f.name}`, data: f.data })),
  ];

  const zip = buildZip(entries);

  // Filename: notepad-{id}.zip (ASCII-safe)
  const fname = `notepad-${id}.zip`;
  return new Response(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${fname}"`,
      "x-note-media-count": String(fetched.length),
      ...(errors.length ? { "x-note-media-errors": errors.join(",") } : {}),
    },
  });
}

// Mirror of the client's toPlainText walk. Single-source-of-truth would be
// nicer, but the client lives in a separate module evaluated in the browser;
// duplicating this small walker is cheaper than a shared util bundle.
function htmlToPlainText(html: string): string {
  const BLOCK = new Set(["p","div","h1","h2","h3","h4","h5","h6","ul","ol","li","blockquote","pre","tr","section","article"]);
  const re = /(<br\s*\/?>)|(<img[^>]*\s(?:src|poster)=["']([^"']+)["'][^>]*>)|(<video[^>]*\s(?:src|poster)=["']([^"']+)["'][^>]*>(?:[\s\S]*?<\/video>)?)|(<\/?[a-zA-Z][^>]*>)|([^<]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) { out.push("\n"); continue; }
    if (m[2]) { out.push(`[${m[3]}]`); continue; }
    if (m[4]) { out.push(`[${m[5]}]`); continue; }
    if (m[6]) {
      const tag = m[6].replace(/^<\/?/, "").replace(/[\s>].*/, "").toLowerCase();
      if (BLOCK.has(tag) && m[6].startsWith("</")) out.push("\n");
      continue;
    }
    if (m[7]) out.push(m[7]);
  }
  return out.join("").replace(/\n{3,}/g, "\n\n");
}


async function serveImage(env: Env, key: string): Promise<Response> {
  if (!IMG_KEY_RE.test(key)) return notFound();
  const obj = await env.IMAGES.get(key);
  if (!obj) return notFound();

  const headers = new Headers();
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (obj.httpMetadata?.contentType) {
    headers.set("content-type", obj.httpMetadata.contentType);
  }
  if (obj.httpMetadata?.contentEncoding) {
    headers.set("content-encoding", obj.httpMetadata.contentEncoding);
  }
  if (obj.uploaded) headers.set("last-modified", obj.uploaded.toUTCString());

  return new Response(obj.body, { headers });
}

async function handleNoteApi(req: Request, env: Env, id: string): Promise<Response> {
  if (!NOTE_ID_RE.test(id)) return badRequest("invalid note id");

  if (req.method === "GET") {
    const html = await readNote(env, id);
    if (html == null) return json({ html: null }, { status: 404 });
    return json({ html });
  }
  if (req.method === "PUT") {
    let body: unknown;
    try { body = await req.json(); } catch { return badRequest("invalid json"); }
    if (typeof body !== "object" || body === null) return badRequest("invalid body");
    const html = (body as Record<string, unknown>).html;
    if (typeof html !== "string") return badRequest("html must be a string");
    try {
      await writeNote(env, id, html);
    } catch (e) {
      return serverError((e as Error).message || "write failed");
    }
    return json({ ok: true, bytes: html.length });
  }
  if (req.method === "HEAD") {
    const html = await readNote(env, id);
    return new Response(null, { status: html == null ? 404 : 200 });
  }
  return methodNotAllowed(["GET", "PUT", "HEAD"]);
}


function serveClientJs() {
  // Wrap the function body in an IIFE so it executes on load.
  const body = clientRun.toString();
  const src = `${body}\nrun();\n`;
  return new Response(src, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;


    // GET /client.js
    if (path === "/client.js") {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      return serveClientJs();
    }

    if (path === "/api/upload") {
      if (req.method !== "POST") return methodNotAllowed(["POST"]);
      try { return await uploadImage(req, env); }
      catch (e) { return serverError((e as Error).message || "upload failed"); }
    }

    // /api/note/:id
    const noteMatch = path.match(/^\/api\/note\/([A-Za-z0-9_-]+)$/);
    if (noteMatch) {
      try { return await handleNoteApi(req, env, noteMatch[1]); }
      catch (e) { return serverError((e as Error).message || "note failed"); }
    }

    // GET /api/note/:id/zip -> download as ZIP
    const zipMatch = path.match(/^\/api\/note\/([A-Za-z0-9_-]+)\/zip$/);
    if (zipMatch) {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      try { return await buildNoteZip(req, env, zipMatch[1]); }
      catch (e) { return serverError((e as Error).message || "zip failed"); }
    }

    // GET /img/:key
    const imgMatch = path.match(/^\/img\/([A-Za-z0-9._-]+)$/);
    if (imgMatch) {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      try { return await serveImage(env, imgMatch[1]); }
      catch (e) { return serverError((e as Error).message || "image failed"); }
    }

    // Root or /:id  -> HTML shell. id from URL is used to load existing note.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    let id = "";
    const rootMatch = path.match(/^\/([A-Za-z0-9_-]+)$/);
    if (rootMatch) id = rootMatch[1];
    if (id && !NOTE_ID_RE.test(id)) return notFound();
    if (path !== "/" && !rootMatch) return notFound();
    return page(req, env, id);
  },
} satisfies ExportedHandler<Env>;
