import {
  MAX_LOG_BYTES,
  MAX_REPORT_BYTES,
  commentText,
  dayKey,
  issueBody,
  issueTitle,
  labelsFor,
  logExpiry,
  logObjectKey,
  logUrl,
  newId,
  rateDecision,
  signLog,
  validateReport,
  verifyLog,
  withLogsLine,
} from "./report-logic.js";

// The relay between a broken PersoDub and this repository's issues.
//
// It exists for one reason: most people who use this app do not have a GitHub
// account, and asking for one loses nine reports in ten. So the app posts here
// and this posts to GitHub with a token the app never sees.
//
// Three ways in:
//   POST /report            a failure -> a new issue, or "+1" on the one that
//                           already describes it (same fingerprint)
//   POST /report/<id>/logs  the full logs (gzipped tar) for a report just made
//   GET  /logs/<id>?exp&sig the same archive back, for whoever has the signed
//                           link that was put in the issue
//
// What it never does: log an IP (only a salted daily hash of one, for the rate
// limit), trust the report it was given (report-logic.js rebuilds it field by
// field and masks it again), or serve a bucket object without a valid
// signature. Deploy notes and the bindings it needs are in relay/README.md.

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

async function handleReport(request, env, ctx) {
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return json({ error: "too large" }, 413);
  const checked = validateReport(text);
  if (!checked.ok) return json({ error: checked.reason }, 400);
  const report = checked.report;

  const day = dayKey();
  const perDay = Number(env.MAX_PER_DAY || 5);
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipk = await ipKey(ip, day, env.LOG_SIGNING_KEY || env.GITHUB_REPO || "");
  const keys = {
    install: `rl:i:${report.installId}:${day}`,
    ip: `rl:a:${ipk}:${day}`,
    total: `rl:t:${day}`,
  };
  const decision = rateDecision({
    installCount: await count(env.REPORTS, keys.install),
    ipCount: await count(env.REPORTS, keys.ip),
    totalCount: await count(env.REPORTS, keys.total),
  }, { perDay, totalPerDay: Number(env.MAX_TOTAL_PER_DAY || 200) });
  // Over the limit is answered, not explained: the app keeps its copy and
  // stops, and nobody learns how close they were to the line.
  if (!decision.ok) return json({ error: "rate limited" }, 429);
  for (const k of Object.values(keys)) ctx.waitUntil(bump(env.REPORTS, k));

  const id = newId();
  const known = await env.REPORTS.get(`fp:${report.fingerprint}`, "json");
  let issue = known && known.issue;
  let url = known && known.url;
  let commentId = null;

  if (issue) {
    // The hundredth machine to hit one bug adds a line to one issue, rather
    // than opening the hundredth issue.
    const res = await gh(env, `/issues/${issue}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: commentText(report) }),
    });
    if (res.ok) commentId = (await res.json()).id;
  } else {
    const labels = labelsFor(report);
    await ensureLabels(env, labels);
    const res = await gh(env, "/issues", {
      method: "POST",
      body: JSON.stringify({ title: issueTitle(report), body: issueBody(report), labels }),
    });
    if (!res.ok) return json({ error: "upstream" }, 502);
    const made = await res.json();
    issue = made.number;
    url = made.html_url;
    await env.REPORTS.put(`fp:${report.fingerprint}`, JSON.stringify({ issue, url }));
  }

  // What the log upload will need: which issue to hang the link on, and
  // whether it goes in the body or in the comment just made. Kept for the same
  // week the app is willing to keep retrying an upload for
  // (desktop/src/reportQueue.js MAX_AGE_DAYS) -- an hour looked like plenty,
  // since the archive normally follows within seconds, but the one case that
  // matters is the machine whose network died between the two requests, and
  // for that machine the retry can be days later.
  await env.REPORTS.put(
    `id:${id}`,
    JSON.stringify({ fingerprint: report.fingerprint, issue, commentId }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );
  return json({ id, issue, url, dedup: !!(known && known.issue) });
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
  const key = logObjectKey({ fingerprint: pending.fingerprint, id, now });
  await env.LOGS.put(key, body, { httpMetadata: { contentType: "application/gzip" } });
  await env.REPORTS.put(`log:${id}`, key, { expirationTtl: 40 * 24 * 60 * 60 });

  // The link is this Worker's, signed, and it expires with the object. A
  // public bucket URL would be a permanent, unauthenticated copy of somebody's
  // logs, which is exactly what the signature exists to prevent.
  const exp = logExpiry(now);
  const link = logUrl(new URL(request.url).origin, id, exp, await signLog(id, exp, env.LOG_SIGNING_KEY));

  // The issue was written before the archive arrived, so the line is added to
  // whichever piece of writing this report produced.
  const path = pending.commentId ? `/issues/comments/${pending.commentId}` : `/issues/${pending.issue}`;
  const current = await gh(env, path);
  if (current.ok) {
    const existing = (await current.json()).body || "";
    await gh(env, path, { method: "PATCH", body: JSON.stringify({ body: withLogsLine(existing, link) }) });
  }
  return json({ ok: true, url: link });
}

async function serveLogs(request, env, id) {
  const params = new URL(request.url).searchParams;
  if (!(await verifyLog(id, params.get("exp"), params.get("sig"), env.LOG_SIGNING_KEY))) {
    return json({ error: "bad link" }, 403);
  }
  const key = await env.REPORTS.get(`log:${id}`);
  const object = key && env.LOGS && (await env.LOGS.get(key));
  if (!object) return json({ error: "gone" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${id}.tar.gz"`,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "POST" && pathname === "/report") return await handleReport(request, env, ctx);
      const upload = /^\/report\/([0-9a-f]{32})\/logs$/.exec(pathname);
      if (request.method === "POST" && upload) return await handleLogs(request, env, upload[1]);
      const download = /^\/logs\/([0-9a-f]{32})$/.exec(pathname);
      if (request.method === "GET" && download) return await serveLogs(request, env, download[1]);
      return json({ error: "not found" }, 404);
    } catch (err) {
      // Never the message: an upstream error can quote the request, and the
      // request is somebody's crash report.
      console.log(`relay error: ${err && err.name}`);
      return json({ error: "relay" }, 500);
    }
  },
};
