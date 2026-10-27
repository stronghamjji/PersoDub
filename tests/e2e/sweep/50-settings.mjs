// The sweep's Settings area: the Settings dialog tab by tab, the interface
// language switched to English and back, the Home sidebar, the Dub Agent
// panel and the "Updated to" notice. Every press is a real button; state is
// read off the page or what it reads (GET /api/settings, /api/models).
//
// Never typed or pressed here: an API key field, a sign-in (ChatGPT, Claude,
// Codex), a model's Delete confirm, anything that opens an outside site.
// Notes never carry a key, an account address or a home folder's name.
import { isClosed, isOpen, isProductionHelp, onHome, pressable, shown, sleep, textOf, Skip } from "../lib/cdp.mjs";

export const area = "settings";

const TABS = ["keys", "models", "storage", "privacy", "about"];
const TAB_WORDS = ["API keys", "Models", "Storage", "Privacy", "About"];
const GROUPS = ["Audio separation", "Speech-to-text", "Translation", "Text-to-speech", "Required programs"];
// Names that stay English in the Korean page: products, engines, units, keys, the 12 looks.
const ALLOW = ["PersoDub", "Perso API", "Perso", "ChatGPT", "Claude", "Codex", "Whisper", "Demucs", "Mel-Band RoFormer",
  "Qwen3-TTS", "Hunyuan", "Gemma 3", "Gemini", "Ollama", "Python", "PyTorch", "GitHub", "API", "MP3", "WAV", "YouTube",
  "TikTok", "Reels", "Fast mode", "High quality", "Linnet", "Oriole", "Wren", "Finch", "Nightingale", "GB", "MB", "OK",
  "A-", "A+", "Esc", "Clean", "Bold Punch", "Sticker", "Neon Yellow", "Soft Card", "Rainbow", "Broadcast", "Streaming",
  "Lower Bar", "Neon", "Black Box", "White Box",
  // Two more names, beyond the list the sweep was asked for: the agent's and the copyright holder's.
  "Dub Agent", "ESTsoft corp.",
  // The Perso workspace picker's label (kept English in Korean too), and the production edition's name.
  "Workspace", "PersoDubbing",
  // The assistants' model names, shown as their makers write them ("Claude · Opus").
  "Opus", "Sonnet", "Haiku", "Fable", "GPT"];
// What the person put there, not the app's words: project and file names, the
// workspace list, the conversation, the signed-in account.
const USER_TEXT = [".proj-name", ".proj-rename", "#topbarTitle", "#topbarForwardName", "#queueRows", "#persoSpaceSelect",
  "#assistantLog", "#assistantState", "#draftPartCard", "#homeBannerLink", "#homeAccount", "#persoAccountMail", "#signInAccount"].join(",");

// An address or a home folder never goes into a note.
const clean = (s) => String(s).replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g, "<account>").replace(/\/Users\/[^/\s]+/g, "~")
  .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "~");
const either = (app, key, values) => [key.replace(/\{(\w+)\}/g, (_, k) => values?.[k] ?? `{${k}}`), app.tr(key, values)];

// waitFor that lives through a page starting again: a question asked while
// the page reloads throws, and is asked again.
async function settle(app, what, ms, fn, ...args) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await app.inPage(fn, ...args); if (v) return v; } catch { /* the page is starting again */ }
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await sleep(300);
  }
}

async function toHome(app) {
  if (await app.inPage(isOpen, "#settingsOverlay")) await closeSettings(app);
  for (const id of ["#whatsNewOverlay", "#updateOverlay", "#helpOverlay", "#deleteOverlay"]) {
    if (await app.inPage(isOpen, id)) { await app.key("Escape"); await app.waitFor(`${id} to close`, 5000, isClosed, id); }
  }
  if (!(await app.inPage(onHome))) {
    await app.click("#homeBtn");
    await app.waitFor("Home", 10000, onHome);
  }
}

async function openSettings(app) {
  if (await app.inPage(isOpen, "#settingsOverlay")) return;
  await app.click("#homeNavSettings");
  await app.waitFor("the Settings dialog", 10000, isOpen, "#settingsOverlay");
}

async function showTab(app, name) {
  await openSettings(app);
  await app.click(`#settingsTab-${name}`);
  await app.waitFor(`the ${name} tab`, 5000, (n) => !document.querySelector(`#settingsPanel-${n}`).hidden, name);
  if (name === "models") {
    await app.waitFor("the model rows", 15000, () => document.querySelectorAll("#modelsList .model-row").length);
  }
}

// Cancel, and Discard if it asks: nothing a run changed by accident is kept.
async function closeSettings(app) {
  await app.click("#settingsCancelBtn");
  if (await app.inPage(isOpen, "#settingsDiscardOverlay")) await app.click("#settingsDiscardYes");
  await app.waitFor("the Settings dialog to close", 5000, isClosed, "#settingsOverlay");
}

// Save, only when the one change this step made is all that would be saved.
async function saveOne(app) {
  const said = await app.inPage(textOf, "#settingsChanges");
  if (!either(app, "1 change").includes(said)) {
    await closeSettings(app);
    throw new Error(`Save would write "${said}", not the one change made; left without saving`);
  }
  await app.click("#settingsSaveBtn");
}

// A model row by its name: what it says, and a selector for its button.
const rowOf = (app, name) => app.inPage((n) => {
  const kids = [...document.querySelector("#modelsList").children];
  const i = kids.findIndex((r) => r.classList.contains("model-row") && r.children[0].textContent.trim() === n);
  if (i < 0) return null;
  const c = kids[i].children, b = c[3];
  return { sel: `#modelsList > :nth-child(${i + 1}) > button`, status: c[2].textContent.replace(/\s+/g, " ").trim(),
           busy: c[2].classList.contains("model-busy"), button: b.tagName === "BUTTON" ? b.textContent.trim() : "" };
}, name);

const modelState = async (app, id) => ((await app.api("/api/models")).models.find((m) => m.id === id) || {}).state;

async function reloadIn(app, lang) {
  await app.send("Page.reload", {});
  await settle(app, `the page to start again in ${lang}`, 30000, (l) => document.readyState === "complete"
    && document.documentElement.lang === l && document.body.dataset.screen === "home"
    && !document.querySelector("#screen-home").hidden, lang);
  await sleep(800);
}

// The language the way the page writes it: Settings > About, Save, and the page starts again.
async function setLanguage(app, value, lang) {
  await showTab(app, "about");
  await app.choose("#uiLanguageSelect", value);
  await saveOne(app);
  await settle(app, `the page to start again in ${lang}`, 30000, (l) => document.readyState === "complete"
    && document.documentElement.lang === l && document.body.dataset.screen === "home"
    && !document.querySelector("#screen-home").hidden && !document.querySelector("#settingsOverlay").classList.contains("open"), lang);
  await sleep(800);
}

// Every text a person can see under `root`: Hangul ones in English ("hangul"),
// or ones in English alone that are no product name ("english").
// A text the Korean table keeps in English on purpose (its value is its key) is
// counted apart, as kept, not as left over.
// A model id is a name too: any run of letters, dots, colons and hyphens with a
// digit in it (gpt-5.5, hy-mt2:1.8b, claude-opus-4-5).
const scan = (app, root, mode, kept = []) => app.inPage((rootSel, m, allow, skip, keep) => {
  const MODEL_ID = /[\w.:-]*\d[\w.:-]*/g;
  const words = new RegExp(`(?<![A-Za-z])(?:${allow.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z])`, "g");
  const bad = (s) => (m === "hangul" ? /[ᄀ-ᇿ㄰-㆏가-힣]/.test(s)
    : !/[ᄀ-ᇿ㄰-㆏가-힣]/.test(s) && /[A-Za-z]{2,}/.test(s.replace(words, " ").replace(MODEL_ID, " ")));
  const texts = [];
  for (const top of document.querySelectorAll(rootSel)) {
    const walk = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
    for (let node; (node = walk.nextNode());) {
      const s = node.nodeValue.replace(/\s+/g, " ").trim(), el = node.parentElement;
      if (!s || !el || el.closest("script, style, svg, option, textarea") || el.closest(skip)) continue;
      const r = document.createRange();
      r.selectNodeContents(node);
      if (!r.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
      texts.push(s);
    }
    // What a box shows that is not a text node: a select's choice, an empty field's placeholder.
    for (const el of top.querySelectorAll("select, input, textarea")) {
      if (!el.getClientRects().length || el.closest(skip)) continue;
      if (el.tagName === "SELECT") { if (el.selectedOptions[0]) texts.push(el.selectedOptions[0].textContent.replace(/\s+/g, " ").trim()); }
      else if (!el.value && el.placeholder && el.type !== "hidden") texts.push(el.placeholder);
    }
  }
  const odd = [...new Set(texts.filter(bad))];
  return { checked: texts.length, bad: odd.filter((s) => !keep.includes(s)), kept: odd.filter((s) => keep.includes(s)) };
}, root, mode, ALLOW, USER_TEXT, kept);

// Home, the Dubbing tab's prep screen with ctx.video in it, and Settings' five tabs.
async function scanScreens(app, ctx, mode) {
  const found = {}, counts = {}, kept = new Set();
  const table = mode === "english" ? await (await fetch(`${app.origin}/i18n/ui.ko.json`)).json() : {};
  const same = Object.keys(table).filter((k) => table[k] === k);
  const note = (where, r) => { counts[where] = r.checked; if (r.bad.length) found[where] = r.bad; r.kept.forEach((k) => kept.add(k)); };
  await toHome(app);
  note("home", await scan(app, "body", mode, same));
  await app.click("#homeDubCard");
  await app.waitFor("the Dubbing tab's Import block", 10000, shown, "#dubbingZone .import-head");
  await app.feed("#dubbingZone .import-head", ctx.video);
  const ready = await app.waitFor("the prep screen", 120000, () => {
    const s = document.querySelector("#dubbingImportStatus");
    if (s.classList.contains("error") && s.textContent.trim()) return `refused: ${s.textContent.trim()}`;
    return !document.querySelector("#draftSetup").hidden && !document.querySelector("#draftStartBtn").disabled ? "ready" : "";
  });
  if (ready !== "ready") throw new Error(`the import was ${ready}`);
  await sleep(500);
  note("prep", await scan(app, "body", mode, same));
  await app.click("#homeBtn");
  await app.waitFor("Home", 10000, onHome);
  ctx.state.homeBtn = (ctx.state.homeBtn || 0) + 1;
  let n = 0;
  for (const tab of TABS) {
    await showTab(app, tab);
    await sleep(tab === "models" ? 500 : 200);
    const r = await scan(app, "#settingsOverlay", mode, same);
    n += r.checked;
    if (r.bad.length) found[`settings/${tab}`] = r.bad;
    r.kept.forEach((k) => kept.add(k));
  }
  counts.settings = n;
  await closeSettings(app);
  return { found, counts, kept: [...kept] };
}

const listed = (found) => Object.entries(found).map(([where, l]) => `${where}: ${l.map((s) => `"${clean(s)}"`).join(", ")}`).join("; ");

export const steps = [
  { name: "Settings opens, five tabs", looks: ["#settingsTabs"],
    async run(app, ctx) {
      await toHome(app);
      // For the last step: the notice and what the page had last seen, as they were when the run began.
      ctx.state.seenAtStart = await app.inPage(() => { try { return localStorage.getItem("pd.whatsNewSeen"); } catch { return null; } });
      ctx.state.noticeAtStart = await app.inPage(shown, "#updatedNotice");
      await app.click("#homeNavSettings");
      await app.waitFor("the Settings dialog", 10000, isOpen, "#settingsOverlay");
      const names = await app.inPage(() => [...document.querySelectorAll("#settingsTabs .set-tab")].map((b) => b.textContent.trim()));
      const want = TAB_WORDS.map((k) => app.tr(k));
      // The production edition names the first tab "Account and keys" (ui/src/settingsDialog.mjs paintAccount).
      const production = [app.tr("Account and keys"), ...want.slice(1)];
      if (names.join("|") !== want.join("|") && names.join("|") !== production.join("|")) {
        throw new Error(`the tabs read ${names.join(", ")}, not ${want.join(", ")}`);
      }
      return `opened from the gear; ${names.length} tabs: ${names.join(", ")}`;
    } },

  { name: "Models: bands, header, rows", looks: ["#modelsSummary", "#modelsList .model-group-head"],
    async run(app) {
      await showTab(app, "models");
      const got = await app.inPage(() => {
        const fill = (el) => {
          for (let e = el; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            if (c && c !== "transparent" && !/rgba\(.*, 0\)$/.test(c)) return c;
          }
          return "rgb(255, 255, 255)";
        };
        const list = document.querySelector("#modelsList");
        return {
          heads: [...list.querySelectorAll(".model-group-head")].map((h) => ({ title: h.firstElementChild.textContent.trim(), bg: fill(h) })),
          rows: [...list.querySelectorAll(".model-row")].map((r) => ({
            name: r.children[0].textContent.trim(), status: r.children[2].textContent.replace(/\s+/g, " ").trim(),
            button: r.children[3].tagName === "BUTTON" ? r.children[3].textContent.trim() : "", bg: fill(r) })),
          summary: document.querySelector("#modelsSummary").textContent.trim(),
        };
      });
      const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const gap = (a, b) => rgb(a).reduce((s, v, i) => s + Math.abs(v - rgb(b)[i]), 0);
      const missing = GROUPS.map((g) => app.tr(g)).filter((g) => !got.heads.some((h) => h.title === g));
      if (missing.length) throw new Error(`no group heading for ${missing.join(", ")} (headings: ${got.heads.map((h) => h.title).join(", ")})`);
      const rowBg = got.rows[0].bg;
      const flat = got.heads.filter((h) => gap(h.bg, rowBg) < 12);
      if (flat.length) throw new Error(`group bands as dark as the rows (${rowBg}): ${flat.map((h) => `${h.title} ${h.bg}`).join(", ")}`);
      // Resume: a download stopped part way, its pieces kept (Paused).
      const ready = app.tr("Ready"), dl = app.tr("Download"), resume = app.tr("Resume");
      const odd = got.rows.filter((r) => !r.status.includes(ready) && r.button !== dl && r.button !== resume);
      if (odd.length) throw new Error(`rows neither ${ready}, ${dl} nor ${resume}: ${odd.map((r) => `${r.name} "${r.status}" [${r.button}]`).join("; ")}`);
      const sizes = [...got.summary.matchAll(/([\d.]+)\s*GB/g)], counts = got.summary.match(new RegExp(String(got.rows.length)));
      if (!sizes.length || !counts) throw new Error(`the header "${got.summary}" does not say the GB and the ${got.rows.length} models`);
      const ollama = got.rows.find((r) => r.name === "Ollama");
      if (!ollama || !ollama.status || ollama.status === dl) throw new Error(`Ollama's row says nothing of what it is for: "${ollama?.status}"`);
      return `${got.heads.length} bands (${got.heads[0].bg} vs rows ${rowBg}); header "${got.summary}"; `
        + `${got.rows.filter((r) => r.status.includes(ready)).length} ${ready}, ${got.rows.filter((r) => r.button === dl).length} ${dl}, `
        + `${got.rows.filter((r) => r.button === resume).length} ${resume}; Ollama: "${ollama.status}"`;
    } },

  { name: "Models: Mel-Band RoFormer download and cancel", looks: ["#modelsError", "#modelsSummary"],
    async run(app) {
      await showTab(app, "models");
      const name = "Mel-Band RoFormer", dl = app.tr("Download"), resume = app.tr("Resume");
      const before = await rowOf(app, name), was = await modelState(app, "vocal-separator");
      if (!before) throw new Error(`no ${name} row`);
      if (was === "ready") throw new Skip(`${name} is downloaded here: nothing to download and cancel`);
      // Download, or Resume for one stopped part way (paused): either starts it.
      const start = was === "paused" ? resume : dl;
      if (before.button !== start || !(await app.inPage(pressable, before.sel))) throw new Error(`${name} has no ${start} button to press: [${before.button}] "${before.status}", ${was}`);
      // A download lands in the kit's models folder and a cancelled one leaves
      // its pieces there (Paused). On the shared test kit that folder is the
      // real app's, so the press waits for a kit of its own.
      if (process.env.SWEEP_DOWNLOADS !== "1") {
        throw new Skip(`NOT PRESSED: ${name} shows [${start}] and the app says ${was}, but a download writes into the kit's `
          + "models folder and a cancel leaves its pieces there; on a kit whose models folder is the real app's, that is the "
          + "real app. Run with SWEEP_DOWNLOADS=1 on a kit with a models folder of its own");
      }
      await app.click(before.sel);
      const busy = await app.waitFor(`${name} to show progress`, 10000, (n) => {
        const r = [...document.querySelectorAll("#modelsList .model-row")].find((x) => x.children[0].textContent.trim() === n);
        return r && r.children[2].classList.contains("model-busy") && r.children[2].textContent.trim();
      }, name);
      const going = await rowOf(app, name);
      if (going.button !== app.tr("Cancel")) throw new Error(`while downloading the button reads [${going.button}], not ${app.tr("Cancel")}`);
      await app.click(going.sel);
      const back = await app.waitFor(`${name} to stop`, 20000, (n, words) => {
        const r = [...document.querySelectorAll("#modelsList .model-row")].find((x) => x.children[0].textContent.trim() === n);
        return r && words.includes(r.children[3].textContent.trim()) && r.children[3].textContent.trim();
      }, name, [dl, resume]);
      const now = await modelState(app, "vocal-separator");
      if (now === "ready" || now === "downloading") throw new Error(`after Cancel GET /api/models says ${now}`);
      return `pressed ${start}: "${clean(busy)}" in 10 s; ${app.tr("Cancel")} → [${back}], GET /api/models ${now} (pieces kept when paused)`;
    } },

  { name: "Models: Remove asks, never removes", looks: ["#deleteTitle", "#modelsError"],
    async run(app) {
      await showTab(app, "models");
      const ready = app.tr("Ready"), remove = app.tr("Remove");
      // Whisper's Remove takes two presses: the first turns it into the question; it is let go by itself.
      const w = await rowOf(app, "Whisper");
      if (!w || !w.status.includes(ready) || w.button !== remove) throw new Error(`Whisper reads "${w?.status}" [${w?.button}]`);
      await app.click(w.sel);
      const asked = await app.waitFor("Whisper's question", 3000, (s, r) => {
        const t = document.querySelector(s)?.textContent.trim();
        return t && t !== r && t;
      }, w.sel, remove);
      if (!/GB/.test(asked)) throw new Error(`Whisper's first press reads "${asked}", no size asked about`);
      await app.waitFor("Whisper's question to go away by itself", 15000, (s, r) => document.querySelector(s)?.textContent.trim() === r, w.sel, remove);
      const w2 = await rowOf(app, "Whisper");
      if (!w2.status.includes(ready) || (await modelState(app, "whisper")) !== "ready") throw new Error(`Whisper after the question: "${w2.status}"`);
      // Python + PyTorch, a base program, asks in the Delete dialog: Cancel there.
      const p = await rowOf(app, "Python + PyTorch");
      if (!p || !p.status.includes(ready) || p.button !== remove) throw new Error(`Python + PyTorch reads "${p?.status}" [${p?.button}]`);
      await app.click(p.sel);
      await app.waitFor("the Delete dialog", 5000, isOpen, "#deleteOverlay");
      const title = await app.inPage(textOf, "#deleteTitle"), line = await app.inPage(textOf, "#deleteMessage");
      await app.click("#deleteCancelBtn");
      await app.waitFor("the Delete dialog to close", 5000, isClosed, "#deleteOverlay");
      if (!title.includes("Python + PyTorch")) throw new Error(`the Delete dialog says "${title}", not the program's name`);
      const p2 = await rowOf(app, "Python + PyTorch");
      if (!p2.status.includes(ready) || (await modelState(app, "engine")) !== "ready") throw new Error(`Python + PyTorch after ${app.tr("Cancel")}: "${p2.status}"`);
      return `Whisper: first press "${asked}", back to [${remove}] by itself in 10 s, still ${ready}; `
        + `Python + PyTorch: dialog "${title}" / "${line}", ${app.tr("Cancel")} → still ${ready}`;
    } },

  { name: "API keys: masked, Show, what each is for", looks: ["#persoKeyHint", "#geminiKeyHint", "#chatgptHint"],
    async run(app) {
      await showTab(app, "keys");
      const type = () => app.inPage(() => [document.querySelector("#persoKeyInput").type, document.querySelector("#geminiKeyInput").type].join("/"));
      try {
        const at = await type();
        if (at !== "password/password") throw new Error(`the key fields open as ${at}, not masked`);
        await app.click("#showKeysToggle");
        const shownAs = await type();
        await app.click("#showKeysToggle");
        const back = await type();
        if (shownAs !== "text/text" || back !== "password/password") throw new Error(`Show turned them ${shownAs}, then ${back}`);
        const said = await app.inPage(() => ["#persoKeyHint", "#geminiKeyHint", "#chatgptHint", "#chatgptState"]
          .map((s) => document.querySelector(s).textContent.replace(/\s+/g, " ").trim()));
        const want = ["Used when Choose a model, Voice separation or Speech-to-text is set to Perso API. Uses Perso credits.",
          "Used only when Translation is set to Gemini API. Uses your own Google API quota.",
          "Used when Translation is ChatGPT (the default on a new install). The Dub Agent's Codex uses this sign-in too."].map((k) => app.tr(k));
        const wrong = want.filter((w, i) => said[i] !== w);
        if (wrong.length) throw new Error(`hints read ${said.slice(0, 3).map((s) => `"${s}"`).join(", ")}`);
        const claude = await app.inPage(() => /Claude/.test(document.querySelector("#settingsPanel-keys").textContent));
        return `Perso and Gemini fields password, Show → text → password; hints as written; ChatGPT row: `
          + `"${clean(said[3])}" (not pressed); ${claude ? "a Claude row is there" : "no Claude row on this tab"}`;
      } finally {
        // Masked again and off this tab, so the picture after the step shows no key.
        if (await app.inPage(() => document.querySelector("#showKeysToggle").checked)) await app.click("#showKeysToggle");
        await showTab(app, "storage");
      }
    } },

  { name: "Storage: download folder", looks: ["#downloadFolderRow", "#storageHint"],
    async run(app) {
      await showTab(app, "storage");
      const line = await app.waitFor("the download folder line", 5000, (s) => !document.querySelector("#downloadFolderRow").hidden && document.querySelector(s).textContent.trim(), "#downloadFolderLine");
      const lead = app.tr("Download folder: {path}").split("{path}")[0];
      if (!line.startsWith(lead) || line.length <= lead.length + 1) throw new Error(`the line reads "${clean(line)}"`);
      const reveal = await app.inPage(textOf, "#revealOutputBtn");
      const gb = await app.inPage(() => (document.querySelector("#settingsPanel-storage").textContent.match(/[\d.]+\s*[GM]B/g) || []).join(", "));
      return `"${clean(line)}"; ${app.tr("Finished videos")} [${reveal}] (not pressed: opens Finder); `
        + `used space on this tab: ${gb || "none, the GB in use is on the Models header"}`;
    } },

  { name: "Privacy: two switches, their words, usage counts round trip", looks: ["#reportsHint"],
    async run(app) {
      await showTab(app, "privacy");
      const got = await app.inPage(() => {
        const spans = [...document.querySelectorAll("#reportsHint > span")];
        return { labels: ["analyticsToggle", "reportsToggle"].map((id) => document.querySelector(`label[for=${id}]`).textContent.trim()),
                 on: ["#analyticsToggle", "#reportsToggle"].map((s) => document.querySelector(s).checked),
                 lines: spans.map((s) => ({ text: s.textContent.trim(), top: s.getBoundingClientRect().top, bottom: s.getBoundingClientRect().bottom })) };
      });
      const lines = got.lines;
      // One sentence since 0.9.1 (owner, 2026-10-27): what goes, what never goes and why.
      if (lines.length !== 1) throw new Error(`the job-logs text has ${lines.length} sentences, not 1`);
      const all = lines.map((l) => l.text).join(" ");
      const need = app.page.lang === "ko" ? ["작업 기록만 보내", `${app.page.name} 개선을 도와요`] : ["job records", `Helps improve ${app.page.name}`];
      const absent = need.filter((w) => !all.includes(w));
      if (absent.length) throw new Error(`the job-logs text lacks ${absent.join(", ")}`);
      const was = (await app.api("/api/settings")).analytics_off;
      let flipped;
      try {
        await app.click("#analyticsToggle");
        await saveOne(app);
        await app.waitFor("Save to close the dialog", 10000, isClosed, "#settingsOverlay");
        flipped = (await app.api("/api/settings")).analytics_off;
        if (flipped !== !was) throw new Error(`after Save, GET /api/settings analytics_off is ${flipped}, not ${!was}`);
        await showTab(app, "privacy");
        if ((await app.inPage(() => document.querySelector("#analyticsToggle").checked)) !== was) throw new Error("the reopened switch does not show the saved value");
        await app.click("#analyticsToggle");
        await saveOne(app);
        await app.waitFor("Save to close the dialog", 10000, isClosed, "#settingsOverlay");
      } finally {
        if ((await app.api("/api/settings")).analytics_off !== was) {
          await app.api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analytics_off: was }) });
        }
      }
      const now = (await app.api("/api/settings")).analytics_off;
      if (now !== was) throw new Error(`analytics_off did not come back to ${was}`);
      const sw = (i) => `${got.labels[i]} ${got.on[i] ? "on" : "off"}`;
      return `${sw(0)}, ${sw(1)}; job-logs text one sentence; usage counts switch → Save → analytics_off ${was}→${flipped}→${now}`;
    } },

  { name: "About: version, What's new, Escape", looks: ["#aboutVersion", "#wnTitle"],
    async run(app) {
      const v = (await app.api("/api/settings")).app_version;
      await showTab(app, "about");
      const said = await app.inPage(textOf, "#aboutVersion");
      if (said !== `${app.page.name} ${v}`) throw new Error(`the version reads "${said}", GET /api/settings says ${v}`);
      await app.click("#aboutVersion");
      await app.waitFor("the What's new window", 5000, isOpen, "#whatsNewOverlay");
      const title = await app.inPage(textOf, "#wnTitle");
      const notes = await app.inPage(() => document.querySelectorAll("#wnList li").length);
      await app.key("Escape");
      await app.waitFor("Escape to close What's new", 5000, isClosed, "#whatsNewOverlay");
      if (!title.includes(v)) throw new Error(`What's new is titled "${title}", without ${v}`);
      const still = await app.inPage(isOpen, "#settingsOverlay");
      return `"${said}" = app_version ${v}; "${title}" with ${notes} notes; Escape closed it, Settings ${still ? "still open" : "closed too"}`;
    } },

  { name: "Cancel closes, the gear reopens", looks: ["#settingsChanges", "#settingsSaveBtn"],
    async run(app) {
      await openSettings(app);
      const saveOff = await app.inPage(() => document.querySelector("#settingsSaveBtn").disabled);
      await app.click("#settingsCancelBtn");
      await app.waitFor("Cancel to close Settings", 5000, isClosed, "#settingsOverlay");
      if (await app.inPage(isOpen, "#settingsDiscardOverlay")) throw new Error("Cancel with nothing changed asked to discard");
      await app.click("#homeNavSettings");
      await app.waitFor("the gear to reopen Settings", 10000, isOpen, "#settingsOverlay");
      const tab = await app.inPage(() => document.querySelector("#settingsTabs [aria-selected=true]").textContent.trim());
      await closeSettings(app);
      return `${app.tr("Save")} ${saveOff ? "dim with nothing changed" : "lit"}; ${app.tr("Cancel")} closed it; the gear reopened it on ${tab}; closed again`;
    } },

  { name: "Language: English and back to Korean", looks: ["#uiLanguageSelect", "#settingsTab-about"],
    async run(app, ctx) {
      const before = (await app.api("/api/settings")).ui_language;
      let en;
      try {
        await toHome(app);
        await setLanguage(app, "en", "en");
        en = await scanScreens(app, ctx, "hangul");
      } finally {
        // Back to what it was, through the same control; by hand if that failed.
        try {
          await toHome(app);
          await setLanguage(app, before, "ko");
        } catch {
          await app.api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ui_language: before }) });
          await reloadIn(app, "ko");
        }
      }
      const ko = await scanScreens(app, ctx, "english");
      const now = (await app.api("/api/settings")).ui_language;
      const n = (r) => Object.values(r.counts).reduce((a, b) => a + b, 0);
      const counted = `English ${n(en)} texts (home ${en.counts.home}, prep ${en.counts.prep}, settings ${en.counts.settings}), `
        + `Korean ${n(ko)} (home ${ko.counts.home}, prep ${ko.counts.prep}, settings ${ko.counts.settings})`;
      const problems = [Object.keys(en.found).length && `Hangul in English: ${listed(en.found)}`,
                        Object.keys(ko.found).length && `English left in Korean: ${listed(ko.found)}`].filter(Boolean);
      if (problems.length) throw new Error(`${problems.join(" || ")} (${counted})`);
      if (now !== before) throw new Error(`ui_language is ${now}, not back to ${before}`);
      return `ui_language ${before} → en (lang=en) → ${now} (lang=ko); none out of place in ${counted}`
        + (ko.kept.length ? `; kept English by the Korean table: ${ko.kept.map((k) => `"${k}"`).join(", ")}` : "");
    } },

  { name: "Home sidebar: Home, Help, Send feedback, What's new", looks: ["#homeWhatsNew", "#homeHelp"],
    async run(app, ctx) {
      await toHome(app);
      const words = await app.inPage(() => ["#homeHelp", "#homeFeedback", "#homeWhatsNew"].map((s) => document.querySelector(s).textContent.trim()));
      for (const s of ["#homeHelp", "#homeFeedback", "#homeWhatsNew"]) {
        if (!(await app.inPage(pressable, s))) throw new Error(`${s} is not pressable`);
      }
      // No Home item on the Home sidebar itself: Home is the way back from a project's screen.
      await app.click("#homeNavDub");
      await app.waitFor("the Dubbing tab", 10000, shown, "#homeBtn");
      await app.click("#homeBtn");
      await app.waitFor("Home", 10000, onHome);
      // The production edition's Help is Perso's desktop app page in the browser, not the dialog.
      let help;
      if (app.production) {
        const urls = await app.opened(() => app.click("#homeHelp"));
        if (urls.length !== 1 || !isProductionHelp(urls[0])) throw new Error(`Help opened ${urls.join(", ") || "nothing"}`);
        help = "Perso's desktop app page in the browser";
      } else {
        await app.click("#homeHelp");
        await app.waitFor("Help", 5000, isOpen, "#helpOverlay");
        help = `"${await app.inPage(textOf, "#helpTitle")}"`;
        await app.key("Escape");
        await app.waitFor("Escape to close Help", 5000, isClosed, "#helpOverlay");
        help += ", Escape closed it";
      }
      await app.click("#homeWhatsNew");
      await app.waitFor("the update window", 5000, isOpen, "#updateOverlay");
      const upd = await app.inPage(() => `${document.querySelector("#updTitle").textContent.trim()} · ${document.querySelectorAll("#updNotes li").length} notes`);
      await app.key("Escape");
      await app.waitFor("Escape to close the update window", 5000, isClosed, "#updateOverlay");
      return `${app.tr("Home")} (from the Dubbing tab, ${1 + (ctx.state.homeBtn || 0)} presses) back to Home; [${words[0]}] → ${help}; `
        + `[${words[2]}] → "${upd}", Escape closed it; [${words[1]}] pressable, not pressed (${app.production ? "opens the inquiry form" : "opens GitHub in the browser"})`;
    } },

  { name: "Dub Agent panel: who is signed in", looks: ["#homeAgentOpen"],
    async run(app) {
      await toHome(app);
      const wasOpen = await app.inPage(() => document.body.classList.contains("agent-open"));
      // Home hides the top bar's pane buttons; the card's button is the way in there.
      await app.click("#homeAgentOpen");
      let closed = "", note = "";
      try {
        await app.waitFor("the Dub Agent panel", 5000, shown, "#agentStrip");
        // The sign-in check runs once the panel is in use; wait for its answer.
        const state = await app.waitFor("the panel to say who is signed in", 20000, (said) => {
          const s = document.querySelector("#assistantState");
          const t = s.hidden ? "" : s.textContent.replace(/\s+/g, " ").trim();
          return t && (s.querySelector(".state-signin") || said.some((w) => t.includes(w))) ? t : "";
        }, [app.tr("signed in"), app.tr("not signed in")]);
        const rest = await app.inPage(() => ({
          buttons: [...document.querySelectorAll("#assistantState .state-signin")].map((b) => b.textContent.trim()),
          model: document.querySelector("#assistantModelWrap").hidden ? "" : document.querySelector("#assistantModelLabel").textContent.trim(),
          box: document.querySelector("#assistantInput").placeholder }));
        note = `opened with Home's ${await app.inPage(textOf, "#homeAgentOpen")}; "${clean(state)}"`
          + `${rest.buttons.length ? `, sign-in buttons ${rest.buttons.join(", ")} (not pressed)` : ""}; model "${rest.model || "none"}", box "${rest.box}"`;
      } finally {
        // Closed before the picture, since the line names the account. Home has
        // no button for it: Home hides the column again when it is come back to,
        // and the Dubbing tab's pane button folds it as it was.
        if (await app.inPage(shown, "#agentStrip")) {
          await app.click("#homeNavDub");
          await app.waitFor("the Dubbing tab", 10000, shown, "#homeBtn");
          if (!wasOpen && (await app.inPage(() => document.body.classList.contains("agent-open")))) await app.click("#paneAgent");
          await app.click("#homeBtn");
          await app.waitFor("Home", 10000, onHome);
          closed = `no close on Home itself: closed by going to ${app.tr("Dubbing")} and back with ${app.tr("Home")}`;
        }
        await app.waitFor("the panel to close", 5000, () => !document.querySelector("#agentStrip").getClientRects().length);
      }
      return `${note}; ${closed}`;
    } },

  { name: "Updated-to notice: close", looks: ["#updatedNotice"],
    async run(app, ctx) {
      await toHome(app);
      const v = (await app.api("/api/whats-new")).version;
      const seenNow = () => app.inPage(() => { try { return localStorage.getItem("pd.whatsNewSeen"); } catch { return null; } });
      let how = "on Home";
      if (!(await app.inPage(shown, "#updatedNotice"))) {
        // What's new and Escape in About mark the version seen; the notice the run
        // began with comes back with the mark it had then.
        if (!ctx.state.noticeAtStart || !ctx.state.seenAtStart || ctx.state.seenAtStart === v) {
          return `no notice at the start: pd.whatsNewSeen ${ctx.state.seenAtStart ?? "unset"}, version ${v}`;
        }
        await app.inPage((s) => { localStorage.setItem("pd.whatsNewSeen", s); return true; }, ctx.state.seenAtStart);
        await reloadIn(app, app.page.lang);
        await app.waitFor("the notice to come back", 10000, shown, "#updatedNotice");
        how = `back after pd.whatsNewSeen=${ctx.state.seenAtStart} (its value at the start) and a reload`;
      }
      const text = await app.inPage(textOf, "#updatedText");
      if (!either(app, "Updated to {version}", { version: v }).includes(text)) throw new Error(`the notice reads "${text}" for ${v}`);
      await app.click("#updatedClose");
      await app.waitFor("the notice to hide", 5000, (s) => !document.querySelector(s).getClientRects().length, "#updatedNotice");
      const seen = await seenNow();
      if (seen !== v) throw new Error(`after closing, pd.whatsNewSeen is ${seen}, not ${v}`);
      return `"${text}" ${how}; × hid it, pd.whatsNewSeen=${seen}`;
    } },
];
