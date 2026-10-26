# Failure report relay (Cloudflare Worker)

A very small relay. The app sends it a report when a dub, an erase, an install or the
agent fails; the relay turns that into a GitHub issue. It is deployed by hand, the same
way as the usage-count worker `persodub-count`.

- App → here: the failure (JSON, 64 KB at most) and the full logs (gzip tar, 5 MB at most)
- Here → GitHub: a new issue, or one "+1" comment on the existing issue for the same failure
- The GitHub token lives **only here**. The app does not carry it.
- From 0.8.8 the app also sends the record of a job that finished (`POST /record`, then its
  logs the same way). Its logs go into the bucket under `<yyyy-mm>/ok/<id>.tar.gz` for the
  private dashboard, and GitHub never hears of it.
- From 0.9.1 the app sends the buttons pressed and the screens shown (`POST /events`) while
  the Settings switch for them is on. The relay passes them to GA4, and to Amplitude once
  it has a key, and keeps nothing itself. See "Button and screen events" below.
- From 0.9.1 the production edition's Customer support sends a Service inquiry (`POST /inquiry`).
  See "Service inquiries" below.

## Files

| File | What |
|---|---|
| `report-worker.js` | Handles the incoming request (the entry point) |
| `report-logic.js` | Decisions only: checks, labels, body, signing, rate limits |
| `report-logic.test.mjs` | Tests for those decisions |
| `report-worker.test.mjs` | Tests for the handler, with stand-ins for KV and GitHub |
| `events-logic.js` | `POST /events` decisions: what a batch may hold, excluded computers, the GA4 and Amplitude bodies |
| `events-logic.test.mjs` | Tests for those decisions |

Tests, from the repository root: `node --test relay/*.test.mjs`

## Deploying for the first time

### Step 1. Create the KV namespace

Cloudflare dashboard → **Storage & Databases** → **KV** → *Create namespace*
- Name: `persodub-reports`

It holds the fingerprint → issue number table and the per-day counters.
No IP address is stored (only a short digest of the address with the day and a secret).

### Step 2. Create the R2 bucket

Cloudflare dashboard → **R2** → *Create bucket*
- Name: `persodub-report-logs`
- **Leave public access off.** The Worker signs every link, and a file is served only
  when the signature matches.

Keep logs for 30 days: bucket → **Settings** → *Object lifecycle rules* → *Add rule*
- Rule name: `expire-30d`
- Applies to: all objects (empty prefix)
- Action: *Delete objects* **30 days** after upload

### Step 3. Create the Worker

**Workers & Pages** → *Create* → *Start with Hello World* → name it `persodub-report` → Deploy.
Then open **Edit code** and paste the two files as they are.

1. Add `report-logic.js` as a new file (the `+` in the file list on the left)
2. Replace the contents of the original entry file with `report-worker.js`

> Two files on purpose: the decisions live apart from the handler so they can be tested.
> The dashboard editor bundles several files as they are.

Or deploy from this folder with `wrangler deploy`; `wrangler.jsonc` carries the bindings
and the variables below. Secrets go in with `wrangler secret put`, never into that file.

### Step 4. Bindings and values

Worker → **Settings** → **Bindings**

| Kind | Variable | Pick |
|---|---|---|
| KV namespace | `REPORTS` | `persodub-reports` from step 1 |
| R2 bucket | `LOGS` | `persodub-report-logs` from step 2 |

Worker → **Settings** → **Variables and Secrets**

| Kind | Name | Value |
|---|---|---|
| Secret | `GITHUB_TOKEN` | the token made in step 5 |
| Secret | `LOG_SIGNING_KEY` | a long string nobody knows (for example the output of `openssl rand -hex 32`) |
| Variable | `GITHUB_REPO` | `owner/repository` (for example `stronghamjji/PersoDub`) |
| Variable | `MAX_PER_DAY` | `5`: reports one machine (and one address) may file per day |
| Variable | `MAX_TOTAL_PER_DAY` | `200`: the day's total |
| Variable | `MAX_RECORDS_PER_DAY` | `50`: finished jobs one machine (and one address) may send per day, counted apart from the reports |
| Variable | `MAX_RECORDS_TOTAL_PER_DAY` | `500`: the day's total of finished jobs |

For `POST /events` (all optional: without them the route answers 204 and passes nothing on)

| Kind | Name | Value |
|---|---|---|
| Secret | `GA4_MEASUREMENT_ID` | the GA4 web stream's measurement id, `G-...` |
| Secret | `GA4_API_SECRET` | Admin → Data streams → the stream → *Measurement Protocol API secrets* → Create |
| Variable | `GA4_DEBUG` | `1` marks every event for GA4 **DebugView**; remove it once checked |
| Secret | `AMPLITUDE_API_KEY` | the Amplitude project's API key; set it and the same events go there too |
| Secret | `EXCLUDED_DEVICES` | the owner's computers, the same value the dashboard has: install ids or their first 12 characters, comma separated |

Changing `LOG_SIGNING_KEY` breaks every log link handed out before it (including the
links left in issues). Keep that in mind if it ever has to change.

### Step 5. Make the GitHub token

GitHub → Settings → Developer settings → **Fine-grained tokens** → *Generate new token*
- Name: `persodub-report-relay`
- Repository access: **Only select repositories** → this repository only
- Permissions → Repository permissions → **Issues: Read and write** (everything else No access)
- Expiry: about a year, with the renewal date in a calendar

The token string goes into `GITHUB_TOKEN` in step 4 and nowhere else. It is never committed.

### Step 6. Check the address

The deployed address must be `https://persodub-report.persodub.workers.dev`.
The app has it built in (`REPORT_ENDPOINT` in `desktop/src/reporting.js`).
A different address means the app's constant changes with it.

## Checking that it works

```sh
# 1) Send one report (a test fingerprint: this really creates one issue)
curl -s -X POST https://persodub-report.persodub.workers.dev/report \
  -H 'content-type: application/json' \
  -d '{"kind":"dub","version":"0.5.5","installId":"00000000000000000000000000000000",
       "fingerprint":"000000000001","stage":"synthesize","stageMarker":"4/6",
       "code":"engine-crash","message":"test","env":{"platformKey":"mac","os":"mac 24.6.0"},
       "packs":{},"logTails":{"shell":"","app":"","job":""}}'
# -> {"id":"...","issue":12,"url":"https://github.com/.../issues/12","dedup":false}

# 2) The same fingerprint again -> dedup:true, a comment and no new issue

# 3) Close the issue (as completed), then the same fingerprint once more -> the issue is
#    open again, with one comment "Seen again on 0.5.5, mac 24.6.0, after the issue was closed."
#    Closed as not planned, or labelled duplicate, it stays closed and gets only the comment.
```

Close the test issue once you have checked it.

## Button and screen events

What one request carries (`desktop/src/events.js` builds it, at most 500 events):

```json
{"installId":"<32 hex>","userId":"","version":"0.9.1","edition":"production","os":"mac",
 "osVersion":"15.5","sessionId":1793000000000,
 "events":[{"name":"app_screen","screen":"home","t":1793000001000},
           {"name":"home_nav_settings","screen":"home","t":1793000002000}]}
```

`name` is an element's id (or its English label key) in snake case, never what a person
typed; `app_screen` means the screen changed to `screen`. GA4 and Amplitude each get two
event names: `app_screen`, and `button_press` with the button in the `button` parameter.
`installId` is the client id (GA4) and device id (Amplitude); `userId` becomes `user_id`
once the production edition signs in. Register `button`, `screen`, `edition` and
`app_version` as custom dimensions in GA4 to chart them.

Checking it in DebugView:

```sh
wrangler secret put GA4_MEASUREMENT_ID   # G-...
wrangler secret put GA4_API_SECRET
# GA4_DEBUG=1 under vars in wrangler.jsonc (or the dashboard), then
wrangler deploy
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://persodub-report.persodub.workers.dev/events \
  -H 'content-type: application/json' \
  -d "{\"installId\":\"00000000000000000000000000000001\",\"version\":\"0.9.1\",\"edition\":\"production\",
       \"os\":\"mac\",\"sessionId\":$(date +%s)000,
       \"events\":[{\"name\":\"relay_check\",\"screen\":\"home\",\"t\":$(date +%s)000}]}"
# -> 204; GA4 → Admin → DebugView shows button_press with button=relay_check within a minute
```

Then take `GA4_DEBUG` out and deploy again.

## Service inquiries

The production edition's Customer support form (`ui/src/feedbackSheet.mjs`), sent by the
shell (`desktop/src/reporting.js` `sendInquiry`) whatever the failure reports' switch says:
the person pressed Send and agreed to the collection on the form.

```json
{"type":"bug","subject":"Export stops","details":"At 90%, every time.","replyTo":"me@example.com",
 "installId":"<32 hex>","version":"0.9.1","edition":"production","os":"mac","osVersion":"15.1.0","locale":"ko"}
```

- `type` is one of `bug`, `problem`, `payment`, `other`; `subject` 1 to 120 characters,
  `details` 1 to 4,000; `replyTo` an address or empty. Anything else is 400. The answer is `{"id"}`.
- Kept in the bucket as `<yyyy-mm>/inquiry/<id>.json` (the details and the rest), with the
  rest also on the object as metadata, so the dashboard's 문의 page lists them without
  opening one. The computer is its first twelve characters (`device`).
- A `bug` inquiry's logs follow on `POST /report/<id>/logs`, the same masked archive a
  failure sends, and land as `<yyyy-mm>/inquiry/<id>.tar.gz`. Any other kind has no logs.
- Ten a day from one computer or address, 200 a day in all (`MAX_INQUIRIES_PER_DAY`,
  `MAX_INQUIRIES_TOTAL_PER_DAY`), counted apart from the reports.
- The bucket's 30-day rule deletes inquiries like everything else in it.
- The owner's computers are not dropped here: the dashboard hides them (`EXCLUDED_DEVICES`
  there), so a test inquiry can still be found.

## What it never does

- Store or log an IP address (only the day's digest, for the rate limit).
- Trust what it receives. `report-logic.js` rebuilds every field and strips keys, home
  folder names and addresses once more, because older versions of the app keep sending.
- Hand out an unsigned log link. The bucket stays private.
