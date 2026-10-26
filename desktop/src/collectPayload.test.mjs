import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKitVersion, editionFromArgs, resolveCampplusSrc } from "../scripts/collect-payload.mjs";

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

test("--edition on the command line names the edition, in either spelling, and a bare flag stops the build", () => {
  assert.equal(editionFromArgs([]), undefined, "not given: the environment's PERSODUB_EDITION");
  assert.equal(editionFromArgs(["--edition", "production"]), "production");
  assert.equal(editionFromArgs(["--edition=opensource"]), "opensource");
  for (const bare of [["--edition"], ["--edition", "--other"], ["--edition="]]) {
    assert.throws(() => editionFromArgs(bare), /--edition needs a name/, JSON.stringify(bare));
  }
});
