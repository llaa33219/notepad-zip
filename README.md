# notepad-zip

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Cloudflare Workers에서 동작하는 가벼운 메모장. 텍스트는 **Workers KV**, 이미지는 **R2**에 저장됩니다.

## 동작

- 페이지를 열면 빈 노트가 보이고, 무엇이든 입력하면 **300 ms 디바운스**로 자동 저장됩니다.
- 첫 입력이 들어오면 클라이언트에서 **8자 base36 ID**를 생성하고 `history.replaceState`으로 URL이 `/{id}`로 바뀝니다 (페이지 새로고침 없음).
- 이미지를 복사해서 에디터에 붙여넣으면 즉시 R2로 업로드되고 `<img>`로 교체됩니다. 영상도 동일하게 동작하며 `<video controls>`로 표시됩니다. SVG도 지원. 업로드 중에는 반투명 placeholder가 보입니다.
- **복사** 버튼을 누르면 클립보드에 plain text가 들어가고, 이미지와 영상 모두 `[https://…/img/img_xxxx.png]` 형태로 직렬화됩니다. 블록 요소 끝에는 줄바꿈이 붙습니다.
- **ZIP** 버튼을 누르면 `note.txt` + 첨부된 모든 media 파일이 들어있는 `notepad-{id}.zip`이 다운로드됩니다. 미디어 URL을 추출해 R2에서 직접 읽어와 묶습니다.
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

1. Cloudflare에 로그인 (최초 1회)
   ```bash
   npx wrangler login
   ```
2. KV 네임스페이스 생성
   ```bash
   npx wrangler kv namespace create NOTES
   npx wrangler kv namespace create NOTES --preview   # dev용 (선택)
   ```
   출력되는 `id`를 `wrangler.jsonc`의 `kv_namespaces[0].id`에 붙여넣습니다.

3. R2 버킷 생성
   ```bash
   npx wrangler r2 bucket create notepad-images
   ```
   `wrangler.jsonc`의 `r2_buckets[0].bucket_name`이 `notepad-images`인지 확인합니다.

4. (선택) `vars.PUBLIC_ORIGIN`을 실제 도메인으로 변경. 비워 두면 worker가 `request.url`을 사용합니다.

5. 배포
   ```bash
   npm run deploy
   ```
   출력되는 `*.workers.dev` URL이 서비스 주소입니다. 커스텀 도메인을 붙이려면 Cloudflare 대시보드에서 라우트를 추가하면 됩니다.

## 설계 메모

- **client.js는 worker에 임베드됩니다.** 브라우저용 코드를 `export default function run(){ … }`로 감싸 top-level에서 `window`/`document`를 참조하지 않게 했고, worker가 `run.toString()` + `run();` 으로 IIFE 형태의 ES module을 만들어 `/client.js`에 서빙합니다. 빌드 단계에서 브라우저 코드가 평가되지 않으므로 안전합니다.
- **media 키**: `img_<16-char base64url>.<ext>` (png/jpg/gif/webp/avif/svg/mp4/webm/mov/ogv). 클라이언트는 키를 알 필요 없이 업로드 응답으로 받은 절대 URL을 `<img src>` / `<video src>`에 넣습니다.
- **ZIP writer**: 외부 의존성 0. PKZIP STORE 방식. PNG/JPEG/MP4 등은 이미 압축되어 있어 STORE로 묶어도 크기 손해가 없고, 텍스트는 작아서 DEFLATE 없이도 충분합니다. CRC32는 표준 테이블로 직접 계산, `unzip -p`로 round-trip 검증됨.
- **저장 크기 제한**: 노트 256 KiB, 이미지 10 MiB. 둘 다 worker에서 거부합니다.
- **KV 메타데이터**: `updatedAt` / `bytes`를 기록하지만 클라이언트에서 쓰지 않습니다. 향후 ETag 캐싱에 사용 가능.
- **단일 파일 worker**: assets binding이나 별도 정적 호스팅 없이 한 워커가 모든 라우트를 처리합니다.
