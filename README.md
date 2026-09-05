# notepad-zip

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A minimal notepad running on Cloudflare Workers. Text in **Workers KV**, media (images, video, SVG) in **R2**.

## 동작

- 페이지를 열면 빈 노트가 보이고, 무엇이든 입력하면 **300 ms 디바운스**로 자동 저장됩니다.
- 첫 입력이 들어오면 클라이언트에서 **8자 base36 ID**를 생성하고 `history.replaceState`으로 URL이 `/{id}`로 바뀝니다 (페이지 새로고침 없음).
- Paste any image / video / SVG and it uploads to R2 immediately, replaced inline with `<img>` (max 400px wide) or `<video controls>`. A semi-transparent placeholder shows during upload.
- **Copy** button: plain text to clipboard. Images and videos both serialize as `[https://…/img/img_xxx.png]`. Block elements get trailing newlines.
- **Copy ZIP link** button: copies `https://<host>/api/note/{id}/zip` to clipboard. Paste it anywhere to download `note-{id}.zip` containing `note.txt` plus every referenced media file. Inside the archive, `note.txt` references images as `[files/img_xxx.png]` so the relative paths resolve to actual files when the archive is unpacked.
- **New** button: opens a fresh tab at the root URL. The current tab is left intact, so accidental clicks cost nothing.
- Notes up to **8 MiB** (UTF-8 bytes) are accepted — well under the 25 MiB KV value cap.
- 같은 URL을 다시 열면 저장된 HTML이 그대로 복원됩니다.

## 라우트

| Method | Path             | 동작                              |
|--------|------------------|-----------------------------------|
| GET    | `/`              | 빈 에디터 HTML                    |
| GET    | `/{id}`          | 저장된 노트를 미리 로드한 HTML    |
| GET    | `/client.js`     | 브라우저용 ES module              |
| GET    | `/img/{key}`     | R2 이미지 서빙                    |
| POST   | `/api/upload`    | `multipart/form-data`로 media 업로드 (image/*, video/*, svg) → `{ url, key }` |
| GET    | `/api/note/{id}/zip` | 노트 + 첨부 media를 ZIP으로 다운로드 (`notepad-{id}.zip`) |
| GET    | `/api/note/{id}` | 노트 HTML 조회 (없으면 404)       |
| PUT    | `/api/note/{id}` | `{ html }` 저장                  |

## 로컬 실행

```bash
npm install
npm run dev      # http://localhost:8787
npm test         # 빌드 dry-run + 워커 라우팅 18개 + 클라 로직 8개
npm run typecheck
```

## 배포

### 1. Cloudflare 로그인 (최초 1회)

```bash
npx wrangler login
```

### 2. KV / R2 리소스 생성

```bash
npx wrangler kv namespace create NOTES
npx wrangler r2 bucket create notepad-images
npx wrangler r2 bucket create notepad-images-preview   # wrangler dev 용
```

`wrangler kv namespace create NOTES`가 출력하는 `id`를 `wrangler.jsonc`의 `kv_namespaces[0].id`에 붙여넣습니다. R2 버킷 이름은 기본값(`notepad-images`, `notepad-images-preview`) 그대로 두면 됩니다.

### 3. `vars.PUBLIC_ORIGIN` 확인

기본값은 `https://notepad.blp.sh` (이 repo의 실제 도메인)입니다. 다른 도메인으로 배포한다면 `wrangler.jsonc`의 `vars.PUBLIC_ORIGIN`을 그 주소로 바꾸세요. 비워 두면 worker가 `request.url`을 그대로 사용합니다.

### 4. 배포

```bash
npm run deploy
```

이 명령이 끝나면 KV / R2 바인딩이 worker 코드에 같이 묶여서 올라갑니다 — 대시보드에서 따로 binding 추가할 필요 없습니다.

`*.workers.dev` URL이 서비스 주소입니다. 커스텀 도메인을 붙이려면 Cloudflare 대시보드에서 **Workers & Pages → notepad-zip → Triggers → Add route**로 추가하면 됩니다.

> **왜 binding을 다시 inline으로 뒀나** — 처음엔 KV namespace ID가 git에 노출되지 않게 대시보드 binding만 쓰도록 했었는데, 그러면 binding 추가 *후에* `npm run deploy`를 한 번 더 돌려야 worker에 반영됩니다. 그 단계를 깜빡하면 PUT이 500으로 죽습니다. 본인만 쓰는 1인용 메모장이라 보안 이득이 크지 않고, inline으로 두는 편이 *deploy 한 번이면 끝*이라 운영이 단순해집니다. 공유 도메인 / 다수 협업자가 노트 내용을 보면 안 되는 상황이면 다시 dashboard-only로 빼는 게 맞습니다.

## 설계 메모

- **client.js는 worker에 임베드됩니다.** 브라우저용 코드를 `export default function run(){ … }`로 감싸 top-level에서 `window`/`document`를 참조하지 않게 했고, worker가 `run.toString()` + `run();` 으로 IIFE 형태의 ES module을 만들어 `/client.js`에 서빙합니다. 빌드 단계에서 브라우저 코드가 평가되지 않으므로 안전합니다.
- **media 키**: `img_<16-char base64url>.<ext>` (png/jpg/gif/webp/avif/svg/mp4/webm/mov/ogv). 클라이언트는 키를 알 필요 없이 업로드 응답으로 받은 절대 URL을 `<img src>` / `<video src>`에 넣습니다.
- **ZIP writer**: 외부 의존성 0. PKZIP STORE 방식. PNG/JPEG/MP4 등은 이미 압축되어 있어 STORE로 묶어도 크기 손해가 없고, 텍스트는 작아서 DEFLATE 없이도 충분합니다. CRC32는 표준 테이블로 직접 계산, `unzip -p`로 round-trip 검증됨.
- **저장 크기 제한**: 노트 256 KiB, 이미지 10 MiB. 둘 다 worker에서 거부합니다.
- **KV 메타데이터**: `updatedAt` / `bytes`를 기록하지만 클라이언트에서 쓰지 않습니다. 향후 ETag 캐싱에 사용 가능.
- **단일 파일 worker**: assets binding이나 별도 정적 호스팅 없이 한 워커가 모든 라우트를 처리합니다.
