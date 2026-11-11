import assert from "node:assert/strict";
import { test } from "node:test";

import { findProblems } from "./check-commits.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SAME_REPO = { owner: "owner", sameRepo: true };
const FORK = { owner: "owner", sameRepo: false };

function commit({ message = "Fix the thing", author = "owner", committer = "owner" } = {}) {
  return {
    sha: SHA,
    commit: { message },
    author: author && { login: author },
    committer: committer && { login: committer },
  };
}

test("a clean commit by the owner passes", () => {
  assert.deepEqual(findProblems([commit()], SAME_REPO), []);
});

test("each signature form fails, and the problem starts with the short sha", () => {
  const signatures = [
    "Co-Authored-By: Claude Fable 5.1 <x@y>",
    "co-authored-by: Codex <codex@openai.example>",
    "Claude-Session: https://example.com/session_1",
    "  claude-session: abc",
    "🤖 Generated with [Claude Code](https://example.com)",
    "generated with Copilot",
  ];
  for (const signature of signatures) {
    const problems = findProblems([commit({ message: `Fix the thing\n\n${signature}\r\n` })], SAME_REPO);
    assert.equal(problems.length, 1, signature);
    assert.match(problems[0], /^0123456 remove the /, signature);
  }
});

test("prose that mentions an assistant passes", () => {
  const messages = [
    "The Claude assistant is allowed every tool",
    "Docs: the page is generated with care; Cursor users see the same text",
    "Generated with cursory testing only",
  ];
  for (const message of messages) {
    assert.deepEqual(findProblems([commit({ message })], SAME_REPO), [], message);
  }
});

test("a human co-author passes", () => {
  const message = "Fix the thing\n\nCo-authored-by: A Human <human@example.com>";
  assert.deepEqual(findProblems([commit({ message })], SAME_REPO), []);
});

test("a fork's pull request skips the account rule but not the signature rule", () => {
  const stranger = { author: "stranger", committer: "stranger" };
  assert.deepEqual(findProblems([commit(stranger)], FORK), []);
  assert.deepEqual(findProblems([commit({ author: null, committer: null })], FORK), []);

  const signed = commit({ ...stranger, message: "Fix\n\nCo-authored-by: Cursor <cursor@example.com>" });
  assert.equal(findProblems([signed], FORK).length, 1);
});

test("another account fails in a same-repository pull request", () => {
  const problems = findProblems([commit({ author: "stranger", committer: "stranger" })], SAME_REPO);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^0123456 is authored by another account, not the repository owner owner/);
  assert.match(problems[1], /^0123456 is committed by another account, not the repository owner owner/);
});

test("an author or committer GitHub does not recognise fails in a same-repository pull request", () => {
  const problems = findProblems([commit({ author: null, committer: null })], SAME_REPO);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /authored by an account GitHub does not recognise/);
  assert.match(problems[1], /committed by an account GitHub does not recognise/);
});

test("web-flow may commit the owner's work but not author it", () => {
  assert.deepEqual(findProblems([commit({ committer: "web-flow" })], SAME_REPO), []);
  assert.equal(findProblems([commit({ author: "web-flow", committer: "web-flow" })], SAME_REPO).length, 1);
});

test("dependabot passes, with itself or web-flow as committer", () => {
  for (const committer of ["dependabot[bot]", "web-flow"]) {
    assert.deepEqual(findProblems([commit({ author: "dependabot[bot]", committer })], SAME_REPO), []);
  }
  assert.equal(findProblems([commit({ committer: "dependabot[bot]" })], SAME_REPO).length, 1);
});

test("a problem never prints an e-mail address", () => {
  const commits = [
    commit({ message: "Fix\n\nCo-Authored-By: Claude Fable 5.1 <x@y>\nClaude-Session: s\nGenerated with Codex" }),
    commit({ author: "stranger", committer: null }),
  ];
  const problems = findProblems(commits, SAME_REPO);
  assert.equal(problems.length, 5);
  for (const problem of problems) assert.ok(!problem.includes("@"), problem);
});
