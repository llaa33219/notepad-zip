// In-process smoke test: imports the built worker and exercises each route
// with mock KV/R2 bindings. No network, no wrangler dev required.

import fs from "node:fs";
const log = (s) => fs.writeSync(1, s + "\n");

const { default: handler } = await import("../dist/index.js");

class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list() { return { keys: [...this.m.keys()].map((n) => ({ name: n })), list_complete: true }; }
}
class MockR2 {
  constructor() { this.m = new Map(); }
  async put(k, body, opts) {
    this.m.set(k, {
      body, httpMetadata: opts?.httpMetadata ?? {}, customMetadata: opts?.customMetadata ?? {},
      httpEtag: `"${k}"`, uploaded: new Date(),
    });
  }
  async get(k) { return this.m.get(k) ?? null; }
  async delete(k) { this.m.delete(k); }
}

const env = {
  NOTES: new MockKV(),
  IMAGES: new MockR2(),
  PUBLIC_ORIGIN: "http://localhost:8787",
};

let pass = 0, fail = 0;
const ok = (msg) => { pass++; log(`  PASS  ${msg}`); };
const bad = (msg, got) => { fail++; log(`  FAIL  ${msg}  got=${got}`); };

const call = (method, path, body, headers = {}) =>
  handler.fetch(new Request(`http://localhost:8787${path}`, {
    method, headers, body,
  }), env, {});

const PNG_1x1 = Uint8Array.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
  0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0d,0x49,0x44,0x41,
  0x54,0x78,0x9c,0x63,0xfa,0xcf,0xc0,0xc0,
  0xc0,0xc0,0xc0,0x00,0x00,0x00,0x05,0x00,
  0x01,0xe2,0x26,0x05,0x9b,0x00,0x00,0x00,
  0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82,
]);

log("\n[1] GET / -> HTML shell");
{
  const r = await call("GET", "/");
  const t = await r.text();
  if (r.status !== 200) bad("status", r.status);
  else if (!t.includes("contenteditable")) bad("has contenteditable", "missing");
  else ok("200 + editor shell");
}

log("\n[2] GET /abcdefgh -> shell embeds id");
{
  const r = await call("GET", "/abcdefgh");
  const t = await r.text();
  if (r.status !== 200) bad("status", r.status);
  else if (!t.includes('"id":"abcdefgh"')) bad("embeds id", "missing");
  else ok("shell preloads id");
}

log("\n[3] GET /a/b/c -> 404");
{
  const r = await call("GET", "/a/b/c");
  if (r.status !== 404) bad("404", r.status);
  else ok("nested paths 404");
}

log("\n[4] GET /BAD..ID -> 404");
{
  const r = await call("GET", "/BAD..ID");
  if (r.status !== 404) bad("404", r.status);
  else ok("bad id rejected");
}

log("\n[5] GET /client.js -> 200 editor JS");
{
  const r = await call("GET", "/client.js");
  const t = await r.text();
  if (r.status !== 200) bad("status", r.status);
  else if (!t.includes("genId") || !t.includes("serialize")) bad("is editor JS", "missing markers");
  else if (!t.includes("run();")) bad("has IIFE", "missing run(); call");
  else ok(`served (${t.length} bytes)`);
}

let uploadedUrl = null;
log("\n[6] POST /api/upload (no body) -> 400");
{
  const r = await call("POST", "/api/upload");
  if (r.status !== 400) bad("400", r.status);
  else ok("rejected without multipart");
}

log("\n[7] POST /api/upload (png) -> 200");
{
  const fd = new FormData();
  fd.append("file", new Blob([PNG_1x1], { type: "image/png" }), "test.png");
  const r = await call("POST", "/api/upload", fd);
  const body = await r.json();
  if (r.status !== 200) bad("200", r.status);
  else if (!body.url || !body.url.includes("/img/img_")) bad("returns /img/<key>", JSON.stringify(body));
  else { uploadedUrl = body.url; ok(`returns ${body.url}`); }
}

log("\n[8] GET /img/<uploaded> -> 200 image/png");
{
  if (!uploadedUrl) { bad("uploaded missing", "skipped"); }
  else {
    const r = await call("GET", new URL(uploadedUrl).pathname);
    if (r.status !== 200) bad("200", r.status);
    else if (!r.headers.get("content-type")?.includes("image/png")) bad("ct image/png", r.headers.get("content-type"));
    else ok("served with image/png");
  }
}

log("\n[9] GET /img/notmatching.png -> 404");
{
  const r = await call("GET", "/img/notmatching.png");
  if (r.status !== 404) bad("404", r.status);
  else ok("invalid key 404");
}

log("\n[10] GET /api/note/abcdefgh (missing) -> 404");
{
  const r = await call("GET", "/api/note/abcdefgh");
  if (r.status !== 404) bad("404", r.status);
  else ok("missing note 404");
}

log("\n[11] PUT/GET round-trip");
{
  const r = await call("PUT", "/api/note/abcdefgh", JSON.stringify({ html: "<p>hi</p>" }), { "content-type": "application/json" });
  const body = await r.json();
  if (r.status !== 200 || body.ok !== true) bad("write", `${r.status} ${JSON.stringify(body)}`);
  else ok("write ok");
  const r2 = await call("GET", "/api/note/abcdefgh");
  const b2 = await r2.json();
  if (r2.status !== 200) bad("read status", r2.status);
  else if (b2.html !== "<p>hi</p>") bad("round-trip", JSON.stringify(b2));
  else ok("read back exact");
}

log("\n[12] PUT invalid json -> 400");
{
  const r = await call("PUT", "/api/note/abcdefgh", "not json", { "content-type": "application/json" });
  if (r.status !== 400) bad("400", r.status);
  else ok("rejected");
}

log("\n[13] PUT missing html -> 400");
{
  const r = await call("PUT", "/api/note/abcdefgh", JSON.stringify({ foo: 1 }), { "content-type": "application/json" });
  if (r.status !== 400) bad("400", r.status);
  else ok("rejected");
}

log("\n[14] PUT html > 8 MiB -> 400");
{
  const big = "<p>" + "a".repeat(9 * 1024 * 1024) + "</p>";
  const r = await call("PUT", "/api/note/bigtest", JSON.stringify({ html: big }), { "content-type": "application/json" });
  if (r.status !== 500 && r.status !== 400) bad("limit", r.status);
  else ok("oversized rejected");
}

log("\n[15] method routing -> 405 + Allow");
{
  const r = await call("POST", "/api/note/abcdefgh");
  if (r.status !== 405) bad("405", r.status);
  else if (r.headers.get("allow") !== "GET, PUT, HEAD") bad("Allow", r.headers.get("allow"));
  else ok("405 + Allow on POST note");
  const r2 = await call("GET", "/api/upload");
  if (r2.status !== 405) bad("405", r2.status);
  else ok("405 on GET upload");
  const r3 = await call("PUT", "/img/foo.png");
  if (r3.status !== 405) bad("405", r3.status);
  else ok("405 on PUT image");
}


log("\n[16] POST /api/upload (svg) -> 200");
{
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
  const fd = new FormData();
  fd.append("file", new Blob([svg], { type: "image/svg+xml" }), "x.svg");
  const r = await call("POST", "/api/upload", fd);
  const body = await r.json();
  if (r.status !== 200) bad("svg upload", r.status);
  else if (!body.url || !body.url.endsWith(".svg")) bad("svg url", JSON.stringify(body));
  else ok("svg accepted, " + body.url);
}

log("\n[17] POST /api/upload (video/mp4) -> 200");
{
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array([0,0,0,0])], { type: "video/mp4" }), "v.mp4");
  const r = await call("POST", "/api/upload", fd);
  const body = await r.json();
  if (r.status !== 200) bad("video upload", r.status);
  else if (!body.url || !body.url.endsWith(".mp4")) bad("video url", JSON.stringify(body));
  else ok("video accepted, " + body.url);
}

log("\n[18] POST /api/upload (text/plain) -> 400 (not allowed)");
{
  const fd = new FormData();
  fd.append("file", new Blob(["hi"], { type: "text/plain" }), "x.txt");
  const r = await call("POST", "/api/upload", fd);
  if (r.status !== 400) bad("reject text/plain", r.status);
  else ok("rejected");
}

log("\n[19] PUT note with images, then GET /api/note/:id/zip");
{
  // Upload two distinct images.
  const fd1 = new FormData();
  fd1.append("file", new Blob([PNG_1x1], { type: "image/png" }), "a.png");
  const u1 = await (await call("POST", "/api/upload", fd1)).json();
  const fd2 = new FormData();
  fd2.append("file", new Blob([PNG_1x1], { type: "image/png" }), "b.png");
  const u2 = await (await call("POST", "/api/upload", fd2)).json();

  // Store note that references both images.
  const html = `<p>hi</p><img src="${u1.url}"><br><img src="${u2.url}">`;
  const w = await call("PUT", "/api/note/ziptest", JSON.stringify({ html }), { "content-type": "application/json" });
  if (w.status !== 200) { bad("put note", w.status); }
  else ok("note written with 2 images");

  const r = await call("GET", "/api/note/ziptest/zip");
  if (r.status !== 200) { bad("zip status", r.status); }
  else if (r.headers.get("content-type") !== "application/zip") bad("zip ct", r.headers.get("content-type"));
  else if (!r.headers.get("content-disposition")?.includes("notepad-ziptest.zip")) bad("filename", r.headers.get("content-disposition"));
  else if (r.headers.get("x-note-media-count") !== "2") bad("media count", r.headers.get("x-note-media-count"));
  else {
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 100) bad("zip too small", buf.byteLength);
    else ok(`zip ok (${buf.byteLength} bytes, ct=${r.headers.get("content-type")})`);
  }
}

log("\n[20] GET /api/note/ziptest/zip -> 404 for missing note");
{
  const r = await call("GET", "/api/note/zzzzzzzz/zip");
  if (r.status !== 404) bad("404", r.status);
  else ok("missing -> 404");
}

log("\n[21] PUT /api/note/:id/zip -> 405");
{
  const r = await call("PUT", "/api/note/ziptest/zip");
  if (r.status !== 405) bad("405", r.status);
  else ok("405");
}


log("\n[22] PUT note with 9.6 MiB UTF-8 bytes -> 400 (rejected at 8 MiB cap)");
{
  // Each \uac00 encodes as 3 UTF-8 bytes. 3.2M reps => ~9.6 MiB bytes,
  // while html.length (UTF-16 units) is only ~3.2M chars so it would slip
  // past the character-only check.
  const html = "<p>" + "\uac00".repeat(3_200_000) + "</p>";
  const r = await call("PUT", "/api/note/utf8big", JSON.stringify({ html }), { "content-type": "application/json" });
  if (r.status !== 400 && r.status !== 500) bad("utf8 byte limit", r.status);
  else ok(`rejected at ${r.status}`);
}

log("\n[23] PUT note within limit -> 200");
{
  const html = "<p>" + "\uac00\ub098\ub2e4".repeat(100) + "</p>";  // 600 bytes
  const r = await call("PUT", "/api/note/utf8small", JSON.stringify({ html }), { "content-type": "application/json" });
  if (r.status !== 200) bad("utf8 ok", r.status);
  else ok("accepted");
}

log("\n[24] POST /api/upload with malformed multipart -> 400 not 500");
{
  const r = await call("POST", "/api/upload", "garbage", { "content-type": "multipart/form-data; boundary=xxx" });
  if (r.status !== 400) bad("400 expected", r.status);
  else ok("rejected with 400, not 500");
}


log("\n[25] PUT 200 KiB plain text note -> 200 (within enlarged limit)");
{
  const html = "<p>" + "x".repeat(200 * 1024) + "</p>";  // 200 KiB chars
  const r = await call("PUT", "/api/note/big200", JSON.stringify({ html }), { "content-type": "application/json" });
  if (r.status !== 200) bad("200 kiB plain", r.status);
  else ok("accepted");
}

log("\n[26] PUT 5 MiB plain text note -> 200 (within 25 MiB KV cap)");
{
  const html = "<p>" + "x".repeat(5 * 1024 * 1024) + "</p>";
  const r = await call("PUT", "/api/note/big5m", JSON.stringify({ html }), { "content-type": "application/json" });
  if (r.status !== 200) bad("5 MiB plain", r.status);
  else ok("accepted");
}

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
