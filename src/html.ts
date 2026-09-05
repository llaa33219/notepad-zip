// HTML shell embedded into the worker.

type Vars = {
  id: string;
  origin: string;
};

export function htmlShell({ id, origin }: Vars): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>notepad-zip</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", sans-serif;
    background: #f4f4f6;
    color: #111;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0b; color: #e6e6e6; }
    .shell { background: #161618; border-color: #26262a; }
    .editor { background: #161618; }
    .editor img, .editor video { box-shadow: 0 0 0 1px #26262a; }
    .toolbar { border-color: #26262a; }
    .toolbar button { background: #1d1d20; border-color: #2a2a2e; }
    .toolbar button:hover { background: #26262a; }
  }
  .shell {
    flex: 1;
    width: 100%;
    max-width: 800px;
    background: #fff;
    border: 1px solid #e5e5ea;
    border-radius: 10px;
    margin: 16px 16px 32px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 8px 24px rgba(0,0,0,0.04);
  }
  .toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: inherit;
    border-bottom: 1px solid #eaeaea;
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
    flex: 1; outline: none; padding: 20px 24px 32px;
    font-size: 15px; line-height: 1.6;
    white-space: pre-wrap; word-wrap: break-word;
    caret-color: currentColor;
    min-height: 60vh;
  }
  .editor:empty::before {
    content: attr(data-placeholder);
    color: #aaa; pointer-events: none;
  }
  .editor img {
    display: inline-block;
    width: auto; height: auto;
    max-width: 400px; max-height: 400px;
    border-radius: 6px; box-shadow: 0 0 0 1px #eee;
    vertical-align: middle;
  }
  .editor video {
    display: block; max-width: 400px; max-height: 60vh;
    border-radius: 6px; box-shadow: 0 0 0 1px #eee;
    margin: 8px 0;
  }
  .editor img[data-uploading="1"],
  .editor video[data-uploading="1"] { opacity: 0.35; }
  .editor img[data-failed="1"],
  .editor video[data-failed="1"]    { outline: 2px solid #c33; }
</style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <button id="btn-copy" type="button">Copy</button>
      <button id="btn-zip" type="button">Copy ZIP link</button>
      <span class="status" id="status">ready</span>
      <span class="spacer"></span>
      <span class="status" id="url"></span>
    </div>
    <div
      id="editor"
      class="editor"
      contenteditable="true"
      spellcheck="false"
      data-placeholder="Type something&hellip;"
    ></div>
  </div>
  <script>
    window.__NOTEPAD__ = ${JSON.stringify({ id, origin })};
  </script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}
