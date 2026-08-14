// Build-time patch for electron-builder's NSIS message catalog. The stock
// appCannotBeClosed text ("PersoDub cannot be closed...") blames the app when
// the real cause is another program holding a file in the install folder open.
// Overriding the LangString from build/installer.nsh is unreliable -- the
// custom include and the generated message catalog are assembled concurrently,
// so which definition lands last (and wins) is a race. Rewriting messages.yml
// itself before makensis runs has no such race. Pure text-in/text-out function
// so it tests without touching node_modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { patchMessages, EN_TEXT, KO_TEXT } from "../scripts/patch-nsis-messages.mjs";

const SAMPLE = `appRunning:
  en: "\${PRODUCT_NAME} is running.\\nClick OK to close it."
  ko: "\${PRODUCT_NAME}이(가) 실행 중입니다."
appCannotBeClosed:
  en: "\${PRODUCT_NAME} cannot be closed. \\nPlease close it manually and click Retry to continue."
  ar: "old arabic text"
  bn: "old bengali text"
decompressionFailed:
  en: "Failed to decompress files."
`;

test("replaces the whole appCannotBeClosed block with accurate en and ko text", () => {
  const patched = patchMessages(SAMPLE);
  assert.ok(patched.includes(`appCannotBeClosed:\n  en: "${EN_TEXT}"\n  ko: "${KO_TEXT}"\n`));
  // The old translations of the wrong message go away with it -- a translated
  // wrong explanation is still a wrong explanation.
  assert.ok(!patched.includes("old arabic text"));
  assert.ok(!patched.includes("old bengali text"));
  assert.ok(!patched.includes("cannot be closed"));
});

test("leaves every other message block untouched", () => {
  const patched = patchMessages(SAMPLE);
  assert.ok(patched.startsWith("appRunning:\n"));
  assert.ok(patched.includes("appRunning:\n  en: \"${PRODUCT_NAME} is running."));
  assert.ok(patched.includes("decompressionFailed:\n  en: \"Failed to decompress files.\"\n"));
});

test("is idempotent -- patching twice equals patching once", () => {
  const once = patchMessages(SAMPLE);
  assert.equal(patchMessages(once), once);
});

test("throws when the block it must replace is missing", () => {
  // A silent no-op here would ship the misleading dialog again without anyone
  // noticing -- fail the build loudly instead (e.g. after an electron-builder
  // upgrade renames the key).
  assert.throws(() => patchMessages("somethingElse:\n  en: \"x\"\n"), /appCannotBeClosed/);
});
