// Build-time payload collector: gathers everything the installer needs into
// resources/payload/ so electron-builder can bundle it as extraResources.
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BUILD_ENV, BUILD_KEYS, buildEnvText } from "../src/edition.js";

const DESKTOP = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(DESKTOP);
const OUT = join(DESKTOP, "resources", "payload");
// CAMPPLUS_SRC has no default: the CAM++ model file is not in this repo, so
// the packager must point at their own copy.
export function resolveCampplusSrc(env) {
  if (!env.CAMPPLUS_SRC) {
    throw new Error("CAMPPLUS_SRC is not set. Set it to the path of your campplus.onnx before packaging.");
  }
  return env.CAMPPLUS_SRC;
}

// KIT_VERSION lets the installed kit be compared against the app's own
// bundled payload (see engineCheck.checkKit) -- falls back to the bare
// version when git isn't available; never fails the build over it.
export function buildKitVersion(version, gitSha) {
  return gitSha ? `${version}+${gitSha}` : version;
}

// What of the app goes in the payload: not the tests beside the code nor their
// helpers, which app.asar leaves out too (electron-builder.js, 1.0.1). `rel` is
// the path under the repo, in either slash.
export function shipped(rel) {
  const p = rel.split("\\").join("/");
  return !p.includes("__pycache__") && !p.endsWith(".test.mjs")
    && !/^ui\/(testlib|check-inline\.mjs)(\/|$)/.test(p);
}

function main() {
  const campplusSrc = resolveCampplusSrc(process.env);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "app-repo"), { recursive: true });

  for (const item of ["app", "static", "ui", "requirements.txt"]) {
    cpSync(join(REPO, item), join(OUT, "app-repo", item), {
      recursive: true,
      filter: (src) => shipped(relative(REPO, src)),
    });
  }
  // The sidecars' own tests stay with the repo, like the app's do.
  cpSync(join(DESKTOP, "vendor"), join(OUT, "kit-src"), { recursive: true, filter: (src) => !basename(src).startsWith("test_") });

  if (existsSync(campplusSrc)) {
    cpSync(campplusSrc, join(OUT, "campplus.onnx"));
    console.log("payload: campplus.onnx bundled");
  } else {
    console.warn(`payload: campplus.onnx NOT found at ${campplusSrc} — bundling without it`);
  }

  const { version } = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
  let gitSha;
  try {
    gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO }).toString().trim();
  } catch {
    gitSha = null;
  }
  writeFileSync(join(OUT, "KIT_VERSION"), buildKitVersion(version, gitSha));
  // The support web app, from this command's environment (src/edition.js
  // BUILD_KEYS): a build without PERSODUB_INQUIRY_URL cannot send an inquiry,
  // and sends Send feedback to the issues page instead.
  const built = buildEnvText(process.env);
  if (built) writeFileSync(join(OUT, BUILD_ENV), built);
  for (const k of BUILD_KEYS) console.log(`payload: ${k} ${process.env[k] ? "set" : "NOT set"}`);

  console.log(`payload ready at ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
