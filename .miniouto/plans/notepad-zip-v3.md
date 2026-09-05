# v3: ZIP as link, layout, English UI, image PUT 500 fix

## Tasks
1. ZIP button → copy download link to clipboard (instead of streaming the blob).
2. Editor container: max-width 800px, centered. Body background slightly
   darker so the editor area stands out.
3. All UI strings English.
4. Image upload 500: likely cause is env.IMAGES.put failing when object body
   is FormData file. Need to handle the arrayBuffer correctly and surface a
   useful 400/500 message. Reproduce live, then fix root cause.
5. Images render at max-width: 400px.

## Decisions
- ZIP link: client builds `${origin}/api/note/${id}/zip` and writes it to the
  clipboard. User can paste it anywhere. Status shows "ZIP link copied".
- Layout: wrapper `.editor-wrap` with `max-width: 800px; margin: 0 auto;`
  and `background: #fff` (light) / `#161618` (dark). Body gets a slightly
  tinted bg (#f4f4f6 / #0a0a0b).
- English strings: button labels, status text, placeholders.
- Image upload: handle file.arrayBuffer() returns null in some FormData
  impls; switch to `await file.arrayBuffer()` (already there) and ensure
  the error path doesn't swallow a useful 400. Add a smoke case that
  uses the worker fetch path to surface the failure.
  Actually — the live failure has no body shown. The 500 means worker
  threw. Common cause: `await req.formData()` in modern Workers requires
  `nodejs_compat` (we have it) but also the body must be a multipart
  payload. If client sends wrong content-type, formData throws. Add try
  around formData() and return a 400 instead of 500.
- Image width: `.editor img { max-width: 400px; }`. Same for `video`.

## Target files
- src/client.js — UI strings, ZIP button handler.
- src/html.ts — wrapper markup, CSS, English labels.
- src/index.ts — robust /api/upload error handling; surface "missing file"
  as 400.
- scripts/smoke.mjs — test for graceful upload error.

## Verification
- npm run typecheck
- npm run build
- npm test (45+)
- Manual: describe what to check after deploy
