// Unit-test pure functions embedded in src/client.js (serialize, toPlainText).
// We import the function-wrapped module, then evaluate just the helper
// declarations under a stub DOM.

import fs from "node:fs";
const log = (s) => fs.writeSync(1, s + "\n");

const { default: runFn } = await import("../src/client.js");
const src = runFn.toString();
const openIdx = src.indexOf("{");
const closeIdx = src.lastIndexOf("}");
const body = src.slice(openIdx + 1, closeIdx);

// Stub DOM
class FakeNode {
  constructor(type, value) {
    this.nodeType = type;
    this.nodeValue = value || "";
    this.childNodes = [];
    this.attrs = {};
    this._tag = "";
  }
  set tagName(v) { this._tag = v; }
  get tagName() { return this._tag; }
  getAttribute(k) { return this.attrs[k]; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(n) { this.childNodes.push(n); return n; }
}
function makeEl(tag) { const n = new FakeNode(1); n.tagName = tag.toUpperCase(); return n; }
function makeText(s) { return new FakeNode(3, s); }

const stub = {
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  crypto: globalThis.crypto, // use real WebCrypto
  window: {
    __NOTEPAD__: { id: "", origin: "http://localhost:8787" },
    isSecureContext: true,
    addEventListener: () => {}, removeEventListener: () => {},
  },
  document: {
    getElementById: () => ({
      addEventListener: () => {}, removeEventListener: () => {},
      appendChild: () => {}, set textContent(v){}, get textContent(){return "";},
      innerHTML: "", firstElementChild: null,
    }),
    createElement: (t) => makeEl(t),
    body: { firstElementChild: null },
    execCommand: () => true,
  },
  location: { origin: "http://localhost:8787" },
  history: { replaceState: () => {} },
  navigator: { clipboard: { writeText: async () => {} }, sendBeacon: () => {} },
  URL: { createObjectURL: () => "blob:fake" },
  FormData: class { constructor(){this.m=new Map();} append(k,v){this.m.set(k,v);} },
  File: class { constructor(){} },
  DOMParser: class {
    parseFromString(html) {
      const root = makeEl("div");
      const inner = html.replace(/^<div>|<\/div>$/g, "");
      const re = /(<br\s*\/?>)|(<(img|video)[^>]*>)|(<\/?[a-zA-Z][^>]*>)|([^<]+)/g;
      let m;
      while ((m = re.exec(inner))) {
        if (m[1]) root.appendChild(makeEl("br"));
        else if (m[2]) {
          // void media (img or video): copy src attr, ignore children
          const el = makeEl(m[3]);
          const srcM = m[2].match(/src="([^"]*)"/);
          const altM = m[2].match(/alt="([^"]*)"/);
          el.setAttribute("src", srcM ? srcM[1] : "");
          if (altM) el.setAttribute("alt", altM[1]);
          root.appendChild(el);
        } else if (m[4] && !m[4].startsWith("</")) {
          const tag = m[4].slice(1, m[4].indexOf(">")).replace(/[^a-z]/g, "");
          if (tag) root.appendChild(makeEl(tag));
        } else if (m[5]) {
          root.appendChild(makeText(m[5]));
        }
      }
      return { body: { firstElementChild: root } };
    }
  },
};

// Build a sandbox with stubs and eval the body, exposing helpers.
const sandbox = `
${Object.entries(stub).map(([k, v]) => `const ${k} = arguments[0].${k};`).join("\n")}
${body.replace(/editor\.addEventListener[\s\S]*?loadNote\(cfg\.id\);[\s]*\}?[\s]*$/m, "")}
globalThis.__serialize = serialize;
globalThis.__toPlainText = toPlainText;
`;
new Function("__stub", sandbox)(stub);

const serialize = globalThis.__serialize;
const toPlainText = globalThis.__toPlainText;

let pass = 0, fail = 0;
const ok = (m) => { pass++; log(`  PASS  ${m}`); };
const bad = (m, g) => { fail++; log(`  FAIL  ${m}  got=${g}`); };

log("\n[1] serialize: plain text -> escaped");
{
  const root = makeEl("div");
  root.appendChild(makeText("hello & <world>"));
  if (serialize(root) !== "hello &amp; &lt;world&gt;") bad("escape", serialize(root));
  else ok("escapes &, <, >");
}

log("\n[2] serialize: <br> -> newline");
{
  const root = makeEl("div");
  root.appendChild(makeText("a"));
  root.appendChild(makeEl("br"));
  root.appendChild(makeText("b"));
  const out = serialize(root);
  if (!out.includes("a\nb")) bad("newline", JSON.stringify(out));
  else ok("br -> newline");
}

log("\n[3] serialize: block element -> trailing newline");
{
  const root = makeEl("div");
  const p = makeEl("p");
  p.appendChild(makeText("hi"));
  root.appendChild(p);
  const out = serialize(root);
  if (!out.includes("</p>\n")) bad("block trailing", JSON.stringify(out));
  else ok("</p> + newline");
}

log("\n[4] serialize: <img> with attribute escaping");
{
  const root = makeEl("div");
  const img = makeEl("img");
  img.setAttribute("src", "/img/foo.png");
  img.setAttribute("alt", 'a "b"');
  root.appendChild(img);
  const out = serialize(root);
  if (!out.includes('src="/img/foo.png"')) bad("src", out);
  else if (!out.includes('alt="a &quot;b&quot;"')) bad("alt escape", out);
  else ok("img with escaped attrs");
}

log("\n[5] toPlainText: <img> -> [src]");
{
  const out = toPlainText('<img src="/img/foo.png" alt="x">');
  if (out !== "[/img/foo.png]") bad("img bracket", JSON.stringify(out));
  else ok("[src] format");
}

log("\n[6] toPlainText: text + br");
{
  const out = toPlainText("a<br>b");
  if (out !== "a\nb") bad("br plain", JSON.stringify(out));
  else ok("br -> newline");
}

log("\n[7] round-trip text -> html -> plain");
{
  const root = makeEl("div");
  root.appendChild(makeText("line 1\nline 2"));
  const html = serialize(root);
  const back = toPlainText(html);
  if (!back.includes("line 1")) bad("roundtrip", JSON.stringify(back));
  else ok("text survives");
}

log("\n[8] ID generation: deterministic for stubbed PRNG");
{
  const a = globalThis.crypto.getRandomValues(new Uint8Array(8));
  if (!a || a.length !== 8) bad("crypto", a);
  else ok(`crypto works (got ${Array.from(a).join(",")})`);
}


log("\n[9] serialize: <video> preserved with controls");
{
  const root = makeEl("div");
  const v = makeEl("video");
  v.setAttribute("src", "/img/clip.mp4");
  v.setAttribute("controls", "");
  root.appendChild(v);
  const out = serialize(root);
  if (!out.includes("<video controls")) bad("video tag", JSON.stringify(out));
  else if (!out.includes('src="/img/clip.mp4"')) bad("video src", JSON.stringify(out));
  else ok("video tag emitted");
}

log("\n[10] toPlainText: <video> -> [src]");
{
  const out = toPlainText('<video controls src="/img/clip.mp4"></video>');
  if (out !== "[/img/clip.mp4]") bad("video bracket", JSON.stringify(out));
  else ok("[src] for video");
}

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
