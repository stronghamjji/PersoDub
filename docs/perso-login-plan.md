# Perso 로그인: 현재 상태와 할 일 (2026-10-26 밤 기준, 버전 1.0.0-rc.1)

이 파일은 내부 작업 메모입니다. 루트의 *.md는 .gitignore에 걸려서 docs/에 둡니다. 공개 저장소(stronghamjji/PersoDub)로 PR을 낼 때는 빼거나 위키로 옮기세요.

## 0. 남은 코드 변경은 딱 두 줄. 둘 다 외부 답을 기다리는 중

| # | 기다리는 것 | 누가 주나 | 바꿀 곳 | 바꾼 뒤 확인 |
|---|---|---|---|---|
| A | Perso OAuth client id | Perso 인증 팀 (perso-api-auth) | `desktop/src/auth.js` 38행 `clientId: env.PERSODUB_AUTH_CLIENT_ID \|\| "PERSODUB-CLIENT-ID-NOT-ISSUED-YET"` 의 문자열을 발급받은 id로. `desktop/src/auth.test.mjs`의 같은 문자열 한 줄도 | `node desktop/scripts/perso-login-check.mjs --client <id> --host 127.0.0.1 --port 52290` 가 1~7번 OK. 그다음 `tests/e2e/perso-login.mjs` |
| B | 운영 다운로드 폴더 주소(HTTPS) | 인프라 개발자 | `desktop/src/edition.js` 의 `PRODUCTION_UPDATE_URL = ""` 에 주소를. 끝에 `/` | `cd desktop && node --test src/edition.test.mjs src/updater.test.mjs`. 빌드 뒤 `desktop/dist/latest-mac.yml`의 파일 이름들이 그 폴더에 올라갔는지 |

둘 다 비어 있는 상태로도 앱은 돌아갑니다. A가 비면 운영 로그인이 Perso에서 거절되고(벽을 못 지나감), B가 비면 운영 앱이 공개 오픈소스 릴리스로 업데이트됩니다. **A 없이는 운영 rc를 내보내면 안 되고**, B 없이는 내보낼 수는 있지만 다음 오픈소스 릴리스 때 이름이 PersoDub으로 돌아갑니다.

### A에게 보낼 메시지 (Perso 인증 팀)

```
제목: PersoDubbing 데스크톱 앱 OAuth 클라이언트 등록 요청 (perso-api-auth client_info)

external-client-demo의 db/seed_demo_client.sql과 같은 형식으로 아래 한 줄 등록 부탁드립니다.
데모 클라이언트(demo-pkce-client)로는 이미 실제 로그인·키 조회·refresh·로그아웃까지 확인했고,
우리 id로 바꾸기만 하면 됩니다.

client_id           persodub-desktop
client_type         PUBLIC  (PKCE 사용, client_secret 검증 없음)
client_status       normal
redirect_uris       http://127.0.0.1:52290/callback
                    http://127.0.0.1:52291/callback
                    http://127.0.0.1:52292/callback
allowed_scopes      profile, email
allowed_grant_types authorization_code, refresh_token

확인 부탁드리는 것:
1. loopback 포트 와일드카드 지원 여부. 안 되면 위 고정 포트 3개로 갑니다.
2. refresh는 v1 auth/oauth2/token으로 보냅니다(v2/token은 refresh에 500). 이 경로가 유지되는지요.
3. 앱이 사용자 대신 API 키를 만들 수 있는 엔드포인트가 있는지(예: POST /auth/api/v1/api-keys). 있으면 키 없는 계정도 사이트 방문 없이 끝낼 수 있습니다.
4. 이 코드는 오픈소스 저장소에 공개됩니다. client id와 인증 엔드포인트 경로가 공개돼도 되는지 확인 부탁드립니다. (PKCE public client라 secret은 없습니다.)
```

### B에게 보낼 메시지 (인프라 개발자)

```
제목: PersoDubbing 데스크톱 앱 다운로드/업데이트 폴더 요청

필요한 것은 HTTPS로 누구나 읽을 수 있는 정적 폴더 주소 하나입니다. 예: https://<도메인>/persodubbing/desktop/
앱의 자동 업데이트(electron-updater generic provider)와 사람이 받는 다운로드 링크를 같은 폴더로 씁니다.

릴리스마다 올릴 파일(빌드하면 desktop/dist/에 함께 생깁니다):
  Mac:     PersoDubbing-<버전>-arm64-mac.zip, 같은 이름.blockmap, latest-mac.yml, PersoDubbing-mac.dmg
  Windows: PersoDubbing-Setup-<버전>.exe, 같은 이름.blockmap, latest.yml
  앱은 zip/exe로 업데이트하고, 사람은 dmg/exe를 받습니다.

조건:
  1. latest-mac.yml 과 latest.yml 은 캐시를 짧게(또는 no-cache). 이 둘이 "최신 버전이 뭔지"를 말해 줍니다.
  2. 버전이 들어간 파일 이름은 그대로 유지. yml이 그 이름을 가리킵니다. 링크용 버전 없는 이름이 필요하면 복사본을 하나 더.
  3. 인증 없이 읽기 가능.
  4. (있으면 좋음) HTTP Range 요청 지원: 바뀐 부분만 받습니다. 없어도 전체 다운로드로 동작합니다.

주소를 주시면 코드 한 줄(desktop/src/edition.js PRODUCTION_UPDATE_URL)에 넣고 테스트합니다.
```


## 1. 지금 브랜치 `feature/perso-login-loopback`에 들어 있는 것

0.9.0(커밋 5b08782)에서 새로 땄고, 기존 `feature/perso-login`에서 검증된 코드만 가져와 바꿨습니다.

- 브라우저 로그인 + PKCE + state. 토큰 교환은 Electron 메인 프로세스에서.
- **돌아오는 길은 loopback**: 앱이 `http://127.0.0.1:52290/callback`(바쁘면 52291, 52292)에 요청 하나만 받는 리스너를 열고, 끝나면 닫습니다. `desktop/src/authLoopback.js`, 51줄.
  - 삭제된 것: `persodub://` 스킴 등록, NSIS 설치 스크립트, package.json의 protocols, second-instance 링크 처리, open-url 처리, 계정 전환(prompt=login)과 "같은 계정" 다이얼로그.
- 토큰은 OS 키 저장소(safeStorage)로 암호화해 `perso-auth.bin`에 저장. 만료 1분 전 refresh. refresh 거절(4xx, 408/429 제외)이면 로그아웃.
- 로그인 뒤 `/auth/api/v1/api-keys/active`에서 키를 받아 kit.env `PERSO_API_KEY`에 저장. 백엔드는 바꾸지 않았습니다(여전히 `XP-API-KEY` 헤더).
- **로그인 켜는 기준은 kit.env에 기억된 에디션**(없으면 빌드 에디션). 자동 업데이트로 오픈소스 바이너리가 와도 production kit은 로그인이 유지됩니다. `desktop/src/authIpc.js` 한 줄.
- 키 없음 화면에 **로그아웃 버튼 추가**(기존엔 빠져나올 길이 없었음).
- 테스트: 단위 41, 플로우 18(가짜 Perso에 실제 HTTP, 실제 포트), UI 로그인 13+, 설정 3. 데스크톱 전체와 UI 전체 통과. 가짜 Perso는 실제 응답 모양 그대로 답합니다.

## 2. 실제 Perso로 확인된 것 (2026-10-26, 데모 클라이언트로 실제 로그인 1회)

`node desktop/scripts/perso-login-check.mjs`를 실제 Chrome과 실제 api.perso.ai로 돌린 결과입니다. 추측은 더 이상 없습니다.

| 항목 | 결과 |
|---|---|
| 데모 클라이언트 demo-pkce-client | 실서버에 등록돼 있음. redirect `http://localhost:5173/callback` |
| 실제 브라우저의 loopback 복귀 | 됨. code와 state 정상 |
| 토큰 교환 | OK. `{result: {accessToken, refreshToken}}`. JWT claims sub, scope, iat, exp. **수명 30분** |
| 프로필 | `{result: {userSeq, userName, email, provider, ...}}` |
| 활성 키 | `{result: [{seq, apiKey, apiKeyName, status, expireDate, lastUsedDate, createDate}]}`. **키는 전체 값**(35자) |
| 더빙 API에 Bearer 토큰 | portal spaces 엔드포인트는 200. 단 video-translator 엔드포인트는 미확인 |
| refresh | v2/token은 500. **v1 auth/oauth2/token이 됨**, `{result: {accessToken, refreshToken}}` |
| sign-out | 200 |

**결정: API 키 경로를 유지합니다.** 토큰 수명이 30분이라 백엔드가 토큰을 직접 쓰려면 셸이 30분마다 갱신해 백엔드에 넘기는 장치가 필요합니다. 키는 만료가 없어서 더 단순합니다. 코드의 응답 추측 표는 위 실제 모양으로 줄였습니다(parseProfile, parseActiveKey, tokensFrom).

다시 돌리는 법: 같은 명령. 우리 등록이 오면 `--client persodub-desktop --host 127.0.0.1 --port 52290`.

## 3. Perso 팀에 보낼 등록 요청 (이게 유일하게 우리 손 밖의 일)

```
제목: PersoDub 데스크톱 앱 OAuth 클라이언트 등록 요청 (perso-api-auth client_info)

external-client-demo의 db/seed_demo_client.sql과 같은 형식으로 아래 한 줄 등록 부탁드립니다.

client_id           persodub-desktop
client_type         PUBLIC  (PKCE 사용, client_secret 검증 없음)
client_status       normal
redirect_uris       http://127.0.0.1:52290/callback
                    http://127.0.0.1:52291/callback
                    http://127.0.0.1:52292/callback
allowed_scopes      profile, email
allowed_grant_types authorization_code, refresh_token

확인 부탁드리는 것:
1. loopback redirect의 포트 와일드카드 지원 여부. 안 되면 위 고정 포트 3개로 갑니다.
2. PUBLIC 클라이언트의 refresh 주소. v2/token은 refresh_token grant에 500을 줍니다. v1 auth/oauth2/token이 맞는지요.
3. video-translator API가 Authorization: Bearer <accessToken>을 받는지, 아니면 XP-API-KEY만 받는지.
4. /auth/api/v1/api-keys/active 가 키를 전체 값으로 주는지, 마스킹해서 주는지. (확인됨: 전체 값)
5. 앱이 사용자 대신 API 키를 만들 수 있는 엔드포인트가 있는지 (예: POST /auth/api/v1/api-keys).
```
등록이 오면 바꿀 곳: `desktop/src/auth.js`의 `clientId` 기본값 한 줄. 포트는 이미 52290~52292.

## 4. 운영(production)과 오픈소스를 같은 저장소에서 관리하는 방법

지금 구조가 이미 "저장소 하나, 바이너리 하나, 런타임 플래그 하나"입니다. 유지하고 두 가지만 더하면 됩니다.

| 항목 | 현재 | 할 일 |
|---|---|---|
| 에디션 결정 | payload의 EDITION 파일 → kit.env에 기억 | 그대로 |
| 더빙 기본값 | app/setup.py가 PERSODUB_EDITION 읽음 | 그대로 |
| 로그인 on/off | kit의 기억된 에디션 (이 브랜치) | 그대로 |
| **업데이트 피드** | 두 에디션 모두 공개 GitHub 릴리스(오픈소스 빌드) | production 전용 피드 추가: `desktop/src/edition.js`의 EDITIONS.production을 **릴리스만 올리는 공개 저장소**(예: stronghamjji/PersoDub-production, 소스 없음)로 바꾸거나, 회사 서버의 generic 피드(updater.js resolveFeed에 이미 generic 분기 있음)로. 비밀이 없는 코드라 공개 저장소여도 문제 없음. |
| 빌드 | Windows: Actions(에디션 입력 있음), Mac: 수동 | Windows 워크플로우에 production 릴리스 업로드 대상 추가, Mac은 `PERSODUB_EDITION=production`으로 한 번 더 빌드 |
| 문서 | 전부 키 붙여넣기 기준 | docs/에 production 전용 짧은 페이지 하나(로그인, 로그아웃, 키 없음 화면) |
| 비밀 | 없음 | client id는 공개돼도 되는 값(PKCE public client). 절대 client secret을 넣지 말 것 |

코드를 두 벌로 가르지 않습니다. 이유: 업데이트, 빌드, 서명, 문서, 테스트가 전부 두 배가 되고, 가를 만한 비밀이 없습니다.

## 5. 내일 배포 체크리스트 (1.0.0-rc.1)

브랜치 `feature/perso-login-loopback`, 2026-10-26 밤 기준 검증 상태: 자동 테스트 전부 통과(Python 2409, UI 1058, 데스크톱 612, relay 71, ruff), 실제 Electron 앱 + 실제 Chrome + 실제 Perso(데모 클라이언트)로 로그인·로그아웃·재로그인·재실행 통과, 오픈소스 에디션 별도 kit으로 정상.

1. **Perso 등록 도착** → `desktop/src/auth.js`의 `clientId` 기본값을 `persodub-desktop`으로, `desktop/src/auth.test.mjs`의 같은 문자열 한 줄도. 포트 52290~52292는 이미 기본값.
2. **라이브 확인** → `node desktop/scripts/perso-login-check.mjs --client persodub-desktop --host 127.0.0.1 --port 52290`. 1~7번이 모두 OK여야 함.
3. **실제 앱 확인** → `tests/e2e/perso-login.mjs` 머리말의 명령으로, 환경 변수는 `PERSODUB_AUTH_CLIENT_ID=persodub-desktop PERSODUB_AUTH_REDIRECT_HOST=127.0.0.1 PERSODUB_AUTH_REDIRECT_PORTS=52290`. 설치된 PersoDub.app은 먼저 종료.
4. **테스트 다시** → `cd desktop && node --test src/*.test.mjs smoke/*.test.mjs`, `node --test ui/src/*.test.mjs`, Python은 `pytest tests/`.
5. **빌드** → Mac: `cd desktop && CAMPPLUS_SRC=<campplus.onnx> npm run dist:dmg:prod` (서명·notarization은 기존 방식대로). Windows: Actions의 "Build Windows installer"를 edition=production으로 실행하면 `dist:win:prod`를 씀. 결과물 이름은 PersoDubbing-mac.dmg, PersoDubbing-Setup-<버전>.exe.
6. **설치본으로 마지막 확인** → Mac과 Windows 각 1회: Dock/시작 메뉴 이름 PersoDubbing, 로그인 벽, 로그인, 브라우저 페이지, 로그아웃, 재실행 유지. Windows는 loopback 포트에 방화벽 경고가 뜨지 않는지(127.0.0.1만 열므로 뜨지 않아야 함) 확인.
7. **배포** → 공개 저장소에 올린다면 `v1.0.0-rc.1` 태그의 GitHub 릴리스를 **pre-release로 표시**(0.9.0 사용자가 rc로 업데이트되지 않게). 프로덕션 rc는 회사 배포 경로로.
8. **등록이 안 오면** → 로그인 없이 내보내는 길: 오픈소스 에디션 빌드(`npm run dist:dmg`)는 로그인이 꺼져 있고 0.9.0과 같은 동작.

**아직 열려 있는 것**: 프로덕션 전용 업데이트 피드(4번 항목). 없으면 다음 자동 업데이트에서 공개 오픈소스 빌드를 받아 PersoDubbing 이름이 사라짐(로그인과 Perso 기본값은 kit.env에 기억돼 유지). **팀원 담당**(2026-10-26 결정). 코드에서 바꿀 곳은 `desktop/src/edition.js`의 EDITIONS.production 한 줄.

## 7. 실제 Electron 앱 E2E 결과 (2026-10-26, 데모 클라이언트)

소스에서 띄운 실제 앱 + 실제 Chrome + 실제 api.perso.ai. 사용자 kit은 건드리지 않도록 `PERSODUB_KIT_DIR`로 별도 kit을 주고, 소스 payload에서 설치부터 시켰습니다(설치 약 20초, 다운로드 캐시 덕).

| 확인한 것 | 결과 |
|---|---|
| 로그아웃 상태 첫 실행 | 로그인 벽, 뒤 화면 inert, 키 없음 |
| "Perso로 로그인" | Chrome 열림, 대기 화면, 돌아오면 앱 열림, 키 저장(35자) |
| 설정 > 계정과 키 | 탭 이름 바뀜, 계정 이메일 전체(2026-10-27), "키 연결됨", 키 붙여넣기 칸 숨김 |
| 홈 왼쪽 위 계정 줄 | 로그인 중엔 브랜드 아래에 계정 이메일 전체(2026-10-27)와 초록 점, 누르면 계정 탭, 로그아웃하면 사라짐 |
| 로그아웃 | 벽 복귀, kit.env 키 비움, 토큰 파일 삭제 |
| 재로그인 | 브라우저 세션 유지돼 0.15초, 키 재저장 |
| 앱 종료 후 재실행 | "signed in from the last run", 벽 없이 바로 앱(토큰은 Keychain 암호화 파일에서 복원) |
| 로그아웃 후 종료, 재실행 | 벽이 뜸. 토큰 파일 없음 |

재현: `tests/e2e/perso-login.mjs` 머리말의 명령 세 줄. 등록 뒤에는 환경 변수 세 개만 바꿉니다: `PERSODUB_AUTH_CLIENT_ID=persodub-desktop PERSODUB_AUTH_REDIRECT_HOST=127.0.0.1 PERSODUB_AUTH_REDIRECT_PORTS=52290`. 패키징 빌드에서는 코드의 기본값이 그 값이라 바꿀 것이 clientId 한 줄뿐입니다.

주의: 설치된 PersoDub.app과 소스 실행 앱은 단일 인스턴스 잠금을 공유해 동시에 못 띄웁니다. 테스트 전 설치된 앱을 종료하세요.

**아직 실제로 안 해본 것**: 키 없는 계정(가짜 Perso 테스트로만), Windows, 패키징(dmg/exe)된 빌드, 우리 client id. 등록이 오면 마지막 둘을 합니다.

**문구**: 한국어 "작업공간"은 전부 "Workspace"로 바꿨습니다(사용자 결정 2026-10-26).

**키 없는 계정의 흐름(사용자 요청 2026-10-26)**: 로그인했는데 키가 없으면 키 만들기 페이지가 브라우저에 바로 열리고, 키 없음 화면이 떠 있는 동안 5초마다 키를 다시 확인해서 키가 생기면 알아서 앱으로 넘어갑니다. "키 만들기"와 "다시 확인" 버튼은 그대로 있습니다. Perso에 물어볼 것 하나 추가: 앱이 API로 키를 직접 만들 수 있는 엔드포인트가 있는지. 있으면 사이트 방문 없이 끝낼 수 있습니다.

**설정 탭 순서(사용자 요청 2026-10-26)**: API 키(프로덕션에서는 "계정과 키")가 첫 탭이고 설정은 그 탭으로 열립니다. 모델에 주의가 필요할 때만 모델 탭으로 엽니다.

## 8. 행동 로그와 계정 기준 대시보드: Amplitude 담당자에게 넘길 것 (2026-10-26)

로그 파이프라인은 팀원이 Cloudflare에서 Amplitude로 옮기는 중이므로 여기서는 만들지 않습니다. 로그인 쪽에서 준비해 둔 것과 지켜야 할 것만 적습니다.

- **계정 번호는 로그인 상태에 들어 있습니다.** 페이지에서 `window.persodubShell.authStatus()`가 돌려주는 객체의 `accountId`가 Perso의 userSeq(숫자 문자열)입니다. 로그인 상태가 바뀔 때마다 `window.persodubShell.onAuthState(cb)`로 같은 객체가 옵니다. 분석 도구에는 번호를 그대로 쓰지 않고, 셸이 버튼 기록에 넣는 해시(`desktop/src/events.js` eventsUserId: `persodub:` + 번호의 sha256 앞 32자)를 씁니다(2026-10-25 결정). 이메일은 쓰지 않습니다. 오픈소스 에디션에서는 `enabled: false`이고 `accountId`는 빈 문자열입니다.
- **끄기 스위치를 지켜야 합니다.** 설정 > 개인정보의 "익명 사용 집계" 스위치와 kit.env의 `PERSODUB_NO_ANALYTICS=1`. 페이지에서는 `GET /api/settings`의 `analytics_off`로 읽을 수 있습니다. 꺼져 있으면 이벤트를 보내지 않습니다.
- **보내면 안 되는 것.** 입력한 글, 파일 이름, 링크, 프로젝트 이름, 이메일, API 키, 토큰. 보내도 되는 것은 눌린 버튼의 id, 화면 이름(`document.body.dataset.screen`), 열린 다이얼로그 id, 드롭다운에서 고른 값 정도입니다.
- **문서.** 이벤트를 보내기 시작하면 설정의 스위치 설명 문구와 `docs/privacy.md`에 "어떤 버튼과 화면을 쓰는지, 로그인한 계정 번호와 함께"가 들어가야 합니다.
- **비공개로만.** 실패 리포트는 공개 GitHub 이슈로 가므로 계정 번호를 거기에 넣으면 안 됩니다. 계정 번호는 Amplitude와 비공개 대시보드에만.

## 9. 앱 이름: 프로덕션은 PersoDubbing (2026-10-26)

정식 출시 이름이 "PersoDubbing DesktopApp"이라 사용자가 보는 곳만 프로덕션 에디션에서 "PersoDubbing"으로 바꿨습니다. "DesktopApp"은 붙이지 않습니다. 오픈소스는 "PersoDub" 그대로입니다.

| 바뀌는 곳 | 어떻게 |
|---|---|
| 창 제목, 로그인 화면의 이름, 부팅 화면 제목, 로그인 뒤 브라우저 페이지 | 셸이 `desktop/src/edition.js`의 DISPLAY_NAMES를 페이지에 넘김 |
| 앱 번들 이름, Dock, 메뉴 막대, Windows 시작 메뉴, 설치 파일명 | 프로덕션 빌드 명령 `npm run dist:dmg:prod`, `dist:win:prod` 가 productName을 PersoDubbing으로 덮어씀. Windows 워크플로우는 production 선택 시 자동 |
| 문장 속의 이름 | 페이지, 셸, 백엔드의 문장 전부 `{app}` 자리표시자. 페이지는 셸이 넘긴 이름으로, 셸은 `setAppName`으로, 백엔드는 `PERSODUB_APP_NAME` 환경 변수로 채움(빅테크 방식: Chromium/Chrome, Code-OSS/VS Code). 영어 문장은 엔진이 이름을 채워 보내므로 페이지는 이름을 `{app}`으로 되돌려 번역 표를 찾음 |
| 안 바뀌는 곳 | appId(com.persodub.desktop), kit 폴더 `Application Support/PersoDub`(모델과 프로젝트), Perso에 보내는 User-Agent, 실패 리포트 제목, "PersoDub on GitHub" 링크(오픈소스 프로젝트 이름), 프로토콜 문장 "PersoDub installs this itself." |

주의 둘. (1) productName이 바뀌면 Electron의 데이터 폴더가 `Application Support/PersoDubbing`으로 새로 생깁니다. 로그와 분석용 기기 id가 새로 시작하고, kit의 모델과 프로젝트는 그대로입니다. (2) `PRODUCTION_UPDATE_URL`이 비어 있는 동안은 자동 업데이트가 공개 오픈소스 빌드를 받아 이름이 PersoDub으로 돌아갑니다. 0번 항목 B.

## 10. 결제(크레딧 충전) 유도: 다음 작업 (2026-10-27 결정)

**지금 코드에 있는 것(코드로 확인):** 백엔드가 Perso 크레딧 소진을 감지하면 `perso_credit_exhausted` 이벤트를 보내고, 페이지는 작업당 한 번 "크레딧이 부족해요" 팝업(`#creditOverlay`)을 띄웁니다. 팝업의 "충전" 버튼은 `https://perso.ai/pricing`을 브라우저로 엽니다. 작업은 실패로 끝나고 사용자가 다시 시작해야 합니다.

**2026-10-27 구현됨(최소 변경):** (1) 더빙 준비 화면의 비용 줄 옆에 "크레딧 충전…" 링크. 남은 크레딧이 0이거나 가격보다 적을 때만 보임(`ui/src/draftSetup.mjs` creditsShort). (2) 설정 > 계정과 키의 Workspace 아래 "크레딧 충전…" 링크 상시. 두 링크 모두 백엔드의 `perso_recharge_link`(UTM 붙은 `https://perso.ai/en/workspace/space-settings?tab=Subscription`)를 씀. 소진 팝업과 실패 줄의 "충전"은 원래 있던 것. 실제 앱으로 설정 링크 확인, 비용 줄은 단위 테스트로 확인(남은 크레딧은 Workspace가 골라져 있어야 보임).

**남은 것, 우선순위 순:**
2. **소진 팝업**: "충전하기"를 주 버튼으로, 충전 뒤 같은 자리에서 **"다시 시도"**로 바로 이어지게. 실패 카드에도 "충전하기 · 다시 시도" 두 버튼.
3. **홈 계정 줄**에 남은 크레딧 표시(설정 쪽은 됨).
4. 피할 것: 상시 메뉴의 "결제", 로그인 직후의 결제 안내, 작업을 막는 모달.

**Perso 웹 팀에 물을 것:** workspace 번호로 바로 가는 충전 페이지 주소가 있는지(예: `https://perso.ai/workspace/<seq>/billing`). 없으면 가격 페이지로 보냄. 브라우저는 이미 Perso에 로그인돼 있음.

**측정:** Amplitude가 붙으면 세 자리의 "충전하기" 누름을 자리별로 기록해 어디가 결제로 이어지는지 봄.

## 6. 참고한 저장소와 사실 확인 기록

- stronghamjji/external-client-demo: Perso 인증 서버의 PKCE 흐름과 토큰 요청 본문, client_info 테이블 모양(redirect_uris가 문자열 목록, `http://localhost:5173/callback` 등록 사례).
- stronghamjji/vibi-adobe-plugin: 회사 BFF 서버 + device-code 방식. PersoDub엔 과함. 참고만.
- 실서버에 인증 없이 GET으로 확인(2026-10-26): profile, api-keys/active, sign-out, portal spaces → 401(존재), v2/token·v1 oauth2/token → GET에 405(존재), 지어낸 주소 → 404. authorize는 세션 없으면 client_id와 무관하게 perso.ai/login으로 302.
- 공개 저장소 main = 0.9.0 + README 이미지 커밋 하나. 로그인 코드는 공개된 적 없음.
