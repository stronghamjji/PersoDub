// Rewrites one message in electron-builder's NSIS catalog before makensis
// runs. The stock appCannotBeClosed text ("${PRODUCT_NAME} cannot be closed.
// Please close it manually and click Retry...") is shown when the old-version
// uninstaller cannot rename a file in the install dir -- which happens when
// ANOTHER program (editor, antivirus, backup tool) holds the file open, not
// because the app is still running. The wording sends users hunting for an
// app that already quit, with no way to discover the actual fix.
//
// Why not override the LangString from build/installer.nsh: electron-builder
// assembles the generated message catalog and the custom include
// concurrently, so their order in the final script -- and therefore which
// LangString definition wins -- is a race (observed both ways in real
// builds). Editing the catalog itself has no ordering to lose.
//
// Runs as a build step (see dist:win in package.json), so a fresh npm ci
// (CI included) is patched before every build. Idempotent.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Exact text that lands between the quotes in messages.yml. \n (a literal
// backslash-n in the YAML double-quoted scalar) becomes the dialog's line
// break, matching how the stock strings are written.
export const EN_TEXT =
  'A file in the ${PRODUCT_NAME} installation folder is in use by another program (such as an editor, antivirus, or backup tool). \\nClose those programs and click Retry, or restart your computer and run the installer again.';
export const KO_TEXT =
  '다른 프로그램(편집기, 백신, 백업 도구 등)이 ${PRODUCT_NAME} 설치 폴더의 파일을 사용 중입니다. \\n해당 프로그램을 닫고 다시 시도를 누르거나, 컴퓨터를 다시 시작한 뒤 설치를 다시 실행하세요.';

// Replaces the whole appCannotBeClosed block: the stock translations describe
// the wrong cause, and a translated wrong explanation is still wrong. Every
// language not listed here falls back to the English text (nsisLang.js does
// that for any unspecified language).
export function patchMessages(text) {
  const block = /^appCannotBeClosed:\r?\n(?:[ \t]+.*\r?\n?)*/m;
  if (!block.test(text)) {
    throw new Error("appCannotBeClosed block not found in messages.yml -- did an electron-builder upgrade change the catalog?");
  }
  const replacement = `appCannotBeClosed:\n  en: "${EN_TEXT}"\n  ko: "${KO_TEXT}"\n`;
  // Replacement via function: a plain string here would let "$" sequences in
  // the text be interpreted as replace() patterns.
  return text.replace(block, () => replacement);
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`)) === SELF) {
  const target = join(dirname(dirname(SELF)), "node_modules", "app-builder-lib", "templates", "nsis", "messages.yml");
  const before = readFileSync(target, "utf8");
  const after = patchMessages(before);
  if (after === before) {
    console.log("nsis messages: appCannotBeClosed already patched");
  } else {
    writeFileSync(target, after);
    console.log("nsis messages: appCannotBeClosed patched");
  }
}
