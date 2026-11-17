import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKitVersion, resolveCampplusSrc, shipped } from "../scripts/collect-payload.mjs";

test("buildKitVersion combines the package version and git short sha", () => {
  assert.equal(buildKitVersion("0.1.0", "abc1234"), "0.1.0+abc1234");
});

test("buildKitVersion falls back to the version alone when git is unavailable", () => {
  assert.equal(buildKitVersion("0.1.0", null), "0.1.0");
});

test("resolveCampplusSrc returns the env var value when set", () => {
  assert.equal(resolveCampplusSrc({ CAMPPLUS_SRC: "/models/campplus.onnx" }), "/models/campplus.onnx");
});

test("resolveCampplusSrc throws when CAMPPLUS_SRC is not set", () => {
  assert.throws(() => resolveCampplusSrc({}), /CAMPPLUS_SRC is not set/);
});

test("the payload leaves out the tests and their helpers, in either slash, and keeps the app", () => {
  for (const rel of ["ui/src/app.mjs", "ui/src", "ui", "static/index.html", "app/main.py", "requirements.txt"]) {
    assert.equal(shipped(rel), true, rel);
  }
  for (const rel of ["ui/src/app.test.mjs", "ui\\src\\app.test.mjs", "ui/testlib", "ui/testlib/stubDom.mjs",
                     "ui\\testlib", "ui/check-inline.mjs", "app/__pycache__", "app/__pycache__/x.pyc"]) {
    assert.equal(shipped(rel), false, rel);
  }
});
