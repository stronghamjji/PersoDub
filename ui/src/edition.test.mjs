import { test } from "node:test";
import assert from "node:assert/strict";
import { isProduction, productName, feedbackSubject, feedbackMailto, DESKTOP_APP_URL } from "./edition.mjs";

test("the page is the production edition only when the shell says so", () => {
  assert.equal(isProduction({ edition: "production" }), true);
  assert.equal(isProduction({ edition: "opensource" }), false);
  assert.equal(isProduction({ edition: "" }), false);
  assert.equal(isProduction(undefined), false, "a plain browser is the open-source page");
});

test("the production edition is called Perso_DesktopApp, the open-source one PersoDub", () => {
  assert.equal(productName({ edition: "production" }), "Perso_DesktopApp");
  assert.equal(productName({ edition: "opensource" }), "PersoDub");
  assert.equal(productName(undefined), "PersoDub");
});

test("the feedback mail names the app, its version and the computer, and has no body", () => {
  const subject = feedbackSubject("0.9.1", "macOS 15.1.0");
  assert.equal(subject, "Perso_DesktopApp 0.9.1 · macOS 15.1.0 · 의견/Feedback");
  const link = feedbackMailto("team@example.com", subject);
  assert.equal(link, `mailto:team@example.com?subject=${encodeURIComponent(subject)}`);
  assert.ok(!link.includes("body="));
});

test("the production links go to Perso's desktop app page", () => {
  assert.equal(DESKTOP_APP_URL, "https://perso.ai/dubbing/desktop-app");
});
