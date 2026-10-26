// Build-time payload collector: gathers everything the installer needs into
// resources/payload/ so electron-builder can bundle it as extraResources.
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { EDITIONS, BUILD_ENV, BUILD_KEYS, PRODUCTION_UPDATE_URL, buildEdition, buildEnvText } from "../src/edition.js";

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

// `--edition <name>` (or `--edition=<name>`) on the command line, which wins
// over PERSODUB_EDITION in the environment: package.json's dist:*:prod
// scripts pass it, so a production build never depends on how the shell sets
// a variable. Undefined when not given; a flag without a name stops the build.
export function editionFromArgs(args) {
  for (const [i, arg] of args.entries()) {
    let name;
    if (arg === "--edition") name = args[i + 1];
    else if (arg.startsWith("--edition=")) name = arg.slice("--edition=".length);
    else continue;
    if (!name || name.startsWith("--")) throw new Error("--edition needs a name: opensource or production.");
    return name;
  }
  return undefined;
}

function main() {
  const campplusSrc = resolveCampplusSrc(process.env);
  // Checked before the old payload is deleted: an unknown edition stops the
  // build here.
  const named = editionFromArgs(process.argv.slice(2));
  const edition = buildEdition(named === undefined ? process.env : { ...process.env, PERSODUB_EDITION: named });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "app-repo"), { recursive: true });

  for (const item of ["app", "static", "ui", "requirements.txt"]) {
    cpSync(join(REPO, item), join(OUT, "app-repo", item), {
      recursive: true,
      filter: (src) => !src.includes("__pycache__"),
    });
  }
  cpSync(join(DESKTOP, "vendor"), join(OUT, "kit-src"), { recursive: true });

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
  // EDITION carries the edition into the packaged app, where the environment
  // it runs in cannot change it (src/edition.js readEdition).
  writeFileSync(join(OUT, "EDITION"), edition);
  console.log(`payload: ${edition} edition, ${EDITIONS[edition] || "no repository"}`);
  // The production build's support web app, from this command's environment
  // (src/edition.js BUILD_KEYS): one built without PERSODUB_INQUIRY_URL cannot
  // send Customer support's inquiries. Its update address is in the code
  // (src/edition.js PRODUCTION_UPDATE_URL), and without one it never checks.
  const built = buildEnvText(edition, process.env);
  if (built) writeFileSync(join(OUT, BUILD_ENV), built);
  if (edition === "production") {
    for (const k of BUILD_KEYS) console.log(`payload: ${k} ${process.env[k] ? "set" : "NOT set"}`);
    console.log(`payload: PRODUCTION_UPDATE_URL ${PRODUCTION_UPDATE_URL ? "set" : "NOT set: no update checks"}`);
  }

  console.log(`payload ready at ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
