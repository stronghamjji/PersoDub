# PersoDubbing 1.0.0-rc.1 변경 요약 (팀원 확인용, 2026-10-27)

내부 메모: 공개 PR 전에 docs/perso-login-plan.md와 함께 삭제.
브랜치 feature/perso-login-loopback, 기준 0.9.0. 큰 것부터.

## 1. Perso 로그인 (운영 에디션만)
- 앱이 기본 브라우저로 Perso 로그인 페이지를 엽니다(OAuth 2.0 + PKCE). 끝나면 http://127.0.0.1:52290/callback 으로 돌아와 앱이 토큰을 받습니다. 비밀번호는 앱을 거치지 않고, OS에 URL 스킴 등록 같은 것도 없습니다.
- 토큰은 Electron safeStorage(Mac Keychain / Windows DPAPI)로 암호화해 userData에 보관. 30분짜리 액세스 토큰은 refresh 토큰으로 자동 갱신. 앱을 다시 켜도 로그인이 유지됩니다.
- 로그인 뒤 계정의 활성 API 키를 받아 kit.env에 씁니다. 더빙 백엔드는 전과 같이 키로만 동작하므로 로그인 때문에 바뀐 Python 코드는 없습니다.
- 화면: 로그인 전엔 전체 창을 덮는 로그인 화면. 키 없는 계정은 키 만들기 페이지가 자동으로 열리고, 키가 생기면(창 복귀 시와 10초마다 확인) 알아서 들어갑니다. 홈 상단에 계정 이메일 전체(이메일이 없는 계정은 이름), 설정 > Account and keys 탭에 계정과 로그아웃. 로그·실패 리포트·버튼 기록에는 이메일이 나가지 않습니다(2026-10-27 결정).
- 오픈소스 에디션은 전부 꺼져 있고 0.9.0과 같습니다.
- 미완 1건: Perso 인증 팀이 발급할 client id. desktop/src/auth.js 의 placeholder 한 줄(+ 테스트 한 줄). 그 전엔 운영 로그인을 Perso가 거절합니다. Perso의 데모 클라이언트로는 실제 로그인·키 수신·refresh·로그아웃·재실행을 실제 앱(Electron + Chrome + 실제 Perso 서버)으로 확인했습니다.

## 2. 운영 에디션 이름 PersoDubbing
- 사용자가 보는 이름만: 창 제목, 로그인 화면, Dock/시작 메뉴, 설치 파일(PersoDubbing-mac.dmg, PersoDubbing-Setup-1.0.0-rc.1.exe). appId와 데이터 폴더는 그대로라 기존 설치와 설정에 영향 없음.
- 문장 속 제품 이름은 전부 {app} 자리표시자(페이지·셸·Python 모두)이고 실행 중인 에디션 이름으로 채웁니다. 오픈소스는 PersoDub.
- 빌드: npm run dist:dmg:prod / dist:win:prod. Windows는 "Build Windows installer" 워크플로에서 production 선택. 공개 릴리스 워크플로는 production 빌드를 거부합니다.
- 운영 전용 업데이트 주소: desktop/src/edition.js 의 PRODUCTION_UPDATE_URL = https://portal-static.perso.ai/public/app/desktop/ (2026-10-28). 그 폴더엔 운영판 빌드의 latest.yml·latest-mac.yml과 PersoDubbing-* 파일만 올린다.

## 3. 크레딧 충전 버튼
- 더빙 준비에서 Perso 모델을 고르면 비용 옆에 "크레딧 충전". 설정의 Workspace 아래에도 같은 버튼. 둘 다 Perso 구독 페이지(UTM 포함)로 갑니다. 잔액은 보여주지 않습니다.
- 크레딧 소진 팝업의 "충전"은 원래 있던 것.

## 4. 작은 것
- 설정이 API 키 탭으로 열리고 그 탭이 첫 번째. 한국어 "작업공간" → "Workspace".
- 로그인 상태에 계정 번호(accountId = Perso userSeq)가 있습니다. 버튼 기록에는 번호 대신 되돌릴 수 없는 해시(events.js eventsUserId)가 userId로 갑니다. 화면과 실패 리포트엔 안 나갑니다.
- 버전 1.0.0-rc.1. rc 버전은 main에 안 보내고, 정식 릴리스 때 rc를 뗍니다. 업데이터는 allowPrerelease=false (rc 버전이 "rc" 채널만 보고 정식 릴리스를 못 찾는 electron-updater 동작을 막음).
- 코드 리뷰 지적 13건 수정(마지막 커밋 'Review fixes: …'): 코드 교환 중 중복 로그인 차단, kit.env 원자적 쓰기, 키 저장 실패 사유 표시 등.

## 5. 검증
- 자동 테스트 전부 통과: Python 2409(ruff 포함), UI 1063, 데스크톱 619.
- 실제 앱: Electron + Chrome + 실제 Perso(데모 클라이언트)로 로그인 → 키 → 설정 → 로그아웃 → 재로그인 통과. 오픈소스 에디션도 별도 kit으로 확인. 운영 패키징(PersoDubbing.app) 확인.

## 6. 다시 돌리는 법
- 라이브 확인(Electron 없이): node desktop/scripts/perso-login-check.mjs --client <id> --host 127.0.0.1 --port 52290
- 실제 앱: tests/e2e/perso-login.mjs 머리말의 명령.
- 세부 계획과 외부 팀에 보낼 메시지: docs/perso-login-plan.md §0.
