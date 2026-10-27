// A Perso API dubbing done on Perso -- made, but a free-plan workspace cannot
// download it -- run in the page itself: ui/src/app.mjs on the stand-in
// browser of ui/testlib/stubDom.mjs, opening on that job. Its card says where
// the dubbing is, never that it failed, and its one button opens the
// project's page on Perso's site (owner, 2026-10-28).
//
// One page per process: app.mjs runs once, at the import below.
//
// Run with: node --test ui/src/onPersoCard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { installStubDom } from "../testlib/stubDom.mjs";

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" } });
const UTM = "utm_source=persodub-mac&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1";

const page = installStubDom(readFileSync(new URL("../../static/index.html", import.meta.url), "utf8"));
const opened = [];
window.open = (...args) => { opened.push(args); return null; };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === "/api/settings") return json(200, { perso_utm: UTM });
  if (u === "/api/dub/jobs/j1") {
    return json(200, { id: "j1", kind: "dub", status: "on_perso", dub_mode: "perso", perso_project_seq: 435920,
                       perso_space_seq: 625615, logs: [], notices: [] });
  }
  return new Promise(() => {});   // the rest of the server has not answered yet
};
// The page opens on the dub it was left on: this one.
localStorage.setItem("persodub.layout.lastJobId", "j1");
await import("./app.mjs");
await sleep(300);
const $ = (id) => document.getElementById(id);

test("a dubbing done on Perso says so, with Open in Perso as its only button", () => {
  assert.equal($("doneFail").hidden, false);
  assert.equal($("doneFailWhy").textContent, "See it on Perso");
  assert.equal($("doneNotice").textContent,
    "A free-plan workspace cannot download the result. The dubbing is done; see it in your Perso workspace.");
  assert.equal($("doneResume").hidden, true);
  assert.equal($("doneRetry").hidden, true);
  assert.equal($("doneOpenPerso").hidden, false);
  assert.doesNotMatch($("doneFailBody").textContent, /fail|didn't finish/i);
});

test("Open in Perso opens the project's page on Perso, tagged as the result button", () => {
  $("doneOpenPerso").click();
  assert.deepEqual(opened, [[`https://perso.ai/en/workspace/vt/detail/435920?${UTM}&utm_content=result`, "_blank", "noopener"]]);
});

test.after(() => page.restore());
