import { test } from "node:test";
import assert from "node:assert/strict";
import { isProduction, productName, feedbackSubject, feedbackBody, feedbackMailto, persoLink, DESKTOP_APP_URL } from "./edition.mjs";

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

test("the inquiry mail's subject names the app and version, the kind and the person's subject", () => {
  assert.equal(feedbackSubject("0.9.1", "Bug report", "Export stops"), "[Perso_DesktopApp 0.9.1] [Bug report] Export stops");
});

test("its body is the details, then a rule and what the app adds, in CRLF lines, all encoded in the link", () => {
  const body = feedbackBody({ details: "It stops at 90%.\nEvery time.", type: "Bug report", replyTo: "me@example.com",
                              version: "0.9.1", system: "macOS 15.1.0" });
  assert.equal(body, "It stops at 90%.\r\nEvery time.\r\n\r\n---\r\nType: Bug report\r\nReply-to: me@example.com\r\n"
    + "App: Perso_DesktopApp 0.9.1\r\nComputer: macOS 15.1.0");
  const link = feedbackMailto("team@example.com", "[Perso_DesktopApp 0.9.1] [Bug report] A & B?", body);
  assert.equal(link, "mailto:team@example.com?subject=%5BPerso_DesktopApp%200.9.1%5D%20%5BBug%20report%5D%20A%20%26%20B%3F"
    + `&body=${encodeURIComponent(body)}`);
  assert.ok(link.includes("%0D%0A---%0D%0AType%3A%20Bug%20report"));
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
