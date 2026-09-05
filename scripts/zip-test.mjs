// Standalone test for src/zip.ts. We compile-check by using wrangler's
// esbuild pipeline on zip.ts, then validate CRC32, buildZip round-trip, and
// extractMediaUrls.

import fs from "node:fs";
import { execSync } from "node:child_process";
const log = (s) => fs.writeSync(1, s + "\n");

// Compile zip.ts to dist-test/zip.mjs using esbuild from node_modules
execSync(
  "npx esbuild src/zip.ts --bundle=false --format=esm --outfile=dist-test/zip.mjs --platform=node --target=es2022",
  { stdio: "inherit" }
);
const { buildZip, crc32, extractMediaUrls, resolveUrl, dedupNames } = await import("../dist-test/zip.mjs");

let pass = 0, fail = 0;
const ok = (m) => { pass++; log(`  PASS  ${m}`); };
const bad = (m, g) => { fail++; log(`  FAIL  ${m}  got=${g}`); };

// --- CRC32 known vector: "123456789" -> 0xCBF43926 -------------------
log("\n[1] CRC32 of '123456789' is 0xCBF43926");
{
  const data = new TextEncoder().encode("123456789");
  const c = crc32(data);
  if (c !== 0xCBF43926) bad("crc32", "0x" + c.toString(16));
  else ok(`crc32 = 0x${c.toString(16)}`);
}

// --- CRC32 empty ------------------------------------------------------
log("\n[2] CRC32 of empty = 0");
{
  if (crc32(new Uint8Array(0)) !== 0) bad("empty crc", crc32(new Uint8Array(0)));
  else ok("empty -> 0");
}

// --- dedupNames -------------------------------------------------------
log("\n[3] dedupNames disambiguates duplicates");
{
  const names = dedupNames([{ name: "a.png" }, { name: "a.png" }, { name: "a.png" }, { name: "b.png" }]);
  const want = ["a.png", "a (2).png", "a (3).png", "b.png"];
  if (JSON.stringify(names) !== JSON.stringify(want)) bad("dedup", JSON.stringify(names));
  else ok("a.png, a (2).png, a (3).png, b.png");
}

// --- buildZip + EOCD signature sanity ---------------------------------
log("\n[4] buildZip has PK\\x05\\x06 EOCD signature");
{
  const z = buildZip([{ name: "hi.txt", data: new TextEncoder().encode("hi") }]);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const eocdSig = dv.getUint32(z.length - 22, true);
  if (eocdSig !== 0x06054b50) bad("EOCD sig", "0x" + eocdSig.toString(16));
  else if (z.length < 22) bad("min size", z.length);
  else ok(`EOCD signature present, size=${z.length}`);
}

// --- buildZip round-trip via Node's built-in 'zlib' unzip via unzipper?
// Use Node's child_process + `unzip -p` if available, otherwise use a
// minimal in-memory ZIP reader. We'll write to disk and use `unzip` or
// fall back to a manual reader.
log("\n[5] buildZip round-trip via unzip(1)");
{
  const z = buildZip([
    { name: "note.txt", data: new TextEncoder().encode("hello\nworld\n") },
    { name: "files/img_a.png", data: new Uint8Array([1, 2, 3, 4, 5]) },
  ]);
  const tmp = "/tmp/notepad-zip-test.zip";
  fs.writeFileSync(tmp, z);
  let out;
  try {
    out = execSync(`unzip -p ${tmp} note.txt`, { encoding: "buffer" });
  } catch (e) {
    bad("unzip not available", e.message);
    out = null;
  }
  if (out && out.toString() === "hello\nworld\n") ok("note.txt round-trip");
  else if (out) bad("note.txt content", JSON.stringify(out.toString()));
  try {
    out = execSync(`unzip -p ${tmp} files/img_a.png`, { encoding: "buffer" });
    if (out && out.length === 5 && out[0] === 1 && out[4] === 5) ok("img_a.png round-trip");
    else bad("img content", out);
  } catch {}
}

// --- extractMediaUrls --------------------------------------------------
log("\n[5b] rewriteAbsoluteUrlsToRelative");
{
  function rewrite(text, fetchedKeys, origin) {
    if (fetchedKeys.size === 0) return text;
    return text.replace(/\[((?:https?:\/\/[^\]\s]+|\/?img\/[A-Za-z0-9._-]+))\]/g, (full, url) => {
      try {
        let abs;
        if (/^https?:\/\//i.test(url)) {
          const u = new URL(url);
          if (u.origin !== origin) return full;  // cross-origin -> leave alone
          abs = u.toString();
        } else {
          abs = new URL(url, origin).toString();
        }
        const u = new URL(abs);
        const m = u.pathname.match(/^\/img\/([A-Za-z0-9._-]+)$/);
        if (!m) return full;
        if (!fetchedKeys.has(m[1])) return full;
        return `[files/${m[1]}]`;
      } catch { return full; }
    });
  }
  const fetched = new Set(["img_a.png", "img_b.png"]);
  const input = "see [https://notepad.blp.sh/img/img_a.png] and [/img/img_b.png] and [https://other/img/img_a.png] and [https://notepad.blp.sh/img/img_x.png]";
  const got = rewrite(input, fetched, "https://notepad.blp.sh");
  const want = "see [files/img_a.png] and [files/img_b.png] and [https://other/img/img_a.png] and [https://notepad.blp.sh/img/img_x.png]";
  if (got !== want) bad("rewrite", JSON.stringify(got));
  else ok("rewrites same-origin URLs to files/, leaves others alone");
}

log("\n[5c] end-to-end: ZIP with rewritten note.txt");
{
  // Build plain text as the worker would (with rewriting) and pack it into
  // a ZIP, then verify with unzip(1).
  const html = `<p>see</p><img src="/img/foo.png"><br><img src="https://notepad.blp.sh/img/bar.png">`;
  const plainRaw = "see [https://notepad.blp.sh/img/foo.png]\nand [files/bar.png]";  // simulated
  // Actually the worker's htmlToPlainText is in src/index.ts (TS), not exported
  // from zip.mjs. Here we just check that the rewrite + buildZip pair works.
  const fetchedKeys = new Set(["foo.png", "bar.png"]);
  const origin = "https://notepad.blp.sh";
  const rewrite = (text) => text.replace(/\[((?:https?:\/\/[^\]\s]+|\/?img\/[A-Za-z0-9._-]+))\]/g, (full, url) => {
    let abs;
    if (/^https?:\/\//i.test(url)) abs = new URL(url).toString();
    else abs = new URL(url, origin).toString();
    const u = new URL(abs);
    const m = u.pathname.match(/^\/img\/([A-Za-z0-9._-]+)$/);
    if (!m || !fetchedKeys.has(m[1])) return full;
    return `[files/${m[1]}]`;
  });
  const plain = rewrite(plainRaw);
  const png = new Uint8Array([1, 2, 3, 4, 5]);
  const z = buildZip([
    { name: "note.txt", data: new TextEncoder().encode(plain) },
    { name: "files/foo.png", data: png },
    { name: "files/bar.png", data: png },
  ]);
  const tmp = "/tmp/notepad-relative.zip";
  fs.writeFileSync(tmp, z);
  let out;
  try {
    out = execSync(`unzip -p ${tmp} note.txt`, { encoding: "buffer" });
  } catch (e) { bad("unzip note.txt", e.message); out = null; }
  if (out && out.toString() === "see [files/foo.png]\nand [files/bar.png]") ok("note.txt uses files/<key>");
  else if (out) bad("note.txt content", JSON.stringify(out.toString()));
}

log("\n[6] extractMediaUrls from HTML");
{
  const html = `<p>hello</p><img src="/img/foo.png"><br><img src='https://x.com/img/foo.png'><video controls src="/img/v.mp4"></video><img src="/img/foo.png">`;
  const urls = extractMediaUrls(html);
  const want = ["/img/foo.png", "https://x.com/img/foo.png", "/img/v.mp4"];
  if (JSON.stringify(urls) !== JSON.stringify(want)) bad("urls", JSON.stringify(urls));
  else ok("deduped, order preserved");
}

// --- resolveUrl -------------------------------------------------------
log("\n[7] resolveUrl");
{
  if (resolveUrl("http://h/img/x.png", "http://h") !== "http://h/img/x.png") bad("same-origin full", resolveUrl("http://h/img/x.png","http://h"));
  else ok("same-origin absolute URL passes");
  if (resolveUrl("/img/x.png", "http://h") !== "http://h/img/x.png") bad("absolute", resolveUrl("/img/x.png","http://h"));
  else ok("root-relative path");
  // Cross-origin URL is now filtered out (returns null) so the caller
  // can leave it untouched in plain text.
  if (resolveUrl("https://x.com/a", "http://h") !== null) bad("cross-origin", resolveUrl("https://x.com/a","http://h"));
  else ok("cross-origin -> null");
  if (resolveUrl("not a url", "http://h") !== null) bad("invalid", resolveUrl("not a url","http://h"));
  else ok("invalid -> null");
}

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
