import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKitVersion, resolveCampplusSrc } from "../scripts/collect-payload.mjs";

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
