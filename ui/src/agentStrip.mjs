// The Dub Agent strip along the bottom of the finished screen: the line that
// says who is signed in, the model picker, the fold, the input row, and the
// streamed conversation above it. It is the app's second script for a reason --
// the whole feature is one block to delete, and a strip that throws must not
// take the page down with it. Keeping it in its own module keeps that true:
// static/index.html loads it from a second <script type="module">, and the four
// parts inside are still wired one by one (wire) so one broken part leaves the
// other three working.
//
// What is NOT here: the script table and the player. When the assistant rewrites
// a line or remakes the voices, this file says so on the window
// (persodub:script-changed, persodub:voices-remade) and the page's own module
// redraws. Those two event names, plus document.body's data-screen and
// data-job-id, are the ENTIRE contract between the strip and the app -- they are
// reached through deps (getScreen, getJobId, emit) rather than by touching the
// page, so the contract is visible in one place instead of scattered through the
// file.
//
// The elements this file touches: #assistantLog, #assistantInput,
// #assistantState, #assistantModelBtn, #assistantModelLabel, #assistantMenu,
// #assistantGo, #assistantGoIcon and #assistantFold. It never reaches the top
// bar, the timeline, the script table or `state`.
import { escapeHtml } from "./format.mjs";

// Model aliases, not version numbers -- an alias keeps pointing at the current
// model of that size, so this menu does not go stale.
const MODEL_LABELS = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

// The picker's "this one is chosen" tick. Drawn, not typed: a typed tick is a
// different shape in every font, and the rest of the app's marks are SVG.
// This module cannot see the main one (two module blocks share nothing).
const CHECK_MARK = '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
// "there is more behind this row" and "back to the list", drawn for the same
// reason as the tick above: a typed chevron is a different shape, weight and
// height in every font, and next to real icons it reads as a stray character.
const CHEVRON_RIGHT = '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
const CHEVRON_LEFT = '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';

// The picker's own label: who is answering, and on which model. Handed its three
// readings rather than reaching for them, so the words can be checked without a
// page: the chosen pick, the list the server sent, and the model the CLI said it
// actually ran.
export function labelFor(chosen, agentList, servedModel) {
  if (!chosen.agent) return "Model";
  const a = agentList.find((x) => x.id === chosen.agent);
  // chosen.name is the vendor's own spelling, saved with the pick: while a dub
  // runs the picker is locked and the list may not have come back, and a strip
  // that forgets which assistant was chosen reads as no choice at all.
  const name = a ? a.name : (chosen.name || chosen.agent);
  const model = servedModel || chosen.model;
  return model ? `${name} · ${MODEL_LABELS[model] || model}` : name;
}

// The server names the model it ran ("start"), which is not always the one
// asked for. Match it back to an alias so the picker reads the truth.
export function aliasOf(id) {
  return Object.keys(MODEL_LABELS).find((k) => String(id || "").includes(k)) || "";
}

// --- Signed in, or not ------------------------------------------------------
// Said in Korean, like the rest of what the assistant says to the user, while
// the picker's own labels stay in the app's English.

// null/undefined means the server has not been able to ask yet, and that must
// read as silence -- never as "you are signed out".
export function loginKnown(a) {
  return a && a.installed && a.supported && (a.logged_in === true || a.logged_in === false);
}

// What a row says under its name, and what the strip's first line says.
export function loginWords(a) {
  if (!loginKnown(a)) return "";
  if (a.logged_in) {
    return a.account ? `signed in as ${a.account}` : "signed in";
  }
  return a.login_command ? `not signed in — run ${a.login_command} in Terminal` : "not signed in";
}

// The two faces of the button at the end of the input row. Drawn, like every
// other mark in the strip: a typed arrow is a different shape in every font.
const GO_SEND = '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>';
const GO_STOP = '<rect class="stop-mark" x="5.5" y="5.5" width="13" height="13" rx="2.5"/>';

// One row of the picker. It needs no page of its own -- it builds a button out
// of the document and hands it back for the menu to hang a click on -- so it
// sits out here where its markup can be read on its own.
export function menuRow(label, { note = "", sub = "", tick = false, disabled = false, chevron = false } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "menu-item";
  b.disabled = disabled;
  // `sub` is the reason a row is greyed out. It goes under the name rather than
  // beside it: a sentence in the right-hand column would squeeze the name away.
  // Built as text, not markup: the day a reason is quoted from a CLI's own
  // error message, that sentence must not be able to become a tag.
  const name = document.createElement("span");
  name.className = "menu-name";
  name.appendChild(document.createTextNode(label));
  if (sub) {
    const why = document.createElement("em");
    why.textContent = sub;
    name.appendChild(why);
  }
  const right = document.createElement("span");
  right.className = "menu-right";
  if (tick) { right.innerHTML = '<span class="tick">' + CHECK_MARK + '</span>'; }
  else if (chevron) { right.innerHTML = CHEVRON_RIGHT; }
  // Still text, for the reason `sub` is: a note can be quoted from a CLI's own
  // words, and those must never be able to become a tag.
  else { right.textContent = note; }
  b.append(name, right);
  return b;
}

// The assistant writes a little markdown. Escape the whole answer first, then
// put back the three marks it actually uses -- so nothing an answer contains
// can become a tag of its own, and no link or raw HTML ever survives.
export function replyHtml(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<em>$1</em>");
}

function renderReply(node, text) {
  node.innerHTML = replyHtml(text);
}

// A step in progress, and the same step once the next one starts.
const MARK_RUNNING = '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/></svg>';
const MARK_DONE = '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';

// "Rewriting a line" + [3] -> "Rewriting line 3"; + [1,3] -> "Rewriting lines
// 1, 3". The label the server sends already ends in the words for one line, so
// those come off before the numbers go on. A step that names no line at all --
// reading the script, remaking the voices -- keeps its label as it is.
export function chipText(label, lines) {
  if (!lines.length) return label;
  const stem = label.replace(/\s+(?:a|this|the)\s+lines?$/i, "");
  return stem + (lines.length > 1 ? " lines " : " line ") + lines.join(", ");
}

/**
 * Wire the Dub Agent strip to a page.
 *
 * @param {object} deps
 * @param {(id: string) => any} deps.$  the page's getElementById helper
 * @param {typeof globalThis.fetch} [deps.fetch]  how the strip talks to the app
 * @param {() => string} deps.getScreen  which screen is on show -- read late,
 *        because every paint asks again and the answer changes under this file
 * @param {() => string|null} deps.getJobId  the job the user is looking at, sent
 *        with every message so the assistant is not left asking for a number
 *        nobody can see
 * @param {(name: string) => void} deps.emit  tell the rest of the page something
 *        changed under it (persodub:script-changed, persodub:voices-remade)
 */
export function initAgentStrip({ $, fetch = globalThis.fetch, getScreen, getJobId, emit }) {
  const log = $("assistantLog"), input = $("assistantInput");
  const stateLine = $("assistantState");
  const modelBtn = $("assistantModelBtn"), modelLabel = $("assistantModelLabel");
  const menu = $("assistantMenu");
  const goBtn = $("assistantGo"), goIcon = $("assistantGoIcon");

  // The strip is four parts that do not need each other: the line that says who
  // is signed in, the model picker, the fold, and the input. They used to be set
  // up as one run of statements, so the first one to throw took the other three
  // with it and left a strip that looked finished and answered nothing. Each is
  // wired on its own now, and a part that fails says so in the console.
  const partsFailed = new Set();
  function wire(part, fn) {
    try {
      fn();
    } catch (e) {
      // Once per part. paintChoice runs on every screen change, and a part that
      // is broken is broken every time -- a line per repaint would bury the
      // first one, which is the one that says what actually happened.
      if (!partsFailed.has(part)) {
        partsFailed.add(part);
        console.error(`Dub Agent: the ${part} failed`, e);
      }
    }
  }

  // The side panel's remembered width, left behind when the panel became a strip.
  try { localStorage.removeItem("persodub.assistantWidth"); } catch { /* private window */ }

  // Where the picker starts before anyone has picked. "Model" named neither what
  // would answer nor the fact that something could, and it is what the strip read
  // on every screen until the list came back. A saved pick is loaded over this,
  // and picking never writes this one down, so the user's own choice still wins.
  const DEFAULT_CHOICE = { agent: "claude", model: "opus", name: "Claude" };
  let chosen = { ...DEFAULT_CHOICE };
  let agentList = [];
  // What the CLI said it actually used, and the one thing worth saying before a
  // message is sent. Both are shown, never saved: the user's pick stands.
  let servedModel = "";
  let notice = "";

  function loadChoice() {
    try {
      const raw = localStorage.getItem("persodub.assistantChoice");
      if (raw) chosen = JSON.parse(raw);
    } catch { /* private window, or nothing saved */ }
  }

  function saveChoice() {
    try { localStorage.setItem("persodub.assistantChoice", JSON.stringify(chosen)); }
    catch { /* private window */ }
  }

  // The chosen assistant, when we know it is signed out. Null otherwise -- which
  // includes "not asked yet", so an unchecked CLI never nags.
  function signedOutChoice() {
    const a = agentList.find((x) => x.id === chosen.agent);
    return loginKnown(a) && !a.logged_in ? a : null;
  }

  // The strip's first row. The command is a <code> element built as text, so
  // nothing a server ever sends can become a tag.
  function paintState() {
    const a = agentList.find((x) => x.id === chosen.agent);
    stateLine.textContent = "";
    stateLine.classList.remove("warn");
    // Nobody has been able to ask who is signed in yet (the server only looks
    // when the strip is in use, and looking costs a child process). Say which
    // assistant is about to answer in the meantime: silence about the login is
    // the rule, but silence about the assistant left the folded heading row as a
    // chevron and nothing else. The sign-in state replaces this the moment it
    // lands. With no assistant picked there is nothing to name, so nothing shows.
    if (!loginKnown(a)) {
      const naming = labelFor(chosen, agentList, servedModel);
      stateLine.hidden = !chosen.agent || !naming;
      if (!stateLine.hidden) stateLine.textContent = naming;
      return;
    }
    stateLine.hidden = false;
    if (a.logged_in) {
      stateLine.textContent = `${a.name} · ${loginWords(a)}`;
      return;
    }
    stateLine.classList.add("warn");
    stateLine.appendChild(document.createTextNode(`${a.name} · not signed in`));
    if (a.login_command) {
      stateLine.appendChild(document.createTextNode(" — run"));
      const cmd = document.createElement("code");
      cmd.textContent = a.login_command;
      stateLine.appendChild(cmd);
      stateLine.appendChild(document.createTextNode("in Terminal"));
    }
  }

  // Which one it is showing, and whether it can be pressed. While a turn runs it
  // is always pressable -- stopping is the whole point of it being there.
  function paintGo() {
    wire("send button", () => {
      const screen = getScreen();
      const locked = screen === "running" || screen === "failed";
      const words = busy ? "Stop" : "Send";
      goIcon.innerHTML = busy ? GO_STOP : GO_SEND;
      goBtn.disabled = locked || (!busy && !input.value.trim());
      goBtn.setAttribute("aria-label", words);
      goBtn.title = words;
    });
  }

  function paintChoice() {
    // A dub that stopped early leaves no script behind, so the row is locked
    // rather than left open: dimming alone is a picture of a lock, and a dimmed
    // box is still one Tab away. A running dub takes the strip off the page
    // altogether (see the CSS above); it is locked here as well so that nothing
    // is live in the moment between one screen going and the next arriving.
    const screen = getScreen();
    const running = screen === "running";
    const failed = screen === "failed";
    wire("status line", () => {
      ensureLoginChecked();
      paintState();
    });
    wire("picker", () => {
      modelLabel.textContent = labelFor(chosen, agentList, servedModel);
      modelBtn.disabled = running || failed;
    });
    wire("input", () => {
      input.disabled = running || failed;
      // The one line the strip has to say what it is waiting for: an assistant to
      // be installed, a model to be picked, or the user. A running dub is not on
      // the list -- the strip is off the page there, so nothing it said was read.
      if (failed) {
        input.placeholder = "Nothing to fix here - this dub did not finish";
      } else if (notice) {
        input.placeholder = notice;
      } else if (!chosen.agent) {
        input.placeholder = "Pick a model first";
      } else if (signedOutChoice()) {
        // Pickable, but it cannot answer yet. The row that picked it says the
        // same thing; this is the one the user reads while typing.
        const a = signedOutChoice();
        input.placeholder = a.login_command
          ? `${a.name} is not signed in - run ${a.login_command} in Terminal`
          : `${a.name} is not signed in`;
      } else if (document.body.classList.contains("agent-open")) {
        input.placeholder = "Message";
      } else if (screen === "home") {
        // No script on screen to point at, so no line-number example here.
        input.placeholder = "Ask anything";
      } else {
        // Backticks, not quotes: the sentence contains both a double quote and an
        // apostrophe, and a quote of either kind would end the string early.
        input.placeholder = `Ask for a fix - e.g. "Shorten line 4 naturally so it matches the original's length"`;
      }
    });
    paintGo();
  }

  // The app's screens live in another module; the strip follows them through the
  // one thing both can see.
  wire("screen watch", () => {
    new MutationObserver(paintChoice)
      .observe(document.body, { attributeFilter: ["data-screen"] });
  });

  // Two steps, the way the reference does it: the vendor first, then that
  // vendor's models. One flat list of every model from every vendor is a wall.
  let menuLevel = "";

  function buildMenu() {
    menu.innerHTML = "";

    if (!menuLevel) {
      const head = document.createElement("div");
      head.className = "menu-group";
      head.innerHTML = "<span>Assistant</span>";
      menu.appendChild(head);
      for (const a of agentList) {
        const usable = a.installed && a.supported;
        const row = menuRow(a.name, {
          note: !a.installed ? "not installed" : "",
          // Why this one cannot be picked, said where the picking happens -- or,
          // for one that can, whether it is signed in. A signed-out assistant is
          // still pickable: signing in is a thing the user can go and do.
          sub: a.installed && !a.supported ? (a.reason || "not supported") : loginWords(a),
          chevron: usable,
          disabled: !usable,
        });
        // Stopped here, because buildMenu() takes this very button off the page:
        // the click would then reach the document, which puts away any menu the
        // click landed outside of -- and a detached button is outside of it. That
        // is what closed the picker instead of opening the vendor's models.
        if (usable) row.addEventListener("click", (e) => {
          e.stopPropagation(); menuLevel = a.id; buildMenu();
        });
        menu.appendChild(row);
      }
      return;
    }

    const a = agentList.find((x) => x.id === menuLevel);
    const back = document.createElement("div");
    back.className = "menu-group";
    // The arrow drawn, the name typed: a vendor's name is theirs to spell.
    const backLabel = back.appendChild(document.createElement("span"));
    backLabel.className = "menu-back";
    backLabel.innerHTML = CHEVRON_LEFT;
    backLabel.appendChild(document.createTextNode(a ? a.name : ""));
    back.style.cursor = "pointer";
    back.addEventListener("click", (e) => { e.stopPropagation(); menuLevel = ""; buildMenu(); });
    menu.appendChild(back);

    for (const m of (a && a.models && a.models.length ? a.models : [""])) {
      const row = menuRow(MODEL_LABELS[m] || (a ? a.name : m),
                          { tick: chosen.agent === menuLevel && chosen.model === m });
      row.addEventListener("click", () => {
        chosen = { agent: menuLevel, model: m, name: a ? a.name : menuLevel };
        servedModel = "";
        saveChoice();
        paintChoice();
        menu.hidden = true;
        menuLevel = "";
        buildMenu();
      });
      menu.appendChild(row);
    }
  }

  // The button opens the menu, and the same button closes it again -- that is how
  // someone backs out without picking anything. Always reopen at the top level so
  // the menu never comes back showing one vendor's models out of nowhere.
  wire("picker", () => {
    modelBtn.addEventListener("click", async () => {
      if (!menu.hidden) { menu.hidden = true; return; }
      // The check runs once, at launch. If it failed -- a server still starting
      // up answers nothing -- the menu is empty and the user cannot change
      // assistant at all. Opening the picker is the moment to ask again.
      if (!agentList.length) await loadAgents();
      menuLevel = "";
      buildMenu();
      menu.hidden = false;
    });

    // It now opens upward, over the timeline, so a click anywhere else has to put
    // it away -- otherwise it parks on top of the bars the user turned to read.
    document.addEventListener("click", (e) => {
      if (menu.hidden) return;
      if (menu.contains(e.target) || modelBtn.contains(e.target)) return;
      menu.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) menu.hidden = true;
    });
  });

  let recheckedLogin = false;   // see loadAgents: one second look, never a loop
  // Each check is a child process, so none is started until the strip is on
  // screen AND there is something to say to it. A running dub hides the strip,
  // so that is no reason to start one -- and the "agent-open" class outlives
  // the screen that set it, which is why the screen is asked first rather than
  // the class alone.
  function stripInUse() {
    const screen = getScreen();
    if (screen === "running") return false;
    return screen === "home" || screen === "done"
      || document.body.classList.contains("agent-open");
  }

  // Somebody who never opens a job never spawns a thing.
  let loginAsked = false;
  function ensureLoginChecked() {
    if (loginAsked || !stripInUse()) return;
    loginAsked = true;
    loadAgents({ login: true }).catch(() => {});
  }
  const CHECK_FAILED = "Could not check which assistants are available.";
  const NONE_READY = "No assistant is ready - install Claude Code or Codex";

  async function loadAgents({ login = false } = {}) {
    // Whether the list arrived, said plainly. An empty list happens to mean the
    // fetch failed today, but only because the server always answers with one
    // row per assistant -- a flag says what is meant and cannot go quietly wrong.
    let arrived = false;
    try {
      // ?login=1 is what allows the server to spend a child process on asking
      // each CLI whether it is signed in. Off by default, so the first screen --
      // where the assistant is not even on show -- starts nothing.
      const r = await fetch("/api/agent/status" + (login ? "?login=1" : ""));
      agentList = (await r.json()).agents || [];
      arrived = true;
      notice = "";
    } catch {
      agentList = [];
      // Say it once. A retry that fails again should not stack up bubbles.
      if (notice !== CHECK_FAILED) bubble("ai", CHECK_FAILED);
      notice = CHECK_FAILED;
    }
    // A saved choice only stands if that assistant is still usable -- but a list
    // that never arrived is no evidence that it isn't, and throwing the pick away
    // there is what left the locked strip saying "Model" mid-dub.
    const still = agentList.find((a) => a.id === chosen.agent && a.installed && a.supported);
    if (arrived && !still) {
      // Back to a default rather than to nothing, for the reason above -- but to
      // one this machine can actually run, which is not always the first choice.
      const first = agentList.find((a) => a.installed && a.supported);
      chosen = !first ? { agent: "", model: "" }
        : first.id === DEFAULT_CHOICE.agent ? { ...DEFAULT_CHOICE }
        : { agent: first.id, model: first.models[0] || "", name: first.name };
    }
    // A pick saved before the name was stored would fall back to the raw id and
    // read "claude · Opus". Write the vendor's spelling in the moment we have it.
    if (still && chosen.name !== still.name) { chosen.name = still.name; saveChoice(); }
    buildMenu();
    paintChoice();
    // The server checks the CLIs' logins behind its own answer, so a list that DID
    // ask can arrive before that landed. Look once more, a moment later -- and
    // look without the flag, because the check it would ask for is already
    // running: the second look only has to read what it left behind.
    // Only after a look that asked (a plain load must never arm this -- that is
    // how the first screen ended up starting the checks 1.2s after every launch),
    // only while the strip is still in use, and once, never in a loop.
    if (login && arrived && !recheckedLogin
        && agentList.some((a) => a.installed && a.supported && a.logged_in == null)) {
      recheckedLogin = true;
      setTimeout(() => {
        if (!stripInUse()) return;   // the user left before the second look
        loadAgents().catch(() => {});
      }, 1200);
    }
    // Same reason: a list that never arrived says nothing about what is
    // installed, and "install one of these three" is the wrong thing to tell
    // someone who already has one. The fetch's own message stands instead.
    if (arrived && !agentList.some((a) => a.installed && a.supported)) {
      if (notice !== NONE_READY) {
        bubble("ai", "No assistant is ready. Install Claude Code or Codex — you only need one.");
      }
      notice = NONE_READY;
      paintChoice();
    }
  }

  // A red line the user can act on, and -- only when the server sent one -- the
  // CLI's own last words folded away under it. Built as text throughout: the tail
  // comes from another program's output and must never be able to become a tag.
  function showError(message, detail) {
    const d = document.createElement("div");
    d.className = "assistant-err";
    d.textContent = message;
    if (detail) {
      const fold = document.createElement("details");
      const head = document.createElement("summary");
      head.textContent = "Details";
      const body = document.createElement("pre");
      body.textContent = detail;
      fold.append(head, body);
      d.appendChild(fold);
    }
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  // The three things the log can hold: a message, a step chip, and the dots that
  // say a turn is running. Each appends and scrolls, so the newest is in view.
  function bubble(cls, text) {
    const d = document.createElement("div");
    d.className = "bubble " + cls;
    // Only the assistant's own words are marked up. What the user typed is shown
    // exactly as it was typed.
    if (cls === "ai") { d.dataset.raw = text; renderReply(d, text); }
    else d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  // One chip per RUN of calls to the same step. The assistant calls a tool once
  // per line, so twenty rewritten lines used to be twenty chips all saying
  // "Rewriting a line"; now they are one chip saying which lines.
  // { label, lines, calls, finished, node, text } while a run is open, else null.
  let run = null;

  // What the chip on screen says right now, and which mark it wears: spinning
  // while any of its calls is still out, ticked once they are all back.
  function paintRun() {
    let text = chipText(run.label, run.lines);
    // "· 1 of 2" -- how far through the run it is. Only worth saying while there
    // is more than one call in the chip and one of them has yet to land.
    if (run.calls > 1 && run.finished < run.calls) {
      text += " · " + run.finished + " of " + run.calls;
    }
    run.text.nodeValue = text;
    const settled = run.finished >= run.calls;
    const mark = run.node.querySelector(".chip-mark");
    if (mark) mark.innerHTML = settled ? MARK_DONE : MARK_RUNNING;
    if (settled) run.node.classList.add("chip-done");
    else run.node.classList.remove("chip-done");
    log.scrollTop = log.scrollHeight;
  }

  // One more call to a step. The same step as the one on screen grows that chip;
  // a different one starts a new chip and finishes whatever was above it.
  function chipStep(label, line) {
    if (!run || run.label !== label) {
      settlePrevious();
      const d = document.createElement("div");
      d.className = "chip";
      d.innerHTML = '<span class="chip-mark">' + MARK_RUNNING + '</span>';
      const text = document.createTextNode("");
      d.appendChild(text);
      log.appendChild(d);
      run = { label, lines: [], calls: 0, finished: 0, node: d, text };
    }
    run.calls += 1;
    if (typeof line === "number" && !run.lines.includes(line)) {
      run.lines.push(line);
      run.lines.sort((a, b) => a - b);
    }
    paintRun();
  }

  // A call in the chip on screen has landed. Which one it was is not said and
  // does not matter -- the chip is counting its own run, and a call that comes
  // back after the run is closed has nothing left to count.
  function chipFinished() {
    if (!run) return;
    run.finished = Math.min(run.finished + 1, run.calls);
    paintRun();
  }

  // Only one chip is ever "in progress": the previous step is finished the moment
  // the next one starts, so ticking it off keeps the column honest. A word from
  // the assistant closes the run too -- otherwise a later call to the same tool
  // would join a chip that sits ABOVE what was said in between, and the column
  // would no longer be in the order things happened.
  function settlePrevious() {
    // The run is over, so its count is over too: a chip left saying "1 of 2"
    // under a tick would be counting calls nothing is waiting for any more.
    if (run) { run.finished = run.calls; paintRun(); }
    run = null;
    const chips = log.querySelectorAll(".chip:not(.chip-done)");
    chips.forEach((c) => {
      c.classList.add("chip-done");
      const mark = c.querySelector(".chip-mark");
      if (mark) mark.innerHTML = MARK_DONE;
    });
  }

  function thinking(label) {
    const d = document.createElement("div");
    d.className = "thinking";
    d.innerHTML = "<i></i><i></i><i></i>";
    const s = document.createElement("span");
    s.textContent = label;
    d.appendChild(s);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  // "A turn is on air, so the button says Stop and the row will not send." It is
  // put down the moment Stop is pressed rather than when the stream finally ends,
  // because the point of Stop is being able to type the next thing at once.
  let busy = false;
  // Which turn is the current one. A stopped turn's stream runs on for a moment
  // after the next has started, and without this its clean-up would put the new
  // turn's button back to Send.
  let turnToken = 0;
  // The running turn's stream, so Stop can cut it mid-sentence -- asking the
  // server alone left the text pouring in for seconds (user feedback).
  let turnAbort = null;

  // Press Stop, and the server ends the CLI. The conversation is not lost: the
  // CLI is asked to go rather than shot, so the next message carries on.
  async function stopTurn() {
    if (!busy) return;
    busy = false;
    paintGo();
    turnAbort?.abort();
    try { await fetch("/api/agent/stop", { method: "POST" }); }
    catch { /* the turn ends on its own when the server is gone */ }
  }

  // Esc stops a running turn from anywhere: on a maximized window the Stop
  // button sits far away (user request 2026-09-01). Fields keep their own
  // Escape meaning -- a script cell reverts, an input drops focus -- so the
  // key only reaches the agent when nothing is being typed.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !busy) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    e.preventDefault();
    stopTurn();
  });

  // The muted line under whatever the turn had already said.
  function stoppedLine() {
    const d = document.createElement("div");
    d.className = "assistant-stopped";
    d.textContent = "Stopped";
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  async function ask(message) {
    // The same doors submit() holds open: a finished job, or the home screen.
    const screen = getScreen();
    if (screen !== "done" && screen !== "home") return;
    const token = ++turnToken;
    busy = true;
    paintGo();
    bubble("me", message);
    let answer = null;
    // Two jobs, two variables. `answer` is only "which bubble am I appending to",
    // and a chip deliberately clears it so the next thing said starts below the
    // step. `saidSomething` is "did this turn say anything at all", which is what
    // the end of the turn asks -- reading `answer` for that printed "(empty
    // answer)" under a good reply whose last event happened to be a step.
    let saidSomething = false;
    let touchedScript = false;
    let remadeVoices = false;
    let dots = thinking("Thinking…");
    const clearDots = () => { if (dots) { dots.remove(); dots = null; } };
    // A slow turn should say so rather than look stuck.
    const slow = setTimeout(() => {
      if (dots) dots.querySelector("span").textContent = "Still working…";
    }, 12000);

    turnAbort = new AbortController();
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        signal: turnAbort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          agent: chosen.agent,
          model: chosen.model,
          // Whatever job is on screen. Without it the assistant asks for a job
          // number the user never sees.
          job_id: getJobId(),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || ("The app server answered " + res.status + "."));
      }

      // The body is one JSON event per line, arriving as the turn runs.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.kind === "start") {
            // Which model actually answered. The picker says so rather than
            // repeating the request back; the saved choice is left alone.
            const alias = aliasOf(ev.model);
            if (alias && alias !== servedModel) { servedModel = alias; paintChoice(); }
          } else if (ev.kind === "progress" && ev.done) {
            // A call the chip on screen is already counting has come back.
            chipFinished();
          } else if (ev.kind === "progress") {
            clearDots(); chipStep(ev.label, ev.line);
            // Whatever the assistant says next belongs BELOW this step, not
            // appended to the paragraph above it. Without this, an assistant
            // that speaks before its first tool call -- which Codex does every
            // turn -- ends up with its answer printed above the steps that
            // produced it.
            answer = null;
            // The assistant just rewrote a line. Tell the script table so the
            // change shows up where the user is looking, without a refresh.
            // The chip fires when the tool is CALLED, a moment before the line is
            // actually written -- redrawing only here showed the old words back.
            // Redraw now for responsiveness, and again when the turn ends.
            // change_speaker belongs here too: it rewrites a Perso dub's
            // script on the server, and the table must catch up the same way.
            if (ev.tool === "edit_script_line" || ev.tool === "change_speaker") {
              touchedScript = true;
              emit("persodub:script-changed");
            }
            // The remake is told at the end of the turn instead (below): this
            // chip fires when the tool is CALLED, and reloading the player then
            // would fetch the video halfway through being written again.
            if (ev.tool === "remake_voices") remadeVoices = true;
          }
          else if (ev.kind === "text") {
            clearDots();
            settlePrevious();
            if (!answer) answer = bubble("ai", "");
            saidSomething = true;
            answer.dataset.raw += ev.text;
            renderReply(answer, answer.dataset.raw);
            log.scrollTop = log.scrollHeight;
          } else if (ev.kind === "error") {
            clearDots();
            settlePrevious();
            showError(ev.message, ev.detail);
          } else if (ev.kind === "done") {
            clearDots();
            settlePrevious();
            // Stopped on purpose. Not an empty answer, and not a failure --
            // whatever it had said stays, with a line under it saying why it
            // ends there.
            if (ev.stopped) stoppedLine();
            else if (!saidSomething && ev.text) bubble("ai", ev.text);
            else if (!saidSomething) bubble("ai", "(empty answer)");
          }
        }
      }
    } catch (e) {
      clearDots();
      settlePrevious();
      // A cut stream is the Stop working, not a failure.
      if (e && e.name === "AbortError") stoppedLine();
      else showError(String(e.message || e), "");
    } finally {
      clearTimeout(slow);
      // The writes have certainly landed by the time the turn is over, so this is
      // the redraw that is guaranteed to show the new words.
      // The remake redraws the table as well, so a turn that did both needs the
      // one redraw and not two racing each other.
      if (touchedScript && !remadeVoices) {
        emit("persodub:script-changed");
      }
      // Same reason, and the player with it: the remake rebuilds the video in
      // place, and the turn being over is what says the new file is whole.
      if (remadeVoices) emit("persodub:voices-remade");
      // A turn that ends having shown nothing at all is the failure that looks
      // exactly like the app being broken. Say so instead.
      if (dots) { clearDots(); bubble("ai", "No answer came back. Try sending that again."); }
      // Only if this is still the turn on air: a stopped one finishing after the
      // next has started must not say the row is free when it is not.
      if (token === turnToken) busy = false;
      paintChoice();
      log.scrollTop = log.scrollHeight;
    }
  }

  function submit() {
    // A finished job has a script to fix, and the home screen has questions.
    // Nothing here may start a turn against a job the pipeline is still
    // rendering (running), or one that left no script behind (failed).
    const screen = getScreen();
    if (screen !== "done" && screen !== "home") return;
    const message = input.value.trim();
    if (!message || busy) return;
    if (!chosen.agent) { menu.hidden = false; return; }
    input.value = "";
    input.style.height = "auto";
    setCollapsed(false);
    ask(message);
    paintGo();
  }

  // The box stays typeable while an answer is coming, so Enter has to mean
  // something there: stop the answer, then send what was typed -- in that order,
  // and waiting for the stop, so the CLI has gone before the next turn asks it to
  // carry the conversation on.
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // Korean (and any IME) fires Enter once more to settle the syllable being
    // composed. Acting on that one sent the leftover syllable as a message of
    // its own -- and stopped the turn in flight to do it. keyCode 229 is the
    // same event as Safari reports it.
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (busy && input.value.trim()) await stopTurn();
    submit();
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    paintGo();      // pressable only once there is something to send
  });

  // Wired once, here, rather than in paintChoice -- that runs on every screen
  // change, and a listener added there would stack up a press per repaint.
  wire("send button", () => {
    goBtn.addEventListener("click", () => {
      if (busy) stopTurn();
      else submit();
    });
  });

  // Open means the conversation is on show above the input row; closed is the
  // heading row and the input row alone. Clicking the input row is the other way
  // back in; the fold in the heading row goes both ways and says which it is
  // doing -- to a reader, through its arrow, and to a screen reader, through
  // aria-expanded.
  const AGENT_OPEN_KEY = "persodub.layout.agentOpen";
  function setCollapsed(collapsed) {
    // The class first, on its own: it is what the CSS folds the strip by, so it
    // has to land even if the button that says which way it went has gone.
    document.body.classList.toggle("agent-open", !collapsed);
    try { localStorage.setItem(AGENT_OPEN_KEY, collapsed ? "0" : "1"); } catch { /* private window */ }
    wire("fold", () => {
      const fold = $("assistantFold");
      const words = collapsed ? "Show the conversation" : "Hide the conversation";
      fold.setAttribute("aria-expanded", String(!collapsed));
      fold.setAttribute("aria-label", words);
      fold.title = words;
    });
    paintChoice();
    wire("input", () => { if (!collapsed) input.focus(); });
  }

  wire("fold", () => {
    $("assistantFold").addEventListener("click", () => {
      setCollapsed(document.body.classList.contains("agent-open"));
    });
  });
  wire("input", () => {
    input.addEventListener("focus", () => setCollapsed(false));
  });

  // Closed on launch, the way the mockup opens: one row under the timeline. The
  // model list loads now regardless -- the picker is on show even when closed --
  // but without the flag that lets the server ask each CLI who it is signed in
  // as. That waits for the strip to be in use (ensureLoginChecked above).
  wire("saved pick", loadChoice);
  loadAgents().catch((e) => console.error("Dub Agent: the model list failed", e));
  // As it was when the app was closed; open the first time.
  let agentWasClosed = false;
  try { agentWasClosed = localStorage.getItem(AGENT_OPEN_KEY) === "0"; } catch { /* private window */ }
  setCollapsed(agentWasClosed);
}
