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
- 테스트: 단위 42, 플로우 18(가짜 Perso에 실제 HTTP, 실제 포트), UI 로그인 13+, 설정 3. 데스크톱 전체 610, UI 전체 1055 통과.

## 2. 아직 추측인 것 — 실제 Perso로 한 번만 확인하면 끝

코드가 "후보 이름을 순서대로 찔러보는" 곳이 세 군데 있습니다. 실제 응답을 한 번 보면 몇 줄로 줄입니다.
- 프로필 응답 필드(userId/user_id/id/..., email, name/nickname/...)
- 활성 키 응답 모양(리스트인지, 키 필드 이름, **키가 전체 값인지 마스킹인지**) ← 마스킹이면 설계 변경 필요
- refresh 엔드포인트(v2/token은 refresh grant에 500이라는 기록만 있음, v1 oauth2/token으로 보냄)

확인 방법, Electron 없이 1분:
```
node desktop/scripts/perso-login-check.mjs                 # 데모 클라이언트(demo-pkce-client, localhost:5173)
node desktop/scripts/perso-login-check.mjs --client persodub-desktop --host 127.0.0.1 --port 52290   # 우리 등록 뒤
```
브라우저가 열리고 Perso에 로그인하면 1~7번 항목으로 결과를 찍습니다. 토큰·키·이메일 값은 절대 출력하지 않습니다.
- 데모 클라이언트가 실서버에 아직 등록돼 있는지는 **미확인**입니다. 세션 없이는 authorize가 무조건 로그인 페이지로 302라서 알 수 없고, 이 스크립트를 한 번 돌리면 바로 압니다(돌아오지 않으면 미등록).
- 5번 항목이 200이면 더빙 API가 Bearer 토큰을 받는 것 → 키 단계(connectKey, parseActiveKey, kit.env 쓰기)를 통째로 지우고 백엔드가 토큰을 쓰게 바꿀 수 있습니다.

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
4. /auth/api/v1/api-keys/active 가 키를 전체 값으로 주는지, 마스킹해서 주는지.
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

1. 오늘: 3번 메일 발송. `perso-login-check.mjs`를 데모 클라이언트로 한 번 실행해 2번 항목 확인.
2. 결과에 따라: Bearer 되면 키 단계 삭제(반나절), 안 되면 현 구조 유지하고 응답 모양만 코드에 반영(한 시간).
3. 등록 도착: clientId 한 줄 교체, `perso-login-check.mjs --client persodub-desktop ...`로 재확인.
4. 패키징된 Mac/Windows 빌드로 실제 로그인 각 1회. 브라우저가 127.0.0.1로 돌아오는지, Keychain 확인창, 로그아웃.
5. 버전 올리기(desktop/package.json), whats_new.json, docs/privacy.md에 로그인 항목, 공개 main의 README 커밋(cfebb8f) 반영, PR → CI → 릴리스.
6. 등록이 목요일까지 안 오면: production 빌드를 로그인 끈 상태(= 0.9.0 동작)로 내보내고 로그인은 다음 릴리스.

## 6. 참고한 저장소와 사실 확인 기록

- stronghamjji/external-client-demo: Perso 인증 서버의 PKCE 흐름과 토큰 요청 본문, client_info 테이블 모양(redirect_uris가 문자열 목록, `http://localhost:5173/callback` 등록 사례).
- stronghamjji/vibi-adobe-plugin: 회사 BFF 서버 + device-code 방식. PersoDub엔 과함. 참고만.
- 실서버에 인증 없이 GET으로 확인(2026-10-26): profile, api-keys/active, sign-out, portal spaces → 401(존재), v2/token·v1 oauth2/token → GET에 405(존재), 지어낸 주소 → 404. authorize는 세션 없으면 client_id와 무관하게 perso.ai/login으로 302.
- 공개 저장소 main = 0.9.0 + README 이미지 커밋 하나. 로그인 코드는 공개된 적 없음.
