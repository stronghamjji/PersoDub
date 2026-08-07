import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile } from "./kitEnv.js";

test("parses KEY=value lines, skipping comments and blanks", () => {
  const text = [
    "# comment",
    "",
    "PERSODUB_APP_REPO_DIR=/Users/me/persodub",
    'QUOTED="hello world"',
    "SINGLE='x=y'",
    "NOEQUALS_LINE",
    "TRAILING = spaced ",
    'export EXPORTED="/some/path"',
  ].join("\n");
  const env = parseEnvFile(text);
  assert.equal(env.EXPORTED, "/some/path");
  assert.equal(env.PERSODUB_APP_REPO_DIR, "/Users/me/persodub");
  assert.equal(env.QUOTED, "hello world");
  assert.equal(env.SINGLE, "x=y");
  assert.equal(env.TRAILING, "spaced");
  assert.ok(!("NOEQUALS_LINE" in env));
  assert.equal(Object.keys(env).length, 5);
});
