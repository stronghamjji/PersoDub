// The Home screen's left sidebar and the Dub Agent card beside the banner
// (the mockup's first screen, user 2026-09-30).
//
// Owns the sidebar's buttons (#homeGhName, #homePerso, #homeNavDub,
// #homeNavAudio, #homeNavErase, #homeNavSave, #homeNavSettings,
// #homeHelp, #homeFeedback, #homeWhatsNew/#homeWhatsNewTitle) and the row of cards under
// the banner (#homeAgentCard with its [data-prompt] chips, #homeDubCard,
// #homeAudioCard, #homeEraseCard, #homeSaveCard). Every one of them opens something the page
// already has; this file only decides which.
//
// The Dub Agent column is hidden on Home until something here opens it: the
// stylesheet hides .agent while body[data-screen="home"] lacks the
// "home-agent" class, and showHome() takes that class off again.
import { t } from "./i18n.mjs";

/** True while the Dub Agent column is held back on the Home screen. */
export function homeAgentHidden(body) {
  return body.dataset.screen === "home" && !body.classList.contains("home-agent");
}

/**
 * Show the Dub Agent column (on Home too) and, given a sentence, put it in the
 * input without sending it.
 */
export function openHomeAgent($, body, text) {
  body.classList.add("home-agent");
  if (!body.classList.contains("agent-open")) $("assistantFold").click();
  const input = $("assistantInput");
  if (text) {
    input.value = text;
    // The strip sizes the box and lights its send button off this event.
    input.dispatchEvent(new Event("input"));
  }
  input.focus();
}

/** "What's new in 0.7.1"; a build with no real version number says less. */
export function whatsNewTitle(version) {
  return version && version !== "0.0.0" ? t("What’s new in {version}", { version }) : t("What’s new");
}

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.$
 * @param {object} deps.body            document.body
 * @param {string} deps.repoUrl         the project's GitHub page
 * @param {() => string} deps.persoUrl  Perso's workspace, UTM-tagged once the settings have loaded
 * @param {(url: string) => void} deps.openUrl   opens in the system browser
 * @param {() => void} deps.onDubbing     a new project on its Dubbing tab (file or link)
 * @param {() => void} deps.onErase
 * @param {() => void} [deps.onAudio]     Separate audio: a new project on its Audio tab
 * @param {() => void} deps.onSaveVideo   the banner's link field
 * @param {() => void} deps.onSettings
 * @param {() => void} deps.onHelp        the Help dialog: what each tool does
 * @param {() => Promise<{version?: string}>} deps.loadWhatsNew
 */
export function initHomeSidebar({ $, body, repoUrl, persoUrl, openUrl, onDubbing, onErase,
                                  onAudio = () => {}, onSaveVideo, onSettings, onHelp, loadWhatsNew }) {
  const on = (id, fn) => $(id).addEventListener("click", fn);

  on("homeGhName", () => openUrl(repoUrl));
  on("homePerso", () => openUrl(persoUrl()));
  on("homeNavDub", onDubbing);
  on("homeNavAudio", onAudio);
  on("homeNavErase", onErase);
  on("homeNavSave", onSaveVideo);
  on("homeNavSettings", () => onSettings());
  on("homeHelp", onHelp);
  // The app has no feedback form of its own; the issues page is where it goes.
  on("homeFeedback", () => openUrl(`${repoUrl}/issues`));
  // The update module listens for this event and opens its window: the
  // running version's list, or the update on offer (ui/src/updateWindow.mjs,
  // which also marks this card while one downloads or waits).
  on("homeWhatsNew", () => window.dispatchEvent(new CustomEvent("persodub:open-update")));

  on("homeDubCard", onDubbing);
  on("homeAudioCard", onAudio);
  on("homeEraseCard", onErase);
  on("homeSaveCard", onSaveVideo);
  // A chip opens the agent with its sentence in the box; anywhere else on the
  // card (the Open Dub Agent button included) opens it as it is. The
  // sentence goes in in the page's language: its key is the chip's own words.
  on("homeAgentCard", (e) => {
    const chip = e.target.closest("[data-prompt]");
    openHomeAgent($, body, chip ? t(chip.dataset.prompt) : "");
  });

  // Not over an update's "ready" title, should that have come in first.
  loadWhatsNew()
    .then((info) => {
      if (!$("homeWhatsNew").classList.contains("ready")) $("homeWhatsNewTitle").textContent = whatsNewTitle(info && info.version);
    })
    .catch(() => { /* the card keeps its plain title */ });
}
