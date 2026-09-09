import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AGE_DAYS, parseQueueName, partitionQueue, pendingWork, queueBase } from "./reportQueue.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

test("a queue file is named for the failure and the moment", () => {
  assert.equal(queueBase("0123456789ab", NOW), `0123456789ab-${NOW}`);
});

test("a queue name reads back as its fingerprint and time", () => {
  const parsed = parseQueueName(`0123456789ab-${NOW}.json`);
  assert.deepEqual(parsed, { base: `0123456789ab-${NOW}`, fingerprint: "0123456789ab", at: NOW });
});

test("anything else in the folder is not a queue file", () => {
  for (const name of ["notes.txt", "0123456789ab.json", "xyz-123.json", `0123456789ab-${NOW}.tar.gz`, ".DS_Store"]) {
    assert.equal(parseQueueName(name), null, name);
  }
});

test("fresh reports are retried oldest first", () => {
  const names = [
    `aaaaaaaaaaaa-${NOW - 2 * DAY}.json`,
    `bbbbbbbbbbbb-${NOW - 6 * DAY}.json`,
    `cccccccccccc-${NOW - 1 * DAY}.json`,
  ];
  const { retry, expired } = partitionQueue(names, { now: NOW });
  assert.deepEqual(retry, [
    `bbbbbbbbbbbb-${NOW - 6 * DAY}`,
    `aaaaaaaaaaaa-${NOW - 2 * DAY}`,
    `cccccccccccc-${NOW - 1 * DAY}`,
  ]);
  assert.deepEqual(expired, []);
});

test("a report older than a week is deleted, not sent", () => {
  const old = `aaaaaaaaaaaa-${NOW - (MAX_AGE_DAYS + 1) * DAY}.json`;
  const { retry, expired } = partitionQueue([old], { now: NOW });
  assert.deepEqual(retry, []);
  assert.deepEqual(expired, [`aaaaaaaaaaaa-${NOW - (MAX_AGE_DAYS + 1) * DAY}`]);
});

test("a report from exactly the cutoff is still sent", () => {
  const edge = `aaaaaaaaaaaa-${NOW - MAX_AGE_DAYS * DAY}.json`;
  assert.equal(partitionQueue([edge], { now: NOW }).retry.length, 1);
});

test("a report the relay has never seen is sent", () => {
  assert.equal(pendingWork({ report: { kind: "dub" }, id: null }), "send");
});

test("a delivered report whose logs did not land retries only the logs", () => {
  assert.equal(pendingWork({ report: { kind: "dub" }, id: "abc" }, { hasArchive: true }), "logs");
});

test("a delivered report with no logs to send is finished", () => {
  assert.equal(pendingWork({ report: { kind: "dub" }, id: "abc" }, { hasArchive: false }), "done");
});

test("an unreadable queue file is finished, not retried forever", () => {
  assert.equal(pendingWork(null), "done");
  assert.equal(pendingWork({}), "done");
  assert.equal(pendingWork("garbage"), "done");
});
