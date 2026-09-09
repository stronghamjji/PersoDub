import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./exec.js";
import { extractTarGz, tarBinary } from "./extract.js";

test("extracts a tar.gz preserving structure", async () => {
  const work = mkdtempSync(join(tmpdir(), "odtar-"));
  mkdirSync(join(work, "python", "bin"), { recursive: true });
  writeFileSync(join(work, "python", "bin", "marker"), "hi");
  const tarball = join(work, "p.tar.gz");
  await run(["tar", "-czf", tarball, "-C", work, "python"]);
  const dest = join(work, "out");
  await extractTarGz(tarball, dest);
  assert.ok(existsSync(join(dest, "python", "bin", "marker")));
});


// GitHub's source archives wrap everything in one folder named for the
// commit (video-subtitle-remover-<sha>/). The eraser pack's step asks for it
// to be stripped, so the kit gets eraser/vsr/backend, not one folder deeper.
test("strip drops the archive's own top folder", async () => {
  const work = mkdtempSync(join(tmpdir(), "odtar-"));
  mkdirSync(join(work, "tool-abc123", "backend"), { recursive: true });
  writeFileSync(join(work, "tool-abc123", "backend", "main.py"), "hi");
  const tarball = join(work, "src.tar.gz");
  await run(["tar", "-czf", tarball, "-C", work, "tool-abc123"]);
  const dest = join(work, "vsr");
  await extractTarGz(tarball, dest, { strip: 1 });
  assert.ok(existsSync(join(dest, "backend", "main.py")));
  assert.equal(existsSync(join(dest, "tool-abc123")), false);
});

test("on Windows the system's own tar is called by its full path, elsewhere plain tar", () => {
  const env = { SystemRoot: "C:\\Windows" };
  assert.equal(tarBinary({ platform: "win32", env, exists: () => true }), "C:\\Windows\\System32\\tar.exe");
  assert.equal(tarBinary({ platform: "win32", env, exists: () => false }), "tar", "no system tar: fall back");
  assert.equal(tarBinary({ platform: "darwin", env, exists: () => true }), "tar");
});
