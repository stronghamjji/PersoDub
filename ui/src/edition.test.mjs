import { test } from "node:test";
import assert from "node:assert/strict";
import { isProduction, productName, feedbackSubject, feedbackMailto, persoLink, DESKTOP_APP_URL } from "./edition.mjs";

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

// Every link into Perso says which app, version and button it came from.
test("persoLink puts the app's utm tail and the button on a Perso link, or leaves it bare without a tail", () => {
  const utm = "utm_source=persodub-mac&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1";
  assert.equal(persoLink("https://perso.ai/dubbing/desktop-app", "help", utm),
    "https://perso.ai/dubbing/desktop-app?utm_source=persodub-mac&utm_medium=desktop-app&utm_campaign=desktop_app&utm_term=v0.9.1&utm_content=help");
  assert.equal(persoLink("https://perso.ai/x?tab=1", "about", utm).startsWith("https://perso.ai/x?tab=1&utm_source="), true);
  assert.equal(persoLink("https://perso.ai/dubbing/desktop-app", "help", ""), "https://perso.ai/dubbing/desktop-app");
});
