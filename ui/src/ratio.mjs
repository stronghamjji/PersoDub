// The Ratio and Preview buttons at the right of the player's foot.
//
// Ratio shows the video inside a canvas of another shape -- 9:16, 16:9, 1:1,
// 4:5 -- centred, with black filling the rest, and Export writes the file the
// same way (app/ratio.py). The picture itself is never cropped or stretched:
// the canvas only adds black around it, so the subtitles, which are placed
// against the picture (ui/src/subtitleLayout.mjs pictureRect), stay where
// they are on it.
//
// Preview shows the video as a phone app would: inside a 9:16 canvas, with
// that app's buttons and words drawn over it. It is a viewing aid: it changes
// neither the project's ratio nor what Export writes, and nothing of it is
// ever part of a saved video.
//
// The arithmetic is at the top and is what the tests check; initRatioUi at the
// bottom wires it to the page.
import { pictureRect } from "./subtitleLayout.mjs";
import { lucide } from "./icons.mjs";
import { t } from "./i18n.mjs";
import { isAudio } from "./mediaKind.mjs";

// The words are getters, read in the language of the moment they are drawn.
export const RATIOS = [
  { id: "original", get label() { return t("Original"); } },
  { id: "9:16", label: "9:16", note: "TikTok · Reels · Shorts" },
  { id: "16:9", label: "16:9", note: "YouTube" },
  { id: "1:1", label: "1:1", note: "Instagram" },
  { id: "4:5", label: "4:5", get note() { return t("Instagram feed"); } },
];

export const PREVIEWS = [
  { id: "tiktok", label: "TikTok" },
  { id: "shorts", label: "YouTube Shorts" },
  { id: "reels", label: "Instagram Reels" },
  { id: "none", get label() { return t("None"); } },
];

/** The shape of a phone's screen: what every platform preview is shown in. */
export const PREVIEW_RATIO = "9:16";

/** [w, h] of a ratio id, or null for "original" and anything unknown. */
export function ratioParts(id) {
  if (!RATIOS.some((r) => r.id === id) || id === "original") return null;
  const [w, h] = id.split(":").map(Number);
  return [w, h];
}

/** "16:9" for a 1920x1080 picture: the name beside Original in the menu.
    The nearest everyday shape when the picture is within 2% of one, else "". */
export function shapeName(width, height) {
  if (!width || !height) return "";
  const names = ["16:9", "9:16", "1:1", "4:5", "5:4", "4:3", "3:4", "21:9", "2:1", "1:2"];
  for (const name of names) {
    const [w, h] = name.split(":").map(Number);
    if (Math.abs(width / height - w / h) / (w / h) < 0.02) return name;
  }
  return "";
}

/**
 * The canvas inside the player's box: the largest rectangle of the ratio that
 * fits, in the middle. null for "original" -- there is no canvas then, and the
 * video sits in the box as it always has.
 */
export function canvasRect({ width, height }, id) {
  const parts = ratioParts(id);
  if (!parts || !width || !height) return null;
  const s = Math.min(width / parts[0], height / parts[1]);
  const w = parts[0] * s, h = parts[1] * s;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

/** Where the picture sits inside the canvas: as large as fits, centred. The
    same sum as the <video>'s own letterbox, asked of the canvas. */
export function pictureInCanvas(canvas, videoWidth, videoHeight) {
  return pictureRect({ ...canvas, videoWidth, videoHeight });
}

/**
 * The size of the exported canvas in the video's own pixels, or null when the
 * file is saved as it is. Mirrors app/ratio.py canvas_size: the picture is not
 * scaled, one side of the canvas is its own, both sides are even.
 */
export function exportCanvas(videoWidth, videoHeight, id) {
  const parts = ratioParts(id);
  if (!parts || !videoWidth || !videoHeight) return null;
  const [rw, rh] = parts;
  let w, h;
  if (videoWidth * rh >= videoHeight * rw) { w = videoWidth; h = Math.ceil(videoWidth * rh / rw); }
  else { w = Math.ceil(videoHeight * rw / rh); h = videoHeight; }
  w += w % 2; h += h % 2;
  if (w - videoWidth <= 2 && h - videoHeight <= 2) return null;
  return { width: w, height: h };
}

// ---- What is picked --------------------------------------------------------

export function initialPick() {
  return { ratio: "original", preview: "none" };
}

/** Pick a ratio. The preview stays as it is: the two do not touch. */
export function pickRatio(state, id) {
  if (!RATIOS.some((r) => r.id === id)) return state;
  return { ...state, ratio: id };
}

/** Pick a preview. The project's ratio stays as it is. */
export function pickPreview(state, id) {
  if (!PREVIEWS.some((p) => p.id === id)) return state;
  return { ...state, preview: id };
}

/** What the Ratio button says: its own name until a ratio is picked. */
export function ratioLabel(state) {
  return state.ratio === "original" ? t("Ratio") : state.ratio;
}

/**
 * Where the black canvas and the picture go in the player's box. With a
 * preview on, the canvas is the phone's 9:16 and the project's own canvas
 * (if it has one) is fitted inside it, as the exported file would be on that
 * phone. null when there is neither: the video sits in the box as always.
 */
export function onShow(box, state, videoWidth, videoHeight) {
  const phone = state.preview !== "none";
  const canvas = canvasRect(box, phone ? PREVIEW_RATIO : state.ratio);
  if (!canvas) return null;
  const own = phone && canvasRect(canvas, state.ratio);
  const frame = own ? { ...own, left: canvas.left + own.left, top: canvas.top + own.top } : canvas;
  return { canvas, picture: pictureInCanvas(frame, videoWidth, videoHeight) };
}

/** A download link with the ratio on it; untouched for "original". */
export function withRatio(url, id) {
  if (!ratioParts(id)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ratio=${encodeURIComponent(id)}`;
}

// ---- The platform previews -------------------------------------------------
// What each app draws over a video, measured on the mockup's own previews: a
// 914 x 1624 canvas, every number below in its pixels. Icons are placed by
// their centre and drawn `w` wide; a text by its left edge (or its centre,
// under an icon) and the middle of its capitals; all of it comes out as
// fractions of the canvas, so it scales with the player.
const FW = 914, FH = 1624;
const icon = (zone, name, cx, cy, w, more = {}) =>
  ({ kind: "icon", zone, name, cx: cx / FW, cy: cy / FH, w: w / FW, ...more });
const shape = (zone, name, cx, cy, w, more = {}) =>
  ({ kind: "shape", zone, name, cx: cx / FW, cy: cy / FH, w: w / FW, ...more });
const text = (zone, words, x, cy, size, more = {}) =>
  ({ kind: "text", zone, text: words, x: x / FW, cy: cy / FH, size: size / FW, ...more });
/** A count under an icon of the right-hand column. */
const count = (cx, cy, size, words = "2.8M") =>
  text("rail", words, cx, cy, size, { center: true, weight: 500 });

/** The phone's own bar; `dx` because one app draws it a little further right. */
const statusBar = (dx = 0) => [
  text("status", "9:41", 51 + dx, 54.5, 44, { weight: 600 }),
  shape("status", "signal", 731.5 + dx, 52.5, 43, { h: 27 / FW }),
  icon("status", "wifi", 784.5 + dx, 51, 42),
  shape("status", "battery", 845.5 + dx, 52, 61, { h: 28 / FW }),
];

// Functions, so the words are read in the language of the moment they are drawn.
const DESCRIPTION = () => t("Here are some descriptions about videos");
const ELEMENTS = () => ({
  reels: [
    ...statusBar(),
    icon("top", "search", 81, 178, 64),
    icon("top", "camera", 846.5, 195.5, 58),
    icon("rail", "heart", 843.5, 943, 76), count(842.5, 1012.5, 27),
    icon("rail", "message-circle", 843.5, 1116.5, 65), count(842.5, 1177.5, 27),
    icon("rail", "send", 843.5, 1282.5, 65), count(842.5, 1342.5, 27),
    icon("rail", "ellipsis", 843.5, 1446.5, 58),
    shape("corner", "tile", 843, 1548, 62),
    shape("caption", "avatar", 81.5, 1395.5, 89),
    text("caption", t("@Your name"), 140, 1397, 33, { weight: 500 }),
    text("caption", DESCRIPTION(), 40, 1498, 33),
    shape("caption", "dot", 56, 1573, 38, { dim: true }),
    text("caption", t("Music name"), 90, 1573.5, 26, { dim: true, weight: 500 }),
  ],
  tiktok: [
    ...statusBar(12.5),
    text("top", t("Explore"), 195, 180, 37, { dim: true, weight: 600 }),
    text("top", t("Following"), 373, 180, 37, { dim: true, weight: 600 }),
    text("top", t("For You"), 588, 180, 37, { weight: 700 }),
    shape("top", "bar", 653, 221.5, 64, { h: 5 / FW }),
    icon("top", "search", 830, 178, 64),
    shape("rail", "avatar", 837, 736, 102),
    icon("rail", "heart", 836, 901, 73, { fill: true }), count(836.5, 959, 33),
    icon("rail", "message-circle", 835.5, 1061.5, 72, { fill: true }), count(836.5, 1118, 33),
    icon("rail", "bookmark", 835, 1220, 76, { fill: true }), count(836.5, 1276.5, 33),
    icon("rail", "share-arrow", 834.5, 1377.5, 80, { fill: true }), count(836.5, 1435, 33),
    shape("corner", "disc", 837, 1545, 94),
    text("caption", t("Your name"), 24, 1434, 53, { weight: 500 }),
    text("caption", DESCRIPTION(), 27, 1511, 33),
    text("caption", t("See original"), 26, 1574.5, 33, { dim: true }),
  ],
  shorts: [
    ...statusBar(),
    icon("top", "search", 735, 197, 64),
    icon("top", "ellipsis-vertical", 849.5, 196.5, 55),
    icon("rail", "thumbs-up", 834, 628, 70), count(832.5, 686, 33),
    icon("rail", "thumbs-down", 834, 812, 70), count(834.5, 869.5, 33, t("Dislike")),
    icon("rail", "message-square-text", 834, 997, 70), count(833.5, 1054.5, 33),
    icon("rail", "share-arrow", 835, 1180, 76), count(833, 1238, 33),
    icon("rail", "circle-plus-arrows", 834, 1364, 70), count(832.5, 1422, 33),
    shape("corner", "tile", 834, 1541.5, 88),
    shape("caption", "avatar", 75.5, 1484.5, 77),
    text("caption", t("@Your name"), 127, 1485.5, 33, { weight: 500 }),
    text("caption", DESCRIPTION(), 40, 1568, 33),
  ],
});

/**
 * What one platform draws, each element as fractions of the canvas: `cx`, `x`
 * and `w` of its width, `cy` of its height, a text's `size` of its width.
 * `zone` says which part of the app it is: status, top, rail (the column at
 * the right), caption (the words at the bottom left) or corner (the plain
 * shape at the bottom right). [] for "none" or a name that is not a platform.
 */
export function previewElements(platform) {
  return ELEMENTS()[platform] || [];
}

// Two shapes of the phone's bar that are wider than they are tall.
const BARS = {
  signal: '<svg viewBox="0 0 43 27"><rect y="16" width="8" height="11" rx="2"/><rect x="11.5" y="11" width="8" height="16" rx="2"/>'
    + '<rect x="23" y="5" width="8" height="22" rx="2"/><rect x="35" width="8" height="27" rx="2"/></svg>',
  battery: '<svg viewBox="0 0 61 28"><rect x="1.5" y="1.5" width="51" height="25" rx="7" fill="none" stroke="currentColor" stroke-width="3" opacity=".5"/>'
    + '<rect x="6" y="6" width="42" height="16" rx="4"/><rect x="56" y="9" width="4" height="10" rx="2" opacity=".5"/></svg>',
};

const pct = (n) => `${Math.round(n * 1e4) / 100}%`;
const em = (n) => `${Math.round(n * 1e4) / 100}em`;   // 1em is 1% of the canvas's width

/** The elements as HTML: placed in percent and sized in em, which initRatioUi
    keeps at a hundredth of the canvas's width, so all of it scales together. */
export function previewHtml(platform) {
  return previewElements(platform).map((e) => {
    const cls = `rp-${e.kind}${e.dim ? " dim" : ""}`;
    if (e.kind === "text") {
      return `<i class="${cls}${e.center ? " mid" : ""}" style="left:${pct(e.x)};top:${pct(e.cy)};`
        + `font-size:${em(e.size)};font-weight:${e.weight || 400}">${e.text}</i>`;
    }
    const box = `left:${pct(e.cx)};top:${pct(e.cy)};width:${em(e.w)};height:${em(e.h || e.w)}`;
    if (e.kind === "icon") return `<i class="${cls}" style="${box}">${lucide(e.name, 24, !!e.fill)}</i>`;
    const inner = BARS[e.name] || (e.name === "avatar" ? lucide("user", 24, true) : "");
    return `<i class="${cls} rp-${e.name}" style="${box}">${inner}</i>`;
  }).join("");
}

/** The preview menu: what it is for, the three apps with a tick on the one
    picked, a line, and None. */
function previewMenuHtml(picked) {
  const item = (p) => `<button type="button" role="menuitemradio" data-id="${p.id}" aria-checked="${p.id === picked}">`
    + `${p.label}${p.id === picked && p.id !== "none" ? lucide("check", 14) : ""}</button>`;
  return `<div class="pv-head"><b>${t("Preview your video for social media")}</b>`
    + `<span>${t("What you see may vary depending on your device.")}</span></div>`
    + PREVIEWS.filter((p) => p.id !== "none").map(item).join("")
    + "<hr>" + item(PREVIEWS.find((p) => p.id === "none"));
}

function menuHtml(items, picked, notes = {}) {
  return items.map((it) => {
    const note = notes[it.id] ?? it.note ?? "";
    return `<button type="button" role="menuitemradio" data-id="${it.id}"`
      + ` aria-checked="${it.id === picked}"${it.id === picked ? ' class="on"' : ""}>`
      + `${it.label}<span>${note}</span></button>`;
  }).join("");
}

/**
 * Wire the two buttons, their menus, the canvas and the preview to the player.
 *
 * @param {object} deps
 * @param {any} deps.video        the <video>
 * @param {any} deps.wrap         the box the video is centred in (it holds the
 *                                canvas and the preview too)
 * @param {any} deps.canvas       the black canvas behind the video
 * @param {any} deps.preview      the layer the platform's interface is drawn in
 * @param {any} deps.ratioBtn     and its menu, deps.ratioMenu
 * @param {any} deps.previewBtn   and its menu, deps.previewMenu
 * @param {() => ({kind: "job", id: string, media?: string} | {kind: "draft", id: string, ratio?: string, media?: string} | null)} deps.getProject
 *        what the player is showing: the choice is kept per project. `media`
 *        is the project's own mark (ui/src/mediaKind.mjs)
 * @param {(ratio: string) => void} deps.saveDraftRatio   keep it in the draft
 * @param {() => void} [deps.onLayout]  the picture moved: redraw what hangs off it
 * @param {typeof fetch} [deps.fetch]
 * @param {any} [deps.doc]
 * @param {any} [deps.ResizeObserver]
 */
export function initRatioUi({ video, wrap, canvas, preview, ratioBtn, ratioMenu, previewBtn, previewMenu,
                              getProject, saveDraftRatio, onLayout = () => {},
                              fetch = globalThis.fetch, doc = globalThis.document,
                              ResizeObserver = globalThis.ResizeObserver }) {
  let state = initialPick();
  let key = null;   // which project the state belongs to; null until the first look
  let picks = 0;    // counts the user's own picks, so a late answer never undoes one

  function layout() {
    const show = video.videoWidth
      ? onShow({ width: wrap.clientWidth, height: wrap.clientHeight }, state, video.videoWidth, video.videoHeight)
      : null;
    wrap.classList.toggle("has-ratio", !!show);
    canvas.hidden = !show;
    preview.hidden = !show || state.preview === "none";
    if (!show) {
      video.style.width = video.style.height = "";
    } else {
      video.style.width = show.picture.width + "px";
      video.style.height = show.picture.height + "px";
      for (const el of [canvas, preview]) {
        el.style.left = show.canvas.left + "px";
        el.style.top = show.canvas.top + "px";
        el.style.width = show.canvas.width + "px";
        el.style.height = show.canvas.height + "px";
      }
      preview.style.fontSize = show.canvas.width / 100 + "px";
    }
    onLayout();
  }

  function paint() {
    const project = getProject();
    ratioBtn.textContent = ratioLabel(state);
    // Sound alone has no picture to put in a canvas: off, as with no project.
    ratioBtn.disabled = previewBtn.disabled = !project || isAudio(project);
    ratioBtn.classList.toggle("on", state.ratio !== "original");
    previewBtn.classList.toggle("on", state.preview !== "none");
    ratioMenu.innerHTML = menuHtml(RATIOS, state.ratio,
      { original: shapeName(video.videoWidth, video.videoHeight) });
    previewMenu.innerHTML = previewMenuHtml(state.preview);
    preview.innerHTML = previewHtml(state.preview);
    layout();
  }

  function closeMenus() {
    for (const [btn, menu] of [[ratioBtn, ratioMenu], [previewBtn, previewMenu]]) {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  }

  function save() {
    const project = getProject();
    if (!project) return;
    if (project.kind === "draft") { saveDraftRatio(state.ratio); return; }
    fetch(`/api/dub/jobs/${project.id}/view`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratio: state.ratio }),
    }).catch(() => {});   // the next pick saves again
  }

  function set(next) {
    const moved = next.ratio !== state.ratio;
    picks += 1;
    state = next;
    paint();
    if (moved) save();
  }

  /** The player is on another project (or none): take up its ratio. */
  async function refresh() {
    const project = getProject();
    const now = project ? `${project.kind}:${project.id}` : "";
    if (now === key) { paint(); return; }
    key = now;
    closeMenus();
    state = initialPick();
    if (project && project.kind === "draft") state = pickRatio(state, project.ratio || "original");
    paint();
    if (!project || project.kind !== "job") return;
    let view = null;
    const before = picks;
    try {
      const res = await fetch(`/api/dub/jobs/${project.id}/view`);
      if (res.ok) view = await res.json();
    } catch { /* original stands */ }
    // Another project was opened meanwhile, or the user has already picked.
    if (key !== now || picks !== before || !view) return;
    state = pickRatio(initialPick(), view.ratio);
    paint();
  }

  /** A draft became this job: the job starts on the ratio the draft was on. */
  function carryTo(jobId) {
    if (!String(key).startsWith("draft:") || state.ratio === "original") return;
    fetch(`/api/dub/jobs/${jobId}/view`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratio: state.ratio }),
    }).catch(() => {});
  }

  for (const [btn, menu, pick] of [[ratioBtn, ratioMenu, pickRatio], [previewBtn, previewMenu, pickPreview]]) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = e.target.closest("[data-id]");
      if (!item) return;
      closeMenus();
      set(pick(state, item.dataset.id));
    });
  }
  doc.addEventListener("click", closeMenus);
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
  for (const e of ["loadedmetadata", "emptied"]) video.addEventListener(e, () => refresh());
  if (ResizeObserver) new ResizeObserver(layout).observe(wrap);
  refresh();

  return {
    refresh, carryTo, layout,
    /** The ratio on show: "original" or one of the four. */
    current: () => state.ratio,
    /** The preview on show: "none" or a platform. */
    currentPreview: () => state.preview,
    /** A download link for this project with its ratio on it. */
    exportUrl: (url) => withRatio(url, state.ratio),
  };
}
