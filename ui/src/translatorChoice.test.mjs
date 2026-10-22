// Which translators the ChatGPT popup offers, and the reset time it repeats.
//
// Run with: node --test ui/src/translatorChoice.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { translatorChoices, resetsSentence, withTranslator } from "./translatorChoice.mjs";

const READY_ROWS = [
  { id: "ollama-runtime", state: "ready", bytes: 300000000 },
  { id: "hunyuan", state: "ready", bytes: 1100000000 },
  { id: "gemma", state: "ready", bytes: 7600000000 },
];

test("every translator that runs now is offered by name, best first, ChatGPT never", () => {
  const engines = { hunyuan_available: true, gemma_available: true, gemini_available: true };
  assert.deepEqual(translatorChoices("chatgpt", engines, READY_ROWS), [
    { id: "hunyuan", label: "Continue with Hunyuan" },
    { id: "gemma", label: "Continue with Gemma" },
    { id: "gemini", label: "Continue with Gemini" },
  ]);
});

test("Gemini is offered only with a key saved", () => {
  const engines = { hunyuan_available: true, gemma_available: false, gemini_available: false };
  assert.deepEqual(translatorChoices("chatgpt", engines, READY_ROWS).map((c) => c.id), ["hunyuan"]);
});

test("a local translator not downloaded yet is offered with its size", () => {
  const rows = [
    { id: "ollama-runtime", state: "ready", bytes: 300000000 },
    { id: "hunyuan", state: "missing", bytes: 1100000000 },
    { id: "gemma", state: "paused", bytes: 7600000000 },
  ];
  assert.deepEqual(translatorChoices("chatgpt", {}, rows), [
    { id: "hunyuan", label: "Continue with Hunyuan (1.1 GB)" },
    { id: "gemma", label: "Continue with Gemma (7.6 GB)" },
  ]);
});

test("on a computer without the translation runtime the size counts it too", () => {
  const rows = [
    { id: "ollama-runtime", state: "missing", bytes: 300000000 },
    { id: "hunyuan", state: "missing", bytes: 1100000000 },
  ];
  assert.deepEqual(translatorChoices("chatgpt", {}, rows),
    [{ id: "hunyuan", label: "Continue with Hunyuan (1.4 GB)" }]);
});

test("a model that is here but cannot run right now is left out", () => {
  // Downloaded, but the runtime is down: /api/engines says not available.
  assert.deepEqual(translatorChoices("chatgpt", { gemma_available: false }, READY_ROWS), []);
});

test("the translator that stopped is not offered back", () => {
  const engines = { hunyuan_available: true, gemma_available: true };
  assert.deepEqual(translatorChoices("hunyuan", engines, READY_ROWS).map((c) => c.id), ["gemma"]);
});

test("nothing from the server offers nothing", () => {
  assert.deepEqual(translatorChoices("chatgpt", null, null), []);
});

test("the reset time comes out of the notice, or nothing", () => {
  assert.equal(resetsSentence("ChatGPT usage limit reached. Resets Oct 24, 1:07 PM. "
    + "Resume then, or continue with another translator."), "Resets Oct 24, 1:07 PM.");
  assert.equal(resetsSentence("ChatGPT usage limit reached for now."), "");
  assert.equal(resetsSentence(undefined), "");
});

test("a translator's name for the screen, or nothing for one it does not know", () => {
  assert.equal(withTranslator("chatgpt"), "with ChatGPT");
  assert.equal(withTranslator("hunyuan"), "with Hunyuan");
  assert.equal(withTranslator("perso"), "with Perso");
  assert.equal(withTranslator(undefined), "");
});
