// Plain node:test unit tests for the page's guard against reporting a job
// twice across a restart (ui/src/reportedOnce.mjs). The module reads and
// writes window.localStorage, so the tests hand it a fake store -- a Map
// wrapped in the same getItem/setItem/removeItem shape -- and swap it in and
// out of globalThis.window around each test.
//
// Run with: node --test ui/src/reportedOnce.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { countedOnce, forgetCounted } from "./reportedOnce.mjs";

/** A working localStorage backed by a Map, or one that throws on demand. */
function fakeStorage({ failRead = false, failWrite = false, initial } = {}) {
  const store = new Map();
  if (initial !== undefined) store.set("persodub.countedJobs", initial);
  return {
    store,
    getItem: (k) => {
      if (failRead) throw new Error("read blocked");
      return store.has(k) ? store.get(k) : null;
    },
    setItem: (k, v) => {
      if (failWrite) throw new Error("write blocked");
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  };
}

function withWindow(storage, fn) {
  const real = globalThis.window;
  globalThis.window = { localStorage: storage };
  try {
    return fn();
  } finally {
    globalThis.window = real;
  }
}

test("first call for a job is false, the next is true", () => {
  withWindow(fakeStorage(), () => {
    assert.equal(countedOnce("abc123"), false);
    assert.equal(countedOnce("abc123"), true);
    assert.equal(countedOnce("abc123"), true);
  });
});

test("different ids are counted independently", () => {
  withWindow(fakeStorage(), () => {
    assert.equal(countedOnce("job-a"), false);
    assert.equal(countedOnce("job-b"), false);
    assert.equal(countedOnce("job-a"), true);
    assert.equal(countedOnce("job-b"), true);
  });
});

test("no id, or a non-string id, is never counted and stores nothing", () => {
  withWindow(fakeStorage(), () => {
    assert.equal(countedOnce(undefined), false);
    assert.equal(countedOnce(""), false);
    assert.equal(countedOnce(null), false);
    assert.equal(countedOnce(42), false);
    assert.equal(countedOnce(undefined), false);
  });
});

test("past 400 ids the oldest falls off the front", () => {
  withWindow(fakeStorage(), () => {
    for (let i = 0; i <= 400; i += 1) countedOnce(`job-${i}`);
    // 401 ids went in; the bound is 400, so the first one out is the first
    // one dropped.
    assert.equal(countedOnce("job-0"), false);
    // The most recent 400 (job-1..job-400) are still remembered.
    assert.equal(countedOnce("job-400"), true);
  });
});

test("storage that throws on read still answers false, and does not throw", () => {
  withWindow(fakeStorage({ failRead: true }), () => {
    assert.doesNotThrow(() => {
      assert.equal(countedOnce("abc123"), false);
    });
  });
});

test("storage that throws on write still answers false, and does not throw", () => {
  const storage = fakeStorage({ failWrite: true });
  withWindow(storage, () => {
    assert.doesNotThrow(() => {
      assert.equal(countedOnce("abc123"), false);
    });
    // The write never landed, so the same job is "not counted" again too --
    // the safe direction to fail in is a duplicate, never a silent loss.
    assert.equal(countedOnce("abc123"), false);
  });
});

test("corrupted JSON in storage reads as empty, not a thrown error", () => {
  withWindow(fakeStorage({ initial: "{not json" }), () => {
    assert.equal(countedOnce("abc123"), false);
    assert.equal(countedOnce("abc123"), true);
  });
});

test("a stored value that is not an array reads as empty", () => {
  withWindow(fakeStorage({ initial: JSON.stringify({ not: "a list" }) }), () => {
    assert.equal(countedOnce("abc123"), false);
  });
});

test("forgetCounted clears the store", () => {
  withWindow(fakeStorage(), () => {
    countedOnce("abc123");
    assert.equal(countedOnce("abc123"), true);
    forgetCounted();
    assert.equal(countedOnce("abc123"), false);
  });
});
