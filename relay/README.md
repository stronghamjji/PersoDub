# 고장 보고 중계소 (Cloudflare Worker)

앱이 고장 났을 때 보내는 보고를 받아, 깃헙 이슈로 올려 주는 아주 작은 중계소입니다.
사용 횟수용 `persodub-count`와 같은 방식으로, 대시보드에서 손으로 배포합니다.

- 앱 → 여기: 고장 내용(JSON, 64 KB 이하) + 전체 로그(gzip tar, 5 MB 이하)
- 여기 → 깃헙: 이슈를 새로 만들거나, 같은 고장이면 기존 이슈에 "+1" 댓글 한 줄
- 깃헙 토큰은 **여기에만** 있습니다. 앱에는 들어 있지 않습니다.

## 파일

| 파일 | 무엇 |
|---|---|
| `report-worker.js` | 들어오는 요청을 처리하는 본체 (진입점) |
| `report-logic.js` | 판단만 하는 부분 — 검사·라벨·본문·서명·횟수 제한 |
| `report-logic.test.mjs` | 위 판단들의 테스트 |

테스트: 저장소 맨 위에서 `node --test relay/*.test.mjs`

## 처음 배포하는 순서

### 1단계. KV 저장소 만들기

Cloudflare 대시보드 → **Storage & Databases** → **KV** → *Create namespace*
- 이름: `persodub-reports`

여기에 들어가는 것: 지문 → 이슈 번호 표, 하루 횟수 세는 숫자.
IP는 저장하지 않습니다(주소를 그날 날짜·비밀값과 함께 뭉갠 짧은 값만 씁니다).

### 2단계. R2 버킷 만들기

Cloudflare 대시보드 → **R2** → *Create bucket*
- 이름: `persodub-report-logs`
- **공개 접근은 끈 채로 둡니다.** 링크는 Worker가 서명해서 내주고, 서명이 맞을 때만 파일이 나갑니다.

보관 기간 30일 설정: 버킷 → **Settings** → *Object lifecycle rules* → *Add rule*
- 규칙 이름: `expire-30d`
- 적용 대상: 모든 객체 (접두어 비움)
- 동작: *Delete objects* — 업로드 후 **30일**

### 3단계. Worker 만들기

**Workers & Pages** → *Create* → *Start with Hello World* → 이름 `persodub-report` → 배포
그다음 **Edit code**를 열고, 파일 두 개를 그대로 붙여 넣습니다.

1. `report-logic.js` 를 새 파일로 추가 (편집기 왼쪽 파일 목록의 `+`)
2. 원래 있던 진입 파일의 내용을 `report-worker.js` 내용으로 교체

> 두 파일이어야 하는 이유: 판단하는 부분을 따로 두어야 테스트를 돌릴 수 있습니다.
> 대시보드 편집기는 여러 파일을 그대로 묶어 배포합니다.

### 4단계. 연결(바인딩)과 값 넣기

Worker → **Settings** → **Bindings**

| 종류 | 변수 이름 | 무엇을 고르나 |
|---|---|---|
| KV namespace | `REPORTS` | 1단계에서 만든 `persodub-reports` |
| R2 bucket | `LOGS` | 2단계에서 만든 `persodub-report-logs` |

Worker → **Settings** → **Variables and Secrets**

| 종류 | 이름 | 값 |
|---|---|---|
| Secret | `GITHUB_TOKEN` | 아래 5단계에서 만드는 토큰 |
| Secret | `LOG_SIGNING_KEY` | 아무도 모르는 긴 문자열 (예: `openssl rand -hex 32` 결과) |
| Variable | `GITHUB_REPO` | `계정/저장소` (예: `Hamjji/PersoDub`) |
| Variable | `MAX_PER_DAY` | `5` — 한 대(그리고 한 주소)가 하루에 올릴 수 있는 수 |
| Variable | `MAX_TOTAL_PER_DAY` | `200` — 하루 전체 상한 |

`LOG_SIGNING_KEY`를 바꾸면 그 전에 나간 로그 링크는 전부 안 열립니다(이슈에 남은 링크 포함).
바꿀 일이 생기면 그 점을 감안하세요.

### 5단계. 깃헙 토큰 만들기

깃헙 → Settings → Developer settings → **Fine-grained tokens** → *Generate new token*
- 이름: `persodub-report-relay`
- Repository access: **Only select repositories** → 이 저장소 하나만
- Permissions → Repository permissions → **Issues: Read and write** (그 외 전부 No access)
- 만료: 1년 정도로 두고, 달력에 갱신일을 적어 두세요

토큰 문자열은 4단계의 `GITHUB_TOKEN`에만 넣습니다. 저장소에 커밋하지 않습니다.

### 6단계. 주소 확인

배포된 주소가 `https://persodub-report.persodub.workers.dev` 인지 확인합니다.
앱은 이 주소를 코드에 박아 두고 있습니다 (`desktop/main.js`의 `REPORT_ENDPOINT`).
주소가 다르면 앱 쪽 상수도 같이 고쳐야 합니다.

## 잘 되는지 확인하기

```sh
# 1) 보고 하나 보내기 (테스트용 지문 — 이슈가 실제로 하나 생깁니다)
curl -s -X POST https://persodub-report.persodub.workers.dev/report \
  -H 'content-type: application/json' \
  -d '{"kind":"dub","version":"0.5.5","installId":"00000000000000000000000000000000",
       "fingerprint":"000000000001","stage":"synthesize","stageMarker":"4/6",
       "code":"engine-crash","message":"test","env":{"platformKey":"mac","os":"mac 24.6.0"},
       "packs":{},"logTails":{"shell":"","app":"","job":""}}'
# -> {"id":"...","issue":12,"url":"https://github.com/.../issues/12","dedup":false}

# 2) 같은 지문으로 한 번 더 -> dedup:true, 새 이슈 없이 댓글만
```

확인이 끝나면 만들어진 테스트 이슈는 닫아 두세요.

## 무엇을 절대 하지 않는가

- IP를 저장하거나 로그로 남기지 않습니다 (횟수 제한용으로 그날치 뭉갠 값만).
- 받은 내용을 그대로 믿지 않습니다. `report-logic.js`가 칸을 하나씩 다시 만들고,
  키·홈 폴더 이름·주소를 한 번 더 지웁니다 — 옛 버전 앱이 계속 보내오기 때문입니다.
- 서명 없는 로그 링크는 내주지 않습니다. 버킷은 공개하지 않습니다.
