import {
  MAX_LOG_BYTES,
  MAX_REPORT_BYTES,
  countSighting,
  dayKey,
  issueBody,
  issueTitle,
  labelsFor,
  logObjectKey,
  logSummary,
  newId,
  rateDecision,
  seenAgainText,
  validateRecord,
  validateReport,
  withLogsLine,
  withTally,
} from "./report-logic.js";
import { MAX_EVENTS_BYTES, isExcluded, keyedUserId, toAmplitude, toGa4, validateEvents } from "./events-logic.js";

// The relay between a broken PersoDub and this repository's issues.
//
// It exists for one reason: most people who use this app do not have a GitHub
// account, and asking for one loses nine reports in ten. So the app posts here
// and this posts to GitHub with a token the app never sees.
//
// Three ways in, all of them inward:
//   POST /report            a failure -> a new issue, or "+1" on the one that
//                           already describes it (same fingerprint), reopened
//                           when it had been closed as fixed
//                           (a failure marked userSide -> kept for the private
//                           dashboard, never an issue)
//   POST /record            a job that finished (0.8.8) -> kept for the private
//                           dashboard, never an issue
//   POST /report/<id>/logs  the full logs (gzipped tar) for a report or a
//                           record just made
//   POST /events            the buttons pressed and screens shown (0.9.2) ->
//                           GA4, and Amplitude once it has a key; kept nowhere
//
// What it never does: log an IP (only a salted daily hash of one, for the rate
// limit), trust the report it was given (report-logic.js rebuilds it field by
// field and masks it again), or hand an archive back out. The issue it writes
// is public, so it names the archive and nothing more; the logs themselves are
// read from the private dashboard, which the operator opens with a password
// (2026-09-16). Deploy notes and the bindings it needs are in relay/README.md.

const GITHUB = "https://api.github.com";
const UA = "persodub-report-relay";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function gh(env, path, init = {}) {
  const res = await fetch(`${GITHUB}/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "user-agent": UA,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  return res;
}

// GitHub's own sentence for a refusal ("Resource not accessible by personal
// access token", "Not Found", …). Only that field: the rest of the body
// quotes the request, which is somebody's crash report.
async function githubReason(res) {
  try {
    const body = await res.json();
    return String(body && body.message ? body.message : "").slice(0, 120);
  } catch {
    return "";
  }
}

// A label the repository has never had is created on first use. 422 means it
// already exists, which is the normal answer and not a problem.
async function ensureLabels(env, labels) {
  for (const name of labels) {
    try {
      await gh(env, "/labels", { method: "POST", body: JSON.stringify({ name, color: "ededed" }) });
    } catch { /* a missing label costs a filter, never a report */ }
  }
}

// The rate-limit key for an address. The address itself is never stored: this
// is a hash of it with the day and the repo's own secret, so yesterday's keys
// mean nothing and the stored value cannot be turned back into an IP.
async function ipKey(ip, day, salt) {
  const data = new TextEncoder().encode(`${ip}|${day}|${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function count(kv, key) {
  return Number((await kv.get(key)) || 0);
}

async function bump(kv, key) {
  // Two days of life: the key is only ever read on its own day, and letting KV
  // expire it means nothing ever has to be swept up.
  await kv.put(key, String((await count(kv, key)) + 1), { expirationTtl: 2 * 24 * 60 * 60 });
}

// Whether this sender may send one more today, counted if so: its install id,
// its address (hashed with the day) and the day's total, each against its cap
// (report-logic.js rateDecision). `prefix` keeps a finished job's counts
// ("ok:") apart from a failure's (""), so records never spend the failure
// reports' allowance.
async function withinLimits(request, env, ctx, installId, { prefix, perDay, totalPerDay }) {
  const day = dayKey();
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipk = await ipKey(ip, day, env.LOG_SIGNING_KEY || env.GITHUB_REPO || "");
  const keys = {
    install: `rl:${prefix}i:${installId}:${day}`,
    ip: `rl:${prefix}a:${ipk}:${day}`,
    total: `rl:${prefix}t:${day}`,
  };
  const decision = rateDecision({
    installCount: await count(env.REPORTS, keys.install),
    ipCount: await count(env.REPORTS, keys.ip),
    totalCount: await count(env.REPORTS, keys.total),
  }, { perDay, totalPerDay });
  if (!decision.ok) return false;
  for (const k of Object.values(keys)) ctx.waitUntil(bump(env.REPORTS, k));
  return true;
}

async function handleReport(request, env, ctx) {
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return json({ error: "too large" }, 413);
  const checked = validateReport(text);
  if (!checked.ok) return json({ error: checked.reason }, 400);
  const report = checked.report;

  // Over the limit is answered, not explained: the app keeps its copy and
  // stops, and nobody learns how close they were to the line.
  // The user's own situation ("us:") is counted apart, so a full disk tried
  // five times cannot spend the day's allowance of the failures we can fix.
  if (!await withinLimits(request, env, ctx, report.installId, {
    prefix: report.userSide ? "us:" : "", perDay: Number(env.MAX_PER_DAY || 5), totalPerDay: Number(env.MAX_TOTAL_PER_DAY || 200),
  })) return json({ error: "rate limited" }, 429);

  const id = newId();
  // A full disk, a refused key, Perso out of credits: the user's own
  // situation, told on screen. Kept for the private dashboard with its logs
  // (handleLogs), as a reported failure is, and nothing GitHub ever sees.
  if (report.userSide) {
    await env.REPORTS.put(`id:${id}`, JSON.stringify({ fingerprint: report.fingerprint, summary: logSummary(report, "") }), { expirationTtl: 7 * 24 * 60 * 60 });
    return json({ id });
  }
  const known = await env.REPORTS.get(`fp:${report.fingerprint}`, "json");
  let issue = known && known.issue;
  let url = known && known.url;
  const commentId = null;
  // What the issue's body will say it has been seen: kept in KV beside the
  // issue number, so a body somebody edits by hand cannot lose the count.
  let tally = null;
  // The state GitHub gave the known issue, and whether this report reopened
  // it: the private dashboard shows both (logSummary).
  let priorState = "";
  let reopened = false;

  if (issue) {
    // The hundredth machine to hit one bug counts up in the issue it already
    // has, rather than opening the hundredth issue OR adding the hundredth
    // comment: the number and the machines it has been seen on are one line
    // in the body, rewritten in place (user, 2026-09-10). A read before the
    // write because the body is the thing being edited; a failure here loses
    // a count, never the report.
    tally = countSighting(known, report);
    const got = await gh(env, `/issues/${issue}`);
    if (got.ok) {
      const current = await got.json();
      priorState = String(current.state || "");
      // A closed issue seen again says so in one comment. One closed as fixed
      // is reopened too: the fix did not hold -- or the machine is still on a
      // version from before it, which the relay cannot tell apart, since the
      // version a fix shipped in is written nowhere it can read ("Fixed in
      // 0.8.1" is a sentence in a closing comment) -- so it always reopens and
      // leaves closing it again to the owner. One closed as not planned, or
      // labelled a duplicate, was a decision rather than a fix and stays closed
      // (reviewer, 2026-10-22). Rewriting only the count let #106, closed as
      // fixed in 0.8.1, take a sighting from a 0.7.0 app that nobody saw.
      if (priorState === "closed") {
        const duplicate = (current.labels || []).some((l) => (l?.name ?? l) === "duplicate");
        if (current.state_reason === "completed" && !duplicate) {
          reopened = (await gh(env, `/issues/${issue}`, { method: "PATCH", body: JSON.stringify({ state: "open" }) })).ok;
        }
        await gh(env, `/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body: seenAgainText(report) }) });
      }
      const body = withTally(current.body || "", tally);
      await gh(env, `/issues/${issue}`, { method: "PATCH", body: JSON.stringify({ body }) });
    }
    await env.REPORTS.put(`fp:${report.fingerprint}`, JSON.stringify({ issue, url, ...tally }));
  } else {
    const labels = labelsFor(report);
    await ensureLabels(env, labels);
    const res = await gh(env, "/issues", {
      method: "POST",
      body: JSON.stringify({ title: issueTitle(report), body: issueBody(report), labels }),
    });
    if (!res.ok) {
      // The status and GitHub's own one-line reason, never the rest of the
      // body: that quotes the request back, and the request is somebody's
      // crash report. 401/403 is the token, 404 is the repository name, and
      // GitHub's sentence is what tells a scope problem from a blocked
      // account -- the status alone left us guessing (2026-09-10).
      const detail = await githubReason(res);
      console.log(`relay github ${res.status} on create: ${detail}`);
      return json({ error: "upstream", status: res.status, detail }, 502);
    }
    const made = await res.json();
    issue = made.number;
    url = made.html_url;
    tally = countSighting(null, report);
    await env.REPORTS.put(`fp:${report.fingerprint}`, JSON.stringify({ issue, url, ...tally }));
  }

  // What the log upload will need: which issue to hang the link on, and
  // whether it goes in the body or in the comment just made. Kept for the same
  // week the app is willing to keep retrying an upload for
  // (desktop/src/reportQueue.js MAX_AGE_DAYS) -- an hour looked like plenty,
  // since the archive normally follows within seconds, but the one case that
  // matters is the machine whose network died between the two requests, and
  // for that machine the retry can be days later.
  // The summary rides along because this is the only moment the facts are in
  // hand: the archive that follows carries them onto the stored object, and
  // the private dashboard reads a month of archives as a list without opening
  // one of them (2026-09-16).
  await env.REPORTS.put(
    `id:${id}`,
    JSON.stringify({
      fingerprint: report.fingerprint, issue, commentId,
      summary: logSummary(report, issue, { priorState, reopened }),
    }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );
  return json({ id, issue, url, dedup: !!(known && known.issue) });
}

// A job that finished (0.8.8): checked like a report and limited per machine
// like one, on counts and caps of its own, and kept for the private dashboard
// only -- no issue, no tally, nothing GitHub ever sees. Its summary is held
// for the archive that follows on the same upload route as a report's
// (handleLogs), for the same week.
async function handleRecord(request, env, ctx) {
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return json({ error: "too large" }, 413);
  const checked = validateRecord(text);
  if (!checked.ok) return json({ error: checked.reason }, 400);
  const { record } = checked;
  if (!await withinLimits(request, env, ctx, record.installId, {
    prefix: "ok:", perDay: Number(env.MAX_RECORDS_PER_DAY || 50), totalPerDay: Number(env.MAX_RECORDS_TOTAL_PER_DAY || 500),
  })) return json({ error: "rate limited" }, 429);

  const id = newId();
  await env.REPORTS.put(`id:${id}`, JSON.stringify({ summary: logSummary(record, "") }), { expirationTtl: 7 * 24 * 60 * 60 });
  return json({ id });
}

async function handleLogs(request, env, id) {
  const pending = await env.REPORTS.get(`id:${id}`, "json");
  if (!pending) return json({ error: "unknown report" }, 404);
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_LOG_BYTES) return json({ error: "bad size" }, 413);
  // A relay standing up before its bucket exists takes the report and says the
  // logs found no home -- 501, which the app reads as "never going to work"
  // and stops retrying, rather than keeping the file for a week.
  if (!env.LOGS) return json({ error: "no log store" }, 501);

  const now = Date.now();
  // A finished job's archive files under "ok" where a failure's fingerprint
  // would be, "<yyyy-mm>/ok/<id>.tar.gz", and that is all it does: there is no
  // issue to name it in.
  const record = !!pending.summary && pending.summary.outcome === "ok";
  const key = logObjectKey({ fingerprint: record ? "ok" : pending.fingerprint, id, now });
  await env.LOGS.put(key, body, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: pending.summary || {},
  });
  if (record) return json({ ok: true });
  await env.REPORTS.put(`log:${id}`, key, { expirationTtl: 40 * 24 * 60 * 60 });
  if (pending.summary?.userSide === "true") return json({ ok: true });

  // The issue was written before the archive arrived, so the line is added to
  // whichever piece of writing this report produced. It names the archive and
  // stops there: the issue is public, and a link -- signed or not -- would let
  // anyone reading it download a stranger's logs. The operator fetches them
  // from the private dashboard instead, which is already behind a password.
  const path = pending.commentId ? `/issues/comments/${pending.commentId}` : `/issues/${pending.issue}`;
  const current = await gh(env, path);
  if (current.ok) {
    const existing = (await current.json()).body || "";
    await gh(env, path, { method: "PATCH", body: JSON.stringify({ body: withLogsLine(existing, id) }) });
  }
  return json({ ok: true });
}

const GA4 = "https://www.google-analytics.com/mp/collect";
const AMPLITUDE = "https://api2.amplitude.com/2/httpapi";

// A copy that did not land is a number missing from a chart, never a reason to
// make the app send again: the status is logged and nothing else.
async function forward(name, url, body) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) console.log(`relay ${name} ${res.status}`);
  } catch (err) {
    console.log(`relay ${name} error: ${err && err.name}`);
  }
}

// One computer's batch of presses and screens (desktop/src/events.js). Checked
// (events-logic.js), the owner's own computers dropped the way the dashboard
// drops them (EXCLUDED_DEVICES), and passed on after the answer: the app is
// told 204 at once, and waits for neither GA4 nor Amplitude. No rate limit in
// KV -- a batch every 30 seconds from every open app would spend its writes.
async function handleEvents(request, env, ctx) {
  const text = await request.text();
  if (text.length > MAX_EVENTS_BYTES) return json({ error: "too large" }, 413);
  const checked = validateEvents(text);
  if (!checked.ok) return json({ error: checked.reason }, 400);
  const { batch } = checked;
  const userId = await keyedUserId(batch.userId, env.EVENTS_USER_KEY);
  if (isExcluded(batch.installId, env.EXCLUDED_DEVICES) || batch.events.length === 0) return new Response(null, { status: 204 });
  if (env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET) {
    const url = `${GA4}?measurement_id=${encodeURIComponent(env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`;
    for (const body of toGa4(batch, { debug: env.GA4_DEBUG === "1", userId })) ctx.waitUntil(forward("ga4", url, body));
  }
  if (env.AMPLITUDE_API_KEY) {
    ctx.waitUntil(forward("amplitude", AMPLITUDE, { api_key: env.AMPLITUDE_API_KEY, events: toAmplitude(batch, { userId }) }));
  }
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "POST" && pathname === "/report") return await handleReport(request, env, ctx);
      if (request.method === "POST" && pathname === "/record") return await handleRecord(request, env, ctx);
      if (request.method === "POST" && pathname === "/events") return await handleEvents(request, env, ctx);
      const upload = /^\/report\/([0-9a-f]{32})\/logs$/.exec(pathname);
      if (request.method === "POST" && upload) return await handleLogs(request, env, upload[1]);
      // No way out for an archive: the relay only takes logs in. Reading one
      // back is the dashboard's job, on the private side of the password.
      return json({ error: "not found" }, 404);
    } catch (err) {
      // Never the message: an upstream error can quote the request, and the
      // request is somebody's crash report.
      console.log(`relay error: ${err && err.name}`);
      return json({ error: "relay" }, 500);
    }
  },
};
