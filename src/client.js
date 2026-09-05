// Browser-side editor logic.
// IMPORTANT: this entire file is wrapped in a default-exported function so that
// importing it from a Worker context (Node/wrangler build) does NOT evaluate
// the browser globals (window/document/crypto). The worker extracts the
// function source via .toString() and serves it as a module.

export default function run() {
  const cfg = window.__NOTEPAD__;
  const editor = document.getElementById("editor");
  const statusEl = document.getElementById("status");
  const urlEl = document.getElementById("url");
  const copyBtn = document.getElementById("btn-copy");
  const zipBtn = document.getElementById("btn-zip");

  const ID_LEN = 8;
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

  function genId(len) {
    const a = new Uint8Array(len != null ? len : ID_LEN);
    crypto.getRandomValues(a);
    let out = "";
    for (let i = 0; i < a.length; i++) out += ALPHABET[a[i] % ALPHABET.length];
    return out;
  }

  function setStatus(text) { statusEl.textContent = text; }

  function showUrl(id) {
    urlEl.textContent = `${location.origin}/${id}`;
    history.replaceState(null, "", `/${id}`);
  }

  const BLOCK_TAGS = new Set([
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "tr", "section", "article",
  ]);
  function isBlock(tag) { return BLOCK_TAGS.has(tag); }

  function escapeText(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  }
  function escapeAttr(s) {
    return s.replace(/[&"]/g, (c) => ({ "&": "&amp;", '"': "&quot;" })[c]);
  }

  // editor DOM -> HTML string
  function serialize(root) {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(escapeText(node.nodeValue || ""));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") { parts.push("\n"); return; }
      if (tag === "img") {
        const src = el.getAttribute("src") || "";
        const alt = el.getAttribute("alt") || "";
        parts.push(`<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`);
        return;
      }
      if (tag === "video") {
        const src = el.getAttribute("src") || "";
        const poster = el.getAttribute("poster");
        parts.push(`<video controls src="${escapeAttr(src)}"${poster ? ` poster="${escapeAttr(poster)}"` : ""}></video>`);
        return;
      }
      parts.push(`<${tag}>`);
      el.childNodes.forEach(walk);
      parts.push(`</${tag}>`);
      if (isBlock(tag)) parts.push("\n");
    };
    root.childNodes.forEach(walk);
    return parts.join("").replace(/\n{3,}/g, "\n\n");
  }

  // editor HTML -> plain text with [url] for images
  function toPlainText(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    if (!root) return "";
    const out = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") { out.push("\n"); return; }
      if (tag === "img" || tag === "video") {
        out.push(`[${el.getAttribute("src") || ""}]`);
        return;
      }
      el.childNodes.forEach(walk);
      if (isBlock(tag)) out.push("\n");
    };
    root.childNodes.forEach(walk);
    return out.join("").replace(/\n{3,}/g, "\n\n");
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    return ok;
  }

  let currentId = cfg.id;
  let saveTimer = null;
  let inflight = null;
  let pendingFlush = false;

  function scheduleSave() {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, 300);
  }

  async function flushSave() {
    saveTimer = null;
    const html = serialize(editor);
    if (!currentId) {
      currentId = genId();
      showUrl(currentId);
    }
    if (inflight) inflight.abort();
    const ac = new AbortController();
    inflight = ac;
    setStatus("저장 중…");
    try {
      const res = await fetch(`/api/note/${currentId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      setStatus("저장됨");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setStatus("저장 실패");
      pendingFlush = true;
      setTimeout(() => { if (pendingFlush) { pendingFlush = false; flushSave(); } }, 1500);
    }
  }

  async function uploadFile(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "paste");
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`upload ${res.status}`);
    const { url } = await res.json();
    return url;
  }

  async function handleMediaPaste(file) {
    const isVideo = file.type.startsWith("video/");
    const placeholder = document.createElement(isVideo ? "video" : "img");
    placeholder.setAttribute("data-uploading", "1");
    placeholder.setAttribute(isVideo ? "preload" : "alt", file.name || (isVideo ? "pasted video" : "pasted image"));
    placeholder.src = URL.createObjectURL(file);
    insertAtCaret(placeholder);
    setStatus("업로드 중…");
    try {
      const url = await uploadFile(file);
      placeholder.removeAttribute("data-uploading");
      placeholder.src = url;
      scheduleSave();
      return placeholder;
    } catch {
      placeholder.setAttribute("data-failed", "1");
      setStatus("업로드 실패");
      return null;
    }
  }

  function insertAtCaret(node) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      editor.appendChild(node);
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function loadNote(id) {
    if (!id) return;
    setStatus("불러오는 중…");
    try {
      const res = await fetch(`/api/note/${id}`);
      if (res.status === 404) { setStatus("ready"); return; }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const { html } = await res.json();
      editor.innerHTML = html;
      setStatus("저장됨");
    } catch {
      setStatus("불러오기 실패");
    }
  }

  editor.addEventListener("input", () => {
    if (!currentId) {
      currentId = genId();
      showUrl(currentId);
    }
    scheduleSave();
  });

  editor.addEventListener("paste", (ev) => {
    const items = ev.clipboardData && ev.clipboardData.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file" && (it.type.startsWith("image/") || it.type.startsWith("video/"))) {
          ev.preventDefault();
          const file = it.getAsFile();
          if (file) handleMediaPaste(file);
          return;
        }
      }
    }
    const text = ev.clipboardData && ev.clipboardData.getData("text/plain");
    if (text != null) {
      ev.preventDefault();
      document.execCommand("insertText", false, text);
    }
  });

  copyBtn.addEventListener("click", async () => {
    const html = serialize(editor);
    const plain = toPlainText(html);
    const ok = await copyToClipboard(plain);
    setStatus(ok ? "복사됨 (이미지는 [url])" : "복사 실패");
    setTimeout(() => setStatus("저장됨"), 1500);
  });

  window.addEventListener("beforeunload", () => {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
      const html = serialize(editor);
      try {
        navigator.sendBeacon(
          `/api/note/${currentId}`,
          new Blob([JSON.stringify({ html })], { type: "application/json" }),
        );
      } catch {}
    }
  });

  zipBtn.addEventListener("click", async () => {
    // Make sure we have an id; if not, generate one and persist first.
    if (!currentId) {
      // flush any pending save first
      if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null; }
      await flushSave();
    }
    if (!currentId) {
      setStatus("저장 후 다운로드 가능");
      return;
    }
    setStatus("ZIP 만드는 중…");
    try {
      const res = await fetch(`/api/note/${currentId}/zip`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `notepad-${currentId}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setStatus(`ZIP 다운로드 (미디어 ${res.headers.get("x-note-media-count") || 0}개)`);
      setTimeout(() => setStatus("저장됨"), 2000);
    } catch {
      setStatus("ZIP 실패");
    }
  });

  if (cfg.id) showUrl(cfg.id);
  loadNote(cfg.id);
}
