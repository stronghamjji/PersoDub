// What this build is, and so which repository the app points at: its names,
// the update feed, the build's values and shell.log's edition line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { EDITION, PRODUCT, REPO, updateFeed, buildEnvText, readBuildEnv } from "./edition.js";

// A payload folder.
function payload() {
  return mkdtempSync(join(tmpdir(), "odedition-"));
}

test("the app points at the public repository", () => {
  assert.equal(REPO, "stronghamjji/PersoDub");
});

test("the update feed is the repository's GitHub Releases", () => {
  assert.deepEqual(updateFeed(), { provider: "github", owner: "stronghamjji", repo: "PersoDub" });
});

test("build.env carries the build's set values only", () => {
  const env = { PERSODUB_INQUIRY_URL: "", PERSODUB_UPDATE_URL: "https://updates.example/", OTHER: "x" };
  assert.equal(buildEnvText(env), "");
  assert.equal(buildEnvText({ ...env, PERSODUB_INQUIRY_URL: "https://script.example/exec" }),
    "PERSODUB_INQUIRY_URL=https://script.example/exec\n");
});

test("the running app reads its build values from the payload's build.env, or the environment without a payload", () => {
  const dir = payload();
  writeFileSync(join(dir, "build.env"), "PERSODUB_INQUIRY_URL=https://script.example/exec\n");
  const env = { PERSODUB_INQUIRY_URL: "https://elsewhere.example/exec" };
  assert.deepEqual(readBuildEnv({ payloadDir: dir, env }), { PERSODUB_INQUIRY_URL: "https://script.example/exec" });
  assert.deepEqual(readBuildEnv({ payloadDir: payload(), env }), {});
  assert.deepEqual(readBuildEnv({ payloadDir: null, env: { ...env, OTHER: "x" } }), env);
});

// The line a tester reads in shell.log to tell which build is running
// (main.js, at launch).
test("shell.log names the build as the open-source one at launch", () => {
  assert.equal(EDITION, "opensource");
  assert.equal(`PERSODUB_EDITION ${EDITION} ${REPO}`, "PERSODUB_EDITION opensource stronghamjji/PersoDub");
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "main.js"), "utf8");
  assert.ok(main.includes("shellLog(`PERSODUB_EDITION ${EDITION} ${REPO}`);"), "main.js writes the launch's line");
});

test("the app's names: PersoDub on screen, and its app id", () => {
  assert.deepEqual(PRODUCT, { name: "PersoDub", appId: "com.persodub.desktop" });
});
