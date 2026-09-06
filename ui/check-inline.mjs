#!/usr/bin/env node
// CI guard for static/index.html's inline `<script type="module">` blocks: a
// syntax error inside one of them is invisible to `node --test ui/src/*.test.mjs`
// (that suite only runs the extracted ui/src/*.mjs modules), and a bad edit to
// the inline script only surfaces when a person opens the app in a browser.
// This extracts each inline module block, writes it to a temp file, and runs
// `node --check` on it so CI catches the syntax error instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, "..", "static", "index.html");
const html = fs.readFileSync(htmlPath, "utf-8");

const blocks = [...html.matchAll(/<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/g)];

if (blocks.length === 0) {
  console.error(`No <script type="module"> blocks found in ${htmlPath}`);
  process.exit(1);
}

let failed = false;
for (let i = 0; i < blocks.length; i++) {
  const body = blocks[i][1];
  const tmpFile = path.join(os.tmpdir(), `persodub-inline-${i}-${process.pid}.mjs`);
  fs.writeFileSync(tmpFile, body);
  try {
    execFileSync(process.execPath, ["--check", tmpFile], { stdio: "pipe" });
  } catch (err) {
    failed = true;
    console.error(`Inline module block ${i} in ${htmlPath} failed node --check:`);
    console.error(err.stderr ? err.stderr.toString() : err.message);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`${blocks.length} inline module block(s) in ${htmlPath} parse OK.`);
