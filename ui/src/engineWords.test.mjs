// The engine's sentences the page says in its own language at the display
// edge. The engine keeps them in English on purpose -- the page knows a
// refusal by its words (app.mjs serverText), the Dub Agent's step labels and
// error lines come from app/agents/ -- so the scanner in i18n.test.mjs never
// sees them as t("...") literals, and their keys are added to the tables by
// hand. This holds each one to both tables and to the engine still saying it:
// a reworded sentence in app/ would otherwise leave its key behind, and the
// screen back in English, without a word.
//
// Run with: node --test ui/src/engineWords.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setLanguage, loadTable } from "./i18n.mjs";
import { errorText, serverText } from "./format.mjs";
import { chipText } from "./agentStrip.mjs";
import { resetsSentence } from "./translatorChoice.mjs";
import { retryLine } from "./modelsDialog.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const table = (code) => JSON.parse(readFileSync(`${ROOT}static/i18n/ui.${code}.json`, "utf8"));

const ENGINE_SENTENCES = [
  // Refusals the page knows by their words (app/api/_launch.py,
  // app/engines_status.py, app/api/dub.py, app/api/separate.py, app/api/script.py).
  "Select a Perso workspace in Settings.",
  "ChatGPT translation needs a ChatGPT sign-in. Open Settings and press Sign in with ChatGPT first.",
  "The voice engine is not running because it could not start, so this computer cannot dub. Quit and reopen {app}, or use the Perso API.",
  "The voice engine is not running: this computer ran out of memory. Close other programs, then press Start dubbing and it will start again. Dubbing with the Perso API uses almost no memory.",
  "The voice engine is not running. Quit and reopen {app}.",
  "Perso separation needs an API key. Open Settings and save your Perso API key, or choose Local model.",
  "Sign in to ChatGPT first.",
  "ChatGPT usage limit reached for now. Try again after it resets.",
  // The models dialog's refusal for a pack, which the desktop app installs (app/models.py).
  "PersoDub installs this itself.",
  // The Dub Agent's step labels (app/agents/claude.py TOOL_LABELS, app/agents/codex.py).
  "Reading the script", "Rewriting a line", "Checking the timing", "Exporting the script",
  "Checking progress", "Remaking the changed voices", "Remaking this line", "Translating again",
  "Redoing every line with Perso", "Changing the speaker", "Extracting subtitles", "Cutting a clip",
  "Looking through a folder", "Queueing dubbing", "Cancelling dubbing", "Subtitling a video",
  "Checking what is running", "Reading the setup", "Changing a default", "Offering a download",
  "Downloading a video", "Erasing subtitles", "Saving the erased video", "Running a command",
  "Reconnecting…",
  // Its error lines (app/agents/base.py, claude.py, codex.py).
  "The assistant stopped partway. Please try again.",
  "The assistant stopped before finishing.",
  "Usage limit reached. Wait a while or pick another assistant.",
  "Codex is not signed in. Press Sign in above.",
  "Claude is not signed in. Press Sign in above.",
  "The assistant is not signed in.",
  "This model isn't available on your plan. Pick another one.",
];
// What chipText cuts a label down to before it adds the line numbers.
const STEMS = ["Rewriting", "Remaking"];

// Every .py under app/, with Python's "a" "b" joins across lines undone, so a
// sentence the engine wraps over two lines is still found whole.
function engineSource() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".py")) files.push(path);
    }
  };
  walk(join(ROOT, "app"));
  return files.map((f) => readFileSync(f, "utf8").replace(/"\s*\n\s*(?:f|r)?"/g, "")).join("\n");
}

test("each engine sentence the page translates is in both tables, and the engine still says it", () => {
  const en = table("en"), ko = table("ko");
  const said = engineSource();
  for (const s of [...ENGINE_SENTENCES, ...STEMS]) {
    assert.ok(Object.hasOwn(en, s), `missing from ui.en.json: ${s}`);
    assert.ok(Object.hasOwn(ko, s) && ko[s] !== s, `missing from ui.ko.json: ${s}`);
  }
  for (const s of ENGINE_SENTENCES) assert.ok(said.includes(s), `app/ no longer says: ${s}`);
});

test("errorText says the engine's English refusal in Korean; serverText keeps it for the code that matches it", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => table("ko") });
  t.after(() => { globalThis.fetch = real; setLanguage("en"); });
  await loadTable("ko");
  setLanguage("ko");
  const refused = new Error(JSON.stringify({ detail: "Select a Perso workspace in Settings." }));
  assert.equal(serverText(refused), "Select a Perso workspace in Settings.");
  assert.equal(errorText(refused), table("ko")["Select a Perso workspace in Settings."]);
  // A sentence the engine already said in Korean reads as it came.
  assert.equal(errorText(new Error(JSON.stringify({ detail: "이미 한국어예요." }))), "이미 한국어예요.");
  // The Dub Agent's steps: the whole label, or its cut-down stem with the lines.
  assert.equal(chipText("Rewriting a line", []), "줄 고쳐 쓰는 중");
  assert.equal(chipText("Rewriting a line", [3]), "고쳐 쓰는 중 (3번 줄)");
  // Sentences with a value in them, read out of the English and said again.
  assert.equal(resetsSentence("ChatGPT usage limit reached. Resets Oct 24, 1:07 PM. Resume then."),
    "10월 24일 오후 1:07에 다시 쓸 수 있어요.");
  assert.equal(resetsSentence("ChatGPT usage limit reached. Resets 9:05 AM. Resume then."),
    "오전 9:05에 다시 쓸 수 있어요.");
  assert.equal(resetsSentence("ChatGPT usage limit reached. Resets tomorrow. Resume then."),
    "tomorrow에 다시 쓸 수 있어요.", "a time it cannot read is left as it came");
  assert.equal(retryLine("Connection problem, retrying (2/3)"), "연결이 끊겨 다시 시도하는 중 (2/3)");
  assert.equal(retryLine("Downloading"), "Downloading", "anything else is left as it came");
});
