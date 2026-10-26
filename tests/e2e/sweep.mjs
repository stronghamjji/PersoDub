// The functional sweep: every screen's buttons and options, pressed the way a
// person does, one area module after another, against the running app. Each
// module in tests/e2e/sweep/ exports `area` (a name) and `steps`, an array of
// { name, run(app, ctx) } where run returns a one-line note on success and
// throws on failure, or throws Skip (lib/cdp.mjs) when this computer cannot
// run it. Not part of any test suite: needs the app on a control port.
//
//   node tests/e2e/sweep.mjs --video <clip> [--srt <file>] [--out <folder>] [--port 9333] [--only home,settings]
//       [--fixtures <folder>]
//
// --fixtures is where the import area finds (or makes) its odd inputs; --video's folder when left out.
// Writes NN-<area>-<step>.png, report.md and report.json into <folder>; exits 1 when a step fails.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, Skip } from "./lib/cdp.mjs";

const { values: opt } = parseArgs({ options: {
  video: { type: "string" }, srt: { type: "string" }, out: { type: "string" }, port: { type: "string", default: "9333" },
  only: { type: "string" }, fixtures: { type: "string" } } });
if (!opt.video || !existsSync(opt.video)) {
  console.error("usage: node tests/e2e/sweep.mjs --video <short mp4 with speech> [--srt <file>] [--out <folder>] [--port 9333] [--only a,b] [--fixtures <folder>]");
  process.exit(2);
}
const startedAt = new Date();
const clock = (d = new Date()) => d.toLocaleString("sv-SE");
const stamp = clock(startedAt).replace(/[-:]/g, "").replace(" ", "-");
const out = resolve(opt.out || `e2e-sweep-${stamp}`);
mkdirSync(out, { recursive: true });
const app = await connect({ port: opt.port, out });
const ctx = { video: resolve(opt.video), srt: opt.srt ? resolve(opt.srt) : "", out, stamp, state: {},
              fixtures: resolve(opt.fixtures || dirname(resolve(opt.video))) };

const dir = join(import.meta.dirname, "sweep");
const only = opt.only ? new Set(opt.only.split(",")) : null;
const modules = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
  const m = await import(pathToFileURL(join(dir, f)).href);
  if (!only || only.has(m.area)) modules.push(m);
}
const results = [];
let n = 0;
for (const m of modules) {
  for (const step of m.steps) {
    n += 1;
    const tag = `${String(n).padStart(2, "0")}-${m.area}-${step.name.replace(/[^\w가-힣-]+/g, "-")}`;
    const t0 = Date.now();
    const row = { area: m.area, step: step.name, result: "pass", seconds: 0, note: "", shot: "" };
    try {
      row.note = (await step.run(app, ctx)) || "";
    } catch (e) {
      row.result = e instanceof Skip ? "skip" : "fail";
      row.note = e.message;
      if (row.result === "fail") try { row.html = await app.snippet(step.looks || ["body"]); } catch { /* the page is gone */ }
    }
    row.seconds = Math.round((Date.now() - t0) / 100) / 10;
    try { row.shot = await app.shot(tag); } catch { /* no picture */ }
    // Pictured as it was left; then put away, so one failure is not the next step's too.
    if (row.result !== "pass") {
      try {
        const left = await app.putAway();
        if (left.length) row.note += ` (closed after it: ${left.join(", ")})`;
      } catch (e) { row.note += ` (could not close what it left open: ${e.message})`; }
    }
    results.push(row);
    console.log(`${{ pass: "ok  ", skip: "skip", fail: "FAIL" }[row.result]} ${m.area} · ${step.name} · ${row.seconds}s · ${row.note.slice(0, 120)}`);
    if (row.result !== "pass" && step.stopsArea) {
      for (const rest of m.steps.slice(m.steps.indexOf(step) + 1)) results.push({ area: m.area, step: rest.name, result: "not run", seconds: 0, note: "", shot: "" });
      break;
    }
  }
}
app.close();
const passed = results.filter((r) => r.result === "pass").length;
const failed = results.filter((r) => r.result === "fail").length;
const skipped = results.filter((r) => r.result === "skip").length;
const md = [
  "# PersoDub functional sweep", "",
  `- Run: ${clock(startedAt)} to ${clock()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}), ${Math.round((Date.now() - startedAt) / 1000)} s`,
  `- App: ${app.origin} (${app.page.edition} edition), page in ${app.page.lang}, ${app.page.width}x${app.page.height}`,
  `- Result: ${failed ? "FAIL" : "PASS"}, ${passed} of ${results.length} steps passed (${failed} failed, ${skipped} skipped)`, "",
  "| # | Area | Step | Result | Seconds | Note |", "|---|---|---|---|---:|---|",
  ...results.map((r, i) => `| ${i + 1} | ${r.area} | ${r.shot ? `[${r.step}](${r.shot})` : r.step} | ${r.result} | ${r.seconds} | ${r.note.replace(/\|/g, "/")} |`),
  "",
  ...results.filter((r) => r.result === "fail").flatMap((r) => [`## ${r.area} · ${r.step} failed`, "", r.note, "", "```html", r.html || "", "```", ""]),
];
writeFileSync(join(out, "report.md"), md.join("\n"));
writeFileSync(join(out, "report.json"), JSON.stringify({ startedAt, app: app.origin, edition: app.page.edition, lang: app.page.lang, results }, null, 2));
console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed}/${results.length}; ${out}/report.md`);
process.exit(failed ? 1 : 0);
