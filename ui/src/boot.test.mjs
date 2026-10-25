// The page's own start-up, run for real: static/index.html's inline
// <script type="module"> blocks, with every ui/src module they import, run
// from top to bottom against the stand-in browser in ui/testlib/stubDom.mjs.
// The first block only imports the page's script, ui/src/app.mjs; its import
// is pointed at the real file like every other, so what runs is the module
// chain the browser runs, and a stack names ui/src/app.mjs by its own lines.
//
// indexHtml.test.mjs and ui/check-inline.mjs only prove that code PARSES
// (node --check runs no line of it). A missing export, a name used before
// its `const` line, a call on an element the markup does not have -- each of
// those parses fine and leaves every button on the page dead. Here they fail.
//
// What the run sees is the page before the server has answered anything
// (fetch never answers), in a plain browser (no desktop shell), on a first
// launch (empty localStorage) -- the path through openLastScreen() to Home.
//
// Run with: node --test ui/src/boot.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installStubDom } from "../testlib/stubDom.mjs";

const INDEX = fileURLToPath(new URL("../../static/index.html", import.meta.url));
const SRC = fileURLToPath(new URL("./", import.meta.url));

// The ids looked up at load that are not in the markup: ui/src/importBlock.mjs
// draws them (importBlockHtml / emptyTabHtml) over a slot each caller replaces.
const DRAWN_AT_LOAD = [
  "newProjDrop", "newProjLinkRow", "newProjLinkInput",   // newProjectWindow.mjs
  "dubbingZone", "dubbingLinkRow", "dubbingLinkInput",   // draftImport.mjs
  "saveZone", "saveLinkRow", "saveLinkInput",            // draftImport.mjs
  "eraseZone", "eraseLinkRow", "eraseLinkInput",         // eraseScreen.mjs
  "capZone", "capLinkRow", "capLinkInput",               // captionsTab.mjs
];

// Each inline module with the line its <script> tag is on.
function inlineModules(html) {
  return [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
    .map((m) => ({ code: m[1], line: html.slice(0, m.index).split("\n").length }));
}

// The page imports ui/src/x.mjs as "/js/x.mjs" (app/main.py page_module); a
// file in a temp folder reaches the same file by its own absolute URL.
function pointAtSource(code) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])\/js\/([\w-]+\.mjs)\2/g,
    (m, head, quote, name) => head + JSON.stringify(pathToFileURL(join(SRC, name)).href));
}

// Runs the blocks in page order, then gives what they started 300 ms to go
// wrong. Everything that does is collected rather than thrown, so one run
// answers every test below.
async function bootPage() {
  const html = readFileSync(INDEX, "utf8");
  const blocks = inlineModules(html);
  // The real path: a stack names the file the way the loader resolved it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "persodub-boot-")));
  const files = blocks.map((b, i) => join(dir, `index-block-${i + 1}.mjs`));
  const tidy = (err) => files.reduce((text, file) => text
    .replaceAll(pathToFileURL(file).href, "static/index.html")
    .replaceAll(file, "static/index.html"), String(err?.stack ?? err));

  const thrown = [];
  const rejected = [];
  const onThrow = (err) => thrown.push(err);
  const onReject = (reason) => rejected.push(reason);
  const page = installStubDom(html);
  let screen;
  process.on("uncaughtException", onThrow);
  process.on("unhandledRejection", onReject);
  try {
    for (const [i, { code, line }] of blocks.entries()) {
      // Padded so that line N of the file is line N of static/index.html.
      writeFileSync(files[i], "\n".repeat(line - 1) + pointAtSource(code));
      try {
        await import(pathToFileURL(files[i]).href);
      } catch (err) {
        thrown.push(err);
      }
    }
    await sleep(300);
    // Where the start-up left the page: its last line is openLastScreen().
    screen = globalThis.document.body.dataset.screen;
  } finally {
    page.restore();
    process.off("uncaughtException", onThrow);
    process.off("unhandledRejection", onReject);
    rmSync(dir, { recursive: true, force: true });
  }
  return { blocks, page, screen, thrown: [...thrown, ...page.errors].map(tidy), rejected: rejected.map(tidy) };
}

const boot = await bootPage();
const unique = (ids) => [...new Set(ids)];

test("the page's inline modules run to the end at load without throwing", () => {
  // Were the tag ever written differently, nothing would run and nothing fail.
  assert.ok(boot.blocks.length >= 2, `expected the page's inline modules, found ${boot.blocks.length}`);
  if (boot.thrown.length) {
    assert.fail(`the page threw while loading (each stack names its file: static/index.html, or a module in ui/src):\n\n${boot.thrown.join("\n\n")}`);
  }
});

test("nothing the page starts at load ends in an unhandled rejection", () => {
  if (boot.rejected.length) {
    assert.fail(`unhandled rejection after load (each stack names its file: static/index.html, or a module in ui/src):\n\n${boot.rejected.join("\n\n")}`);
  }
});

// The script is a file of its own (ui/src/app.mjs): a loader block that no
// longer reached it, or a run that stopped half way through it, ends here.
// Its last line is openLastScreen(), and a first launch has nothing to go
// back to, so the page it leaves is Home.
test("the start-up runs through ui/src/app.mjs to its last line, which opens Home",
  { skip: boot.thrown.length > 0 && "the page threw while loading" }, () => {
    assert.equal(boot.screen, "home");
  });

test("every id the page looks up at load is in the markup, or one the Import block draws", () => {
  const strays = unique(boot.page.lookedUp)
    .filter((id) => !boot.page.markupIds.has(id) && !DRAWN_AT_LOAD.includes(id));
  if (strays.length) {
    assert.fail(`no element in static/index.html has these ids, yet the page looks them up at load: ${strays.join(", ")}`);
  }
});

// Stricter than the test above: also the ORDER. An Import block wired before
// it is drawn finds nothing, and wireImportBlock returns quietly -- the block
// is on screen and dead to clicks, drops and pastes.
test("every element the page looks up at load is there by the time it is asked for", () => {
  const missed = unique(boot.page.missed);
  if (missed.length) {
    assert.fail(`getElementById answered null at load for: ${missed.join(", ")}`);
  }
});

// Keeps the list honest. Only a page that got to the end has drawn them all.
test("each id listed as drawn at load is drawn at load, and is not in the markup",
  { skip: boot.thrown.length > 0 && "the page threw while loading" }, () => {
    for (const id of DRAWN_AT_LOAD) {
      assert.ok(boot.page.createdIds.has(id),
        `${id} was not drawn at load: its slot is missing, or it is gone for good and leaves DRAWN_AT_LOAD`);
      assert.ok(!boot.page.markupIds.has(id), `${id} is in the markup now: take it off DRAWN_AT_LOAD`);
    }
  });
