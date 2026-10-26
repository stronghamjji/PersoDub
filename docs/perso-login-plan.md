# Perso 로그인: 현재 상태와 할 일 (2026-10-26 기준)

이 파일은 내부 작업 메모입니다. 루트의 *.md는 .gitignore에 걸려서 docs/에 둡니다. 공개 저장소(stronghamjji/PersoDub)로 PR을 낼 때는 빼거나 위키로 옮기세요.

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

## 5. 금주 배포 순서

1. 오늘: 3번 메일 발송. 데모 클라이언트로 실제 로그인 확인 완료(2번). 소스에서 띄운 실제 Electron 앱으로도 로그인-로그아웃-재로그인 확인(아래 7번).
2. 키 경로 유지로 결정. 응답 모양은 코드에 반영 완료.
3. 등록 도착: clientId 한 줄 교체, `perso-login-check.mjs --client persodub-desktop ...`로 재확인.
4. 패키징된 Mac/Windows 빌드로 실제 로그인 각 1회. 브라우저가 127.0.0.1로 돌아오는지, Keychain 확인창, 로그아웃.
5. 버전 올리기(desktop/package.json), whats_new.json, docs/privacy.md에 로그인 항목, 공개 main의 README 커밋(cfebb8f) 반영, PR → CI → 릴리스.
6. 등록이 목요일까지 안 오면: production 빌드를 로그인 끈 상태(= 0.9.0 동작)로 내보내고 로그인은 다음 릴리스.

## 7. 실제 Electron 앱 E2E 결과 (2026-10-26, 데모 클라이언트)

소스에서 띄운 실제 앱 + 실제 Chrome + 실제 api.perso.ai. 사용자 kit은 건드리지 않도록 `PERSODUB_KIT_DIR`로 별도 kit을 주고, 소스 payload에서 설치부터 시켰습니다(설치 약 20초, 다운로드 캐시 덕).

| 확인한 것 | 결과 |
|---|---|
| 로그아웃 상태 첫 실행 | 로그인 벽, 뒤 화면 inert, 키 없음 |
| "Perso로 로그인" | Chrome 열림, 대기 화면, 돌아오면 앱 열림, 키 저장(35자) |
| 설정 > 계정과 키 | 탭 이름 바뀜, 마스킹 이메일, "키 연결됨", 키 붙여넣기 칸 숨김 |
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

## 6. 참고한 저장소와 사실 확인 기록

- stronghamjji/external-client-demo: Perso 인증 서버의 PKCE 흐름과 토큰 요청 본문, client_info 테이블 모양(redirect_uris가 문자열 목록, `http://localhost:5173/callback` 등록 사례).
- stronghamjji/vibi-adobe-plugin: 회사 BFF 서버 + device-code 방식. PersoDub엔 과함. 참고만.
- 실서버에 인증 없이 GET으로 확인(2026-10-26): profile, api-keys/active, sign-out, portal spaces → 401(존재), v2/token·v1 oauth2/token → GET에 405(존재), 지어낸 주소 → 404. authorize는 세션 없으면 client_id와 무관하게 perso.ai/login으로 302.
- 공개 저장소 main = 0.9.0 + README 이미지 커밋 하나. 로그인 코드는 공개된 적 없음.
