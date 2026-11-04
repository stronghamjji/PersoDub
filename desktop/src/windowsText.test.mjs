import { test } from "node:test";
import assert from "node:assert/strict";
import { readWindowsText } from "./windowsText.js";

// What node hands over: the code page's bytes, one character per byte.
const asNodeReadsIt = (hex) => Buffer.from(hex, "hex").toString("latin1");

test("a Windows message in the computer's own language reads as its real characters", () => {
  // "액세스가 거부되었습니다" in code page 949, "アクセスが拒否されました" in 932,
  // "Отказано в доступе" in 1251 -- the bytes Windows gives on those machines.
  const ko = asNodeReadsIt("bed7bcbcbdbab0a120b0c5baceb5c7befabdc0b4cfb4d9");
  assert.equal(ko, "¾×¼¼½º°¡ °ÅºÎµÇ¾ú½À´Ï´Ù");
  assert.equal(readWindowsText(ko, 949), "액세스가 거부되었습니다");
  assert.equal(readWindowsText(asNodeReadsIt("8341834e835a835882aa8b9194db82b382ea82dc82b582bd"), 932), "アクセスが拒否されました");
  assert.equal(readWindowsText(asNodeReadsIt("cef2eae0e7e0edee20e220e4eef1f2f3efe5"), 1251), "Отказано в доступе");
  // The code and path around it come through with it.
  assert.equal(readWindowsText(`EIO, ${ko}. 'D:\\k\\app'`, 949), "EIO, 액세스가 거부되었습니다. 'D:\\k\\app'");
});

test("text that is not that code page's bytes is left alone", () => {
  assert.equal(readWindowsText("EACCES, Permission denied 'D:\\k\\app'", 949), "EACCES, Permission denied 'D:\\k\\app'");
  assert.equal(readWindowsText("EIO, 액세스가 거부되었습니다", 949), "EIO, 액세스가 거부되었습니다");
  assert.equal(readWindowsText("Accès refusé 'C:\\x'", 1252), "Accès refusé 'C:\\x'");
  assert.equal(readWindowsText("open 'C:\\Users\\Zoé\\a'", 949), "open 'C:\\Users\\Zoé\\a'");
  assert.equal(readWindowsText("¾×¼¼", 0), "¾×¼¼");
});
