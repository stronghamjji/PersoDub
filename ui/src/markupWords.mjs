// The markup's own words that cannot carry data-i18n, written in the page's
// language here instead. ui/src/indexHtml.test.mjs pins these elements to the
// character -- a tab's word right after its icon, a dialog's exact lines, a
// button's whole tag -- so an added attribute or a <span> round the word
// would break the contract it checks. Every other word of the markup is
// marked data-i18n and changes with applyTranslations (ui/src/i18n.mjs).
//
// The page paints these once its language is known (ui/src/app.mjs) and again
// when Settings changes it (ui/src/settingsDialog.mjs). Nothing else writes
// into these elements.
import { t } from "./i18n.mjs";

// Which element, and what it says. The element's last run of text is the one
// rewritten, so an icon in front of the word stays where it is.
const words = () => [
  ["#homeHelp", t("Help")],
  ['#leftTabs [data-tab="dubbing"]', t("Dubbing")],
  ['#leftTabs [data-tab="captions"]', t("Burn in subtitles")],
  ['#leftTabs [data-tab="erase"]', t("Erase")],
  ['#leftTabs [data-tab="save"]', t("Save video")],
  // Home and New project move between the tab row and the top bar.
  ["#homeBtn span", t("Home")],
  ["#newProjectBtn span", t("New project")],
  ["#retranslateBtn", t("Retranslate unfit lines")],
  ["#remakeVoicesBtn", t("Remake voices")],
  ["#allAtOnceBtn", t("All at once")],
  ["#runPane .vtab:nth-child(1)", t("Original")],
  ["#runPane .vtab:nth-child(2)", t("Dubbed")],
  ['#eraseTabs [data-erase="erased"]', t("Erased")],
  ["#runTimeline .tl-wait", t("The timeline appears when dubbing is done")],
  ["#projectClose", t("Cancel")],
  ["#exportCloseBtn", t("Cancel")],
  ["#exportGoBtn", t("Download")],
  ["#newProjClose", t("Cancel")],
  ["#mediaReplaceOverlay h2", t("Replace this video?")],
  ["#mediaReplaceOverlay .modal-body p", t("Cuts are reset.")],
  // Help (the Home sidebar's): its title, the three tools, the links and OK.
  // The fourth item is the Dub Agent, whose name is not translated.
  ["#helpTitle", t("What {app} does")],
  ["#helpOverlay .help-item:nth-child(1) b", t("Dubbing")],
  ["#helpOverlay .help-item:nth-child(1) p", t("Voices a video in another language, in each speaker’s own voice. You get the dubbed video, its subtitles and a script you can fix line by line.")],
  ["#helpOverlay .help-item:nth-child(1) .help-where", t("Local model (10 languages, free) or Perso API (100+ languages in all, depending on the dubbing model; credits).")],
  ["#helpOverlay .help-item:nth-child(2) b", t("Erase subtitles")],
  // Erase subtitles says why, how and how long, a line each (owner, 2026-10-22).
  ["#helpOverlay .help-item:nth-child(2) p:nth-of-type(1)", t("Why: Original subtitles left in the video overlap the translated ones.")],
  ["#helpOverlay .help-item:nth-child(2) p:nth-of-type(2)", t("How: Fit the box → Erase subtitles → Dubbing → Burn in subtitles.")],
  ["#helpOverlay .help-item:nth-child(2) .help-where", t("Time: About 10 min for a 10-second video (Local model).")],
  ["#helpOverlay .help-item:nth-child(3) b", t("Save video")],
  ["#helpOverlay .help-item:nth-child(3) p", t("Paste a YouTube, TikTok or Reels link. The video is fetched to this computer; Download saves it, or dub it or erase it from there.")],
  ["#helpOverlay .help-item:nth-child(3) .help-where", t("This computer.")],
  ["#helpOverlay .help-item:nth-child(4) p", t("Ask in plain words, such as “Korean dubbing for this link” or “make line 9 fit”. It works through the same tools and shows each step.")],
  ["#helpOverlay .help-item:nth-child(4) .help-where", t("Claude Code, installed and signed in, or Codex, which the app can download and sign in.")],
  ["#helpGuide", t("User guide")],
  ["#helpFaq", t("FAQ")],
  ["#helpOk", t("OK")],
];

// The run pane's Dubbed tab is off until there is a dubbing to show.
const titles = () => [
  ["#runPane .vtab:nth-child(2)", t("After dubbing")],
];

// The last piece of text directly inside `el` that is more than white space.
function lastWords(el) {
  return [...el.childNodes].reverse().find((n) => n.nodeType === 3 && n.textContent.trim());
}

/** Write each element's words (and the one title) in the current language. */
export function paintMarkupWords(doc = document) {
  for (const [selector, text] of words()) {
    for (const el of doc.querySelectorAll(selector)) {
      const node = lastWords(el);
      // The white space before the word is the markup's indent; it stays.
      if (node) node.textContent = node.textContent.replace(/\S[^]*$/, () => text);
    }
  }
  for (const [selector, text] of titles()) {
    for (const el of doc.querySelectorAll(selector)) el.title = text;
  }
}
