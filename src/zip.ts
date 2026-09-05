// Minimal ZIP (PKZIP APPNOTE 6.3.4) writer using STORE method.
// STORE is sufficient because:
//   - png/jpeg/webp/avif/mp4/webm are already compressed
//   - svg/text: we save them as-is; size is small enough that DEFLATE is not
//     required for typical notes. We can add DEFLATE later if needed.
//
// Output structure (one entry):
//   [Local File Header] [file data] [Data Descriptor]
//
// We write Data Descriptor after the file body so we don't have to know
// the CRC32 size in advance (CRC32 over file bytes is computed as we stream).
// Some readers still want the CRC in the Local Header; we set it there too.

const SIG = {
  LOCAL: 0x04034b50,
  CENTRAL: 0x02014b50,
  END: 0x06054b50,
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type Entry = { name: string; data: Uint8Array };

// All entry names are flattened into a single "files/" directory with
// de-duplicated names ("a.png", "a (2).png", ...).
export function dedupNames(entries: { name: string }[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const e of entries) {
    const n = e.name;
    const c = seen.get(n) ?? 0;
    if (c === 0) {
      seen.set(n, 1);
      out.push(n);
    } else {
      // Already seen once; this is the c-th duplicate (2nd, 3rd, ...).
      seen.set(n, c + 1);
      const dot = n.lastIndexOf(".");
      const base = dot >= 0 ? n.slice(0, dot) : n;
      const ext = dot >= 0 ? n.slice(dot) : "";
      out.push(`${base} (${c + 1})${ext}`);
    }
  }
  return out;
}

// Build a single Uint8Array containing the whole ZIP. For large outputs we'd
// stream, but typical notes are small.
export function buildZip(entries: Entry[]): Uint8Array {
  const names = dedupNames(entries);

  // Pre-encode names + bodies
  const encoded = entries.map((e, i) => ({
    name: new TextEncoder().encode(names[i]),
    body: e.data,
    crc: crc32(e.data),
    size: e.data.length,
    offset: 0, // filled in below
  }));

  // Layout: per-entry [local header + body + descriptor], then central dir, then EOCD.
  let total = 0;
  const localOffsets: number[] = [];
  for (const f of encoded) {
    f.offset = total;
    const lh = 30 + f.name.length;
    const dd = 16;
    total += lh + f.size + dd;
  }
  let centralSize = 0;
  for (const f of encoded) {
    centralSize += 46 + f.name.length;
  }
  total += centralSize + 22;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  const w32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
  const w16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
  const wBlob = (b: Uint8Array) => { out.set(b, p); p += b.length; };

  for (const f of encoded) {
    localOffsets.push(f.offset);
    w32(SIG.LOCAL);
    w16(20);              // version needed
    w16(0x0800);          // general purpose: bit 11 = UTF-8 names
    w16(0);               // method = stored
    w16(0); w16(0);       // mtime, mdate (zero)
    w32(f.crc);
    w32(f.size);          // compressed size (= stored size)
    w32(f.size);          // uncompressed size
    w16(f.name.length);
    w16(0);               // extra
    wBlob(f.name);
    wBlob(f.body);
    // Data descriptor (CRC, size, size) — bit 3 of gp flag was not set, so this
    // is optional, but readers tolerate it.
    w32(0x08074b50);
    w32(f.crc);
    w32(f.size);
    w32(f.size);
  }

  const cdStart = p;
  for (let i = 0; i < encoded.length; i++) {
    const f = encoded[i];
    w32(SIG.CENTRAL);
    w16(20);                 // version made by
    w16(20);                 // version needed
    w16(0x0800);             // gp flag (UTF-8 name)
    w16(0);                  // method = stored
    w16(0); w16(0);          // mtime, mdate
    w32(f.crc);
    w32(f.size);             // compressed size
    w32(f.size);             // uncompressed size
    w16(f.name.length);
    w16(0);                  // extra
    w16(0);                  // comment
    w16(0);                  // disk #
    w16(0);                  // internal attrs
    w32(0);                  // external attrs
    w32(localOffsets[i]);    // local header offset
    wBlob(f.name);
  }

  // EOCD
  w32(SIG.END);
  w16(0); w16(0);
  w16(encoded.length); w16(encoded.length);
  w32(centralSize);
  w32(cdStart);
  w16(0);

  return out;
}

// Extract media references from HTML. Returns absolute URLs (or relative
// `/img/...` paths) pointing at media assets.
const MEDIA_SRC_RE = /<(?:img|video)[^>]*\s(?:src|poster)=["']([^"']+)["']/gi;

export function extractMediaUrls(html: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MEDIA_SRC_RE.exec(html))) {
    const v = m[1];
    if (v && v.includes("/img/")) out.push(v);
  }
  // Dedup preserving order
  const seen = new Set<string>();
  return out.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

// Resolve a possibly-relative URL against an origin.
export function resolveUrl(url: string, origin: string): string | null {
  try {
    if (/^https?:\/\//i.test(url)) return new URL(url).toString();
    if (url.startsWith("/")) return new URL(url, origin).toString();
    return null;
  } catch { return null; }
}
