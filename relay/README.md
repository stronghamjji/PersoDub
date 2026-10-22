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

## Files

| File | What |
|---|---|
| `report-worker.js` | Handles the incoming request (the entry point) |
| `report-logic.js` | Decisions only: checks, labels, body, signing, rate limits |
| `report-logic.test.mjs` | Tests for those decisions |
| `report-worker.test.mjs` | Tests for the handler, with stand-ins for KV and GitHub |

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

## What it never does

- Store or log an IP address (only the day's digest, for the rate limit).
- Trust what it receives. `report-logic.js` rebuilds every field and strips keys, home
  folder names and addresses once more, because older versions of the app keep sending.
- Hand out an unsigned log link. The bucket stays private.
