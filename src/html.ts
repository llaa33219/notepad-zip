// HTML shell embedded into the worker. Kept as a tagged-template function so we
// can do cheap per-request substitutions (e.g. note id, public origin).

type Vars = {
  id: string;
  origin: string;
};

export function htmlShell({ id, origin }: Vars): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>notepad-zip</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
    background: #fff;
    color: #111;
    display: flex;
    flex-direction: column;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0b0c; color: #e6e6e6; }
    .toolbar { border-color: #2a2a2d; }
    .editor img { box-shadow: 0 0 0 1px #2a2a2d; }
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    background: inherit;
    border-bottom: 1px solid #eee;
    font-size: 13px;
  }
  .toolbar .status { color: #888; font-variant-numeric: tabular-nums; }
  .toolbar button {
    appearance: none; border: 1px solid #ddd; background: #fafafa;
    color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 13px;
  }
  .toolbar button:hover { background: #f0f0f0; }
  .toolbar .spacer { flex: 1; }
  .editor {
    flex: 1; outline: none; padding: 24px;
    font-size: 15px; line-height: 1.6;
    white-space: pre-wrap; word-wrap: break-word;
    caret-color: currentColor;
  }
  .editor:empty::before {
    content: attr(data-placeholder);
    color: #aaa; pointer-events: none;
  }
  .editor img {
    display: inline-block; max-width: 100%; height: auto;
    border-radius: 6px; box-shadow: 0 0 0 1px #eee;
    vertical-align: middle;
  }
  .editor video {
    display: block; max-width: 100%; max-height: 60vh;
    border-radius: 6px; box-shadow: 0 0 0 1px #eee;
    margin: 8px 0;
  }
  .editor video[data-uploading="1"] { opacity: 0.35; }
  .editor video[data-failed="1"]   { outline: 2px solid #c33; }
  .editor img[data-uploading="1"] { opacity: 0.35; }
  .editor img[data-failed="1"]   { outline: 2px solid #c33; }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="btn-copy" type="button">복사</button>
    <button id="btn-zip" type="button">ZIP</button>
    <span class="status" id="status">ready</span>
    <span class="spacer"></span>
    <span class="status" id="url"></span>
  </div>
  <div
    id="editor"
    class="editor"
    contenteditable="true"
    spellcheck="false"
    data-placeholder="메모를 적어보세요…"
  ></div>
  <script>
    window.__NOTEPAD__ = ${JSON.stringify({ id, origin })};
  </script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}
