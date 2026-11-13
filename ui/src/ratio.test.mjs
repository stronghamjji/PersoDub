// The Ratio and Preview buttons: what is picked, where the canvas and the
// picture sit for each ratio, and the shapes a platform preview draws.
//
// Run with: node --test ui/src/ratio.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { RATIOS, PREVIEWS, ratioParts, shapeName, canvasRect, pictureInCanvas, exportCanvas,
         initialPick, pickRatio, pickPreview, ratioLabel, withRatio, onShow,
         previewElements, previewHtml, initRatioUi } from "./ratio.mjs";
import { pictureRect } from "./subtitleLayout.mjs";
import { toScreen, toVideo } from "./eraseArea.mjs";
import { setDraft, getDraft, setDraftRatio, clearDraft, onDraftChange } from "./draft.mjs";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const rounded = (r) => [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 100) / 100);

// ---- The menus ------------------------------------------------------------

test("the ratio menu is Original and the four shapes, named for where they go", () => {
  assert.deepEqual(RATIOS.map((r) => [r.label, r.note || ""]), [
    ["Original", ""],
    ["9:16", "TikTok · Reels · Shorts"],
    ["16:9", "YouTube"],
    ["1:1", "Instagram"],
    ["4:5", "Instagram feed"],
  ]);
});

test("the preview menu is the three apps and None", () => {
  assert.deepEqual(PREVIEWS.map((p) => p.label), ["TikTok", "YouTube Shorts", "Instagram Reels", "None"]);
});

test("Original is named by the picture's own shape", () => {
  assert.equal(shapeName(1920, 1080), "16:9");
  assert.equal(shapeName(854, 480), "16:9");
  assert.equal(shapeName(1080, 1920), "9:16");
  assert.equal(shapeName(1080, 1350), "4:5");
  assert.equal(shapeName(1000, 1000), "1:1");
  assert.equal(shapeName(1000, 617), "");   // no everyday name: say nothing
  assert.equal(shapeName(0, 0), "");
});

test("a ratio is two numbers, and Original is none", () => {
  assert.deepEqual(ratioParts("9:16"), [9, 16]);
  assert.equal(ratioParts("original"), null);
  assert.equal(ratioParts("7:3"), null);
});

// ---- What is picked -------------------------------------------------------

test("nothing picked: Original, no preview, and the Ratio button says its name", () => {
  const s = initialPick();
  assert.deepEqual(s, { ratio: "original", preview: "none" });
  assert.equal(ratioLabel(s), "Ratio");
});

test("the Ratio button shows the picked ratio", () => {
  for (const id of ["9:16", "16:9", "1:1", "4:5"]) {
    assert.equal(ratioLabel(pickRatio(initialPick(), id)), id);
  }
  assert.equal(ratioLabel(pickRatio(pickRatio(initialPick(), "1:1"), "original")), "Ratio");
});

test("picking a platform leaves the project's ratio alone, and so does None", () => {
  for (const id of ["tiktok", "reels", "shorts"]) {
    for (const from of ["original", "16:9", "1:1", "4:5", "9:16"]) {
      const s = pickPreview(pickRatio(initialPick(), from), id);
      assert.deepEqual(s, { ratio: from, preview: id });
      assert.equal(ratioLabel(s), from === "original" ? "Ratio" : from);
      assert.deepEqual(pickPreview(s, "none"), { ratio: from, preview: "none" });
    }
  }
});

test("picking a ratio leaves the preview on", () => {
  const on = pickPreview(initialPick(), "tiktok");
  assert.deepEqual(pickRatio(on, "1:1"), { ratio: "1:1", preview: "tiktok" });
});

test("a preview shows the picture in a 9:16 canvas whatever the project's ratio", () => {
  const phone = canvasRect(BOX, "9:16");
  const s = pickPreview(initialPick(), "reels");
  const a = onShow(BOX, s, 1920, 1080);
  assert.deepEqual(rounded(a.canvas), rounded(phone));
  assert.deepEqual(rounded(a.picture), rounded(pictureInCanvas(phone, 1920, 1080)));
  // A portrait picture in a 16:9 project: the 16:9 canvas across the phone,
  // the picture as tall as that canvas.
  const b = onShow(BOX, pickRatio(s, "16:9"), 1080, 1920);
  assert.deepEqual(rounded(b.canvas), rounded(phone));
  assert.ok(near(b.picture.height, phone.width * 9 / 16));
  // No preview: the project's own canvas, or none.
  assert.deepEqual(rounded(onShow(BOX, pickRatio(initialPick(), "1:1"), 1920, 1080).canvas), [175, 0, 450, 450]);
  assert.equal(onShow(BOX, initialPick(), 1920, 1080), null);
});

test("a name that is not on a menu changes nothing", () => {
  const s = pickRatio(initialPick(), "1:1");
  assert.equal(pickRatio(s, "3:2"), s);
  assert.equal(pickPreview(s, "vine"), s);
});

test("a download link carries the ratio, and Original leaves it alone", () => {
  assert.equal(withRatio("/api/dub/result/j1", "original"), "/api/dub/result/j1");
  assert.equal(withRatio("/api/dub/result/j1", "9:16"), "/api/dub/result/j1?ratio=9%3A16");
  assert.equal(withRatio("/api/dub/result/j1/subtitled?preset=clean&download=1", "4:5"),
    "/api/dub/result/j1/subtitled?preset=clean&download=1&ratio=4%3A5");
});

// ---- The canvas and the picture, for each ratio ---------------------------
// A 800 x 450 box, the player's room in the center panel.
const BOX = { width: 800, height: 450 };

test("Original has no canvas", () => {
  assert.equal(canvasRect(BOX, "original"), null);
});

test("each canvas is the largest of its shape that fits the box, centred", () => {
  assert.deepEqual(rounded(canvasRect(BOX, "9:16")), [273.44, 0, 253.13, 450]);
  assert.deepEqual(rounded(canvasRect(BOX, "16:9")), [0, 0, 800, 450]);
  assert.deepEqual(rounded(canvasRect(BOX, "1:1")), [175, 0, 450, 450]);
  assert.deepEqual(rounded(canvasRect(BOX, "4:5")), [220, 0, 360, 450]);
  // A tall box: the width is what runs out.
  assert.deepEqual(rounded(canvasRect({ width: 300, height: 900 }, "16:9")), [0, 365.63, 300, 168.75]);
  assert.deepEqual(rounded(canvasRect({ width: 300, height: 900 }, "9:16")), [0, 183.33, 300, 533.33]);
});

test("every canvas has its ratio and stays inside the box", () => {
  for (const box of [BOX, { width: 320, height: 600 }, { width: 1470, height: 300 }]) {
    for (const { id } of RATIOS.slice(1)) {
      const c = canvasRect(box, id), [w, h] = ratioParts(id);
      assert.ok(near(c.width / c.height, w / h), id);
      assert.ok(c.left >= -1e-9 && c.top >= -1e-9);
      assert.ok(c.left + c.width <= box.width + 1e-9 && c.top + c.height <= box.height + 1e-9);
      assert.ok(near(c.left * 2 + c.width, box.width) && near(c.top * 2 + c.height, box.height));
    }
  }
});

test("a landscape picture in a 9:16 canvas is as wide as the canvas, bars over and under", () => {
  const c = canvasRect(BOX, "9:16");
  const p = pictureInCanvas(c, 1920, 1080);
  assert.ok(near(p.width, c.width) && near(p.left, c.left));
  assert.ok(near(p.height, c.width * 9 / 16));
  assert.ok(near(p.top - c.top, (c.height - p.height) / 2));
});

test("a portrait picture in a 16:9 canvas is as tall as the canvas, bars at the sides", () => {
  const c = canvasRect(BOX, "16:9");
  const p = pictureInCanvas(c, 1080, 1920);
  assert.ok(near(p.height, c.height) && near(p.top, c.top));
  assert.ok(near(p.width, c.height * 9 / 16));
  assert.ok(near(p.left - c.left, (c.width - p.width) / 2));
});

test("1:1 and 4:5 hold a landscape picture across their width", () => {
  for (const id of ["1:1", "4:5"]) {
    const c = canvasRect(BOX, id);
    const p = pictureInCanvas(c, 1920, 1080);
    assert.ok(near(p.width, c.width), id);
    assert.ok(near(p.width / p.height, 16 / 9), id);
    assert.ok(near(p.top + p.height / 2, c.top + c.height / 2), id);
  }
});

test("a picture that already has the canvas's shape fills it", () => {
  const c = canvasRect(BOX, "9:16");
  const p = pictureInCanvas(c, 1080, 1920);
  assert.deepEqual(rounded(p), rounded(c));
});

test("the picture keeps its own shape in every canvas", () => {
  for (const [vw, vh] of [[1920, 1080], [1080, 1920], [720, 720], [1080, 1350]]) {
    for (const { id } of RATIOS.slice(1)) {
      const c = canvasRect(BOX, id);
      const p = pictureInCanvas(c, vw, vh);
      assert.ok(near(p.width / p.height, vw / vh), `${vw}x${vh} in ${id}`);
      assert.ok(p.left >= c.left - 1e-9 && p.left + p.width <= c.left + c.width + 1e-9);
      assert.ok(p.top >= c.top - 1e-9 && p.top + p.height <= c.top + c.height + 1e-9);
    }
  }
});

// ---- The subtitles and the erase box still map to the video's pixels -------

test("the subtitle overlay's rectangle on a padded canvas is the picture, not the canvas", () => {
  // The page sizes the <video> to the picture inside the canvas, and the
  // overlay asks pictureRect about that element, as it does with no canvas.
  const c = canvasRect(BOX, "9:16");
  const el = pictureInCanvas(c, 1920, 1080);
  const overlay = pictureRect({ ...el, videoWidth: 1920, videoHeight: 1080 });
  assert.deepEqual(rounded(overlay), rounded(el));
  // A subtitle dragged to 25% down the overlay is 25% down the VIDEO.
  const y = overlay.top + overlay.height * 0.25;
  assert.ok(near((y - el.top) / el.height * 1080, 270));
  // And asking about the canvas itself gives the same picture: the black
  // bars are letterbox, which pictureRect already takes off.
  assert.deepEqual(rounded(pictureRect({ ...c, videoWidth: 1920, videoHeight: 1080 })), rounded(el));
});

test("the erase box reads the same video pixels on a padded canvas as on the bare picture", () => {
  const area = [800, 1000, 200, 1700];   // y0, y1, x0, x1 in a 1920x1080 frame
  for (const { id } of RATIOS.slice(1)) {
    const c = canvasRect(BOX, id);
    const stage = { width: c.width, height: c.height };
    const onScreen = toScreen(area, stage, 1920, 1080);
    const pic = pictureInCanvas({ left: 0, top: 0, ...stage }, 1920, 1080);
    // Drawn on the picture, not on the bars.
    assert.ok(onScreen.top >= pic.top && onScreen.top + onScreen.height <= pic.top + pic.height + 1e-9, id);
    assert.deepEqual(toVideo(onScreen, stage, 1920, 1080).map(Math.round), area, id);
  }
});

// ---- The exported canvas, as app/ratio.py works it out ---------------------

test("the exported canvas keeps the picture's own pixels and grows the other side", () => {
  assert.deepEqual(exportCanvas(1920, 1080, "9:16"), { width: 1920, height: 3414 });
  assert.deepEqual(exportCanvas(1080, 1920, "16:9"), { width: 3414, height: 1920 });
  assert.deepEqual(exportCanvas(1920, 1080, "1:1"), { width: 1920, height: 1920 });
  assert.deepEqual(exportCanvas(1920, 1080, "4:5"), { width: 1920, height: 2400 });
  assert.deepEqual(exportCanvas(1080, 1920, "4:5"), { width: 1536, height: 1920 });
  assert.equal(exportCanvas(1920, 1080, "original"), null);
  assert.equal(exportCanvas(1920, 1080, "16:9"), null);
  assert.equal(exportCanvas(854, 480, "16:9"), null);
});

// ---- The platform previews -------------------------------------------------

test("None draws nothing", () => {
  assert.deepEqual(previewElements("none"), []);
  assert.equal(previewHtml("none"), "");
});

test("each platform has the phone's bar, a right-hand column, words at the bottom left and a plain corner shape", () => {
  const words = (id, zone) => previewElements(id).filter((e) => e.kind === "text" && e.zone === zone).map((e) => e.text);
  const icons = (id, zone) => previewElements(id).filter((e) => e.kind === "icon" && e.zone === zone).map((e) => e.name);
  for (const id of ["tiktok", "reels", "shorts"]) {
    assert.deepEqual(words(id, "status"), ["9:41"], id);
    assert.ok(words(id, "caption").includes("Here are some descriptions about videos"), id);
    assert.equal(previewElements(id).filter((e) => e.zone === "corner").length, 1, id);
  }
  assert.deepEqual(icons("reels", "rail"), ["heart", "message-circle", "send", "ellipsis"]);
  assert.deepEqual(words("reels", "rail"), ["2.8M", "2.8M", "2.8M"]);
  assert.deepEqual(words("reels", "caption"), ["@Your name", "Here are some descriptions about videos", "Music name"]);
  assert.deepEqual(icons("reels", "top"), ["search", "camera"]);
  assert.deepEqual(icons("tiktok", "rail"), ["heart", "message-circle", "bookmark", "share-arrow"]);
  assert.deepEqual(words("tiktok", "top"), ["Explore", "Following", "For You"]);
  assert.deepEqual(words("tiktok", "caption"), ["Your name", "Here are some descriptions about videos", "See original"]);
  assert.deepEqual(icons("shorts", "rail"), ["thumbs-up", "thumbs-down", "message-square-text", "share-arrow", "circle-plus-arrows"]);
  assert.deepEqual(words("shorts", "rail"), ["2.8M", "Dislike", "2.8M", "2.8M", "2.8M"]);
  assert.deepEqual(icons("shorts", "top"), ["search", "ellipsis-vertical"]);
});

test("every element is inside the canvas: the column at the right, the words at the bottom left", () => {
  for (const id of ["tiktok", "reels", "shorts"]) {
    for (const e of previewElements(id)) {
      const x = e.kind === "text" && !e.center ? e.x : e.cx ?? e.x;
      const half = e.kind === "text" ? 0 : e.w / 2;
      assert.ok(x - half >= 0 && x + half <= 1 && e.cy > 0 && e.cy < 1, `${id} ${e.name || e.text}`);
      if (e.zone === "rail" || e.zone === "corner") assert.ok(x > 0.85, `${id} ${e.name || e.text}`);
      if (e.zone === "caption") assert.ok(x < 0.2 && e.cy > 0.8, `${id} ${e.text || e.name}`);
      if (e.zone === "status") assert.ok(e.cy < 0.05, id);
    }
  }
});

test("the interface is drawn in percent and em, with no safe-area box", () => {
  const html = previewHtml("reels");
  assert.equal((html.match(/<i /g) || []).length, previewElements("reels").length);
  assert.match(html, /class="rp-text" style="left:5\.58%;top:3\.36%;font-size:4\.81em;font-weight:600">9:41</);
  assert.match(html, />@Your name</);
  assert.doesNotMatch(html, /Safe area|<img|url\(/);
});

// ---- Wired to the page ------------------------------------------------------

function el() {
  const listeners = {};
  const attrs = {};
  const classes = new Set();
  return {
    textContent: "", innerHTML: "", hidden: false, disabled: false, style: {}, dataset: {},
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    fire: (ev, e = {}) => { for (const fn of listeners[ev] || []) fn({ stopPropagation() {}, ...e }); },
  };
}

function harness({ project = { kind: "job", id: "j1" }, views = {}, box = BOX, size = [1920, 1080] } = {}) {
  const h = {
    video: Object.assign(el(), { videoWidth: size[0], videoHeight: size[1] }),
    wrap: Object.assign(el(), { clientWidth: box.width, clientHeight: box.height }),
    canvas: el(), preview: el(), ratioBtn: el(), ratioMenu: el(), previewBtn: el(), previewMenu: el(),
    doc: el(), project, views, puts: [], layouts: 0, draftRatios: [],
  };
  h.fetch = async (url, opts = {}) => {
    const jid = /jobs\/([^/]+)\/view/.exec(url)[1];
    if (opts.method === "PUT") {
      h.puts.push([jid, JSON.parse(opts.body)]);
      h.views[jid] = JSON.parse(opts.body);
      return { ok: true, json: async () => h.views[jid] };
    }
    return { ok: true, json: async () => h.views[jid] || { ratio: "original" } };
  };
  h.ui = initRatioUi({
    video: h.video, wrap: h.wrap, canvas: h.canvas, preview: h.preview,
    ratioBtn: h.ratioBtn, ratioMenu: h.ratioMenu, previewBtn: h.previewBtn, previewMenu: h.previewMenu,
    getProject: () => h.project, saveDraftRatio: (r) => h.draftRatios.push(r),
    onLayout: () => { h.layouts += 1; }, fetch: h.fetch, doc: h.doc, ResizeObserver: null,
  });
  h.pick = (menu, id) => menu.fire("click", { target: { closest: () => ({ dataset: { id } }) } });
  return h;
}
const settle = () => new Promise((r) => setTimeout(r));
const px = (s) => Math.round(parseFloat(s) * 100) / 100;

test("with nothing picked the video is left to the page, and no canvas shows", () => {
  const h = harness();
  assert.equal(h.ratioBtn.textContent, "Ratio");
  assert.equal(h.previewBtn.classList.contains("on"), false);
  assert.match(h.previewMenu.innerHTML, /Preview your video for social media.*What you see may vary depending on your device\..*TikTok.*YouTube Shorts.*Instagram Reels.*<hr>.*data-id="none" aria-checked="true">None</);
  assert.equal(h.canvas.hidden, true);
  assert.equal(h.preview.hidden, true);
  assert.equal(h.video.style.width, "");
  assert.equal(h.wrap.classList.contains("has-ratio"), false);
  assert.match(h.ratioMenu.innerHTML, /data-id="original" aria-checked="true" class="on">Original<span>16:9<\/span>/);
});

test("the buttons open one menu at a time, and a click elsewhere closes it", () => {
  const h = harness();
  assert.equal(h.ratioMenu.hidden, true);
  h.ratioBtn.fire("click");
  assert.equal(h.ratioMenu.hidden, false);
  assert.equal(h.ratioBtn.getAttribute("aria-expanded"), "true");
  h.previewBtn.fire("click");
  assert.deepEqual([h.ratioMenu.hidden, h.previewMenu.hidden], [true, false]);
  h.doc.fire("click");
  assert.deepEqual([h.ratioMenu.hidden, h.previewMenu.hidden], [true, true]);
  h.ratioBtn.fire("click");
  h.doc.fire("keydown", { key: "Escape" });
  assert.equal(h.ratioMenu.hidden, true);
});

test("picking 9:16 draws the canvas, sizes the video to the picture and saves it with the job", () => {
  const h = harness();
  h.ratioBtn.fire("click");
  h.pick(h.ratioMenu, "9:16");
  assert.equal(h.ratioMenu.hidden, true);
  assert.equal(h.ratioBtn.textContent, "9:16");
  assert.equal(h.canvas.hidden, false);
  assert.equal(h.wrap.classList.contains("has-ratio"), true);
  assert.deepEqual([h.canvas.style.left, h.canvas.style.top, h.canvas.style.width, h.canvas.style.height].map(px),
    [273.44, 0, 253.13, 450]);
  // The element is the picture: 253.13 wide, 16:9.
  assert.deepEqual([px(h.video.style.width), px(h.video.style.height)], [253.13, 142.38]);
  assert.deepEqual(h.puts, [["j1", { ratio: "9:16" }]]);
  assert.ok(h.layouts > 0);
  assert.equal(h.ui.current(), "9:16");
  assert.equal(h.ui.exportUrl("/api/dub/result/j1"), "/api/dub/result/j1?ratio=9%3A16");
});

test("going back to Original hands the video back to the page", () => {
  const h = harness();
  h.pick(h.ratioMenu, "1:1");
  h.pick(h.ratioMenu, "original");
  assert.equal(h.canvas.hidden, true);
  assert.equal(h.video.style.width, "");
  assert.equal(h.video.style.height, "");
  assert.equal(h.ui.exportUrl("/x"), "/x");
  assert.deepEqual(h.puts.map((p) => p[1].ratio), ["1:1", "original"]);
});

test("picking Reels on a 1:1 project shows the phone and changes neither the ratio nor the export", () => {
  const h = harness();
  h.pick(h.ratioMenu, "1:1");
  h.pick(h.previewMenu, "reels");
  assert.equal(h.ratioBtn.textContent, "1:1");
  assert.equal(h.ui.current(), "1:1");
  assert.equal(h.ui.exportUrl("/x"), "/x?ratio=1%3A1");
  assert.deepEqual(h.puts, [["j1", { ratio: "1:1" }]]);   // the preview saved nothing
  assert.equal(h.previewBtn.classList.contains("on"), true);
  assert.equal(h.preview.hidden, false);
  assert.match(h.preview.innerHTML, /@Your name/);
  assert.match(h.previewMenu.innerHTML, /data-id="reels" aria-checked="true">Instagram Reels<svg/);
  // The canvas is the phone's 9:16, the interface lies exactly on it, and
  // an em in it is a hundredth of its width.
  assert.deepEqual([h.canvas.style.left, h.canvas.style.top, h.canvas.style.width, h.canvas.style.height].map(px),
    [273.44, 0, 253.13, 450]);
  assert.deepEqual([h.preview.style.left, h.preview.style.width].map(px), [273.44, 253.13]);
  assert.equal(px(h.preview.style.fontSize), 2.53);
  h.pick(h.previewMenu, "none");
  assert.equal(h.preview.hidden, true);
  assert.equal(h.previewBtn.classList.contains("on"), false);
  assert.deepEqual([h.canvas.style.left, h.canvas.style.width].map(px), [175, 450]);   // back on 1:1
  assert.equal(h.puts.length, 1);
});

test("a preview on an Original project exports the file as it is, and None hands the video back", () => {
  const h = harness();
  h.pick(h.previewMenu, "tiktok");
  assert.equal(h.canvas.hidden, false);
  assert.equal(h.ratioBtn.textContent, "Ratio");
  assert.equal(h.ui.exportUrl("/api/dub/result/j1"), "/api/dub/result/j1");
  assert.deepEqual(h.puts, []);
  h.pick(h.previewMenu, "none");
  assert.equal(h.canvas.hidden, true);
  assert.equal(h.video.style.width, "");
});

test("a job opens on the ratio it was left on, and another job on its own", async () => {
  const h = harness({ views: { j1: { ratio: "4:5" } } });
  await settle();
  assert.equal(h.ratioBtn.textContent, "4:5");
  h.project = { kind: "job", id: "j2" };
  h.views.j2 = { ratio: "1:1" };
  await h.ui.refresh();
  await settle();
  assert.equal(h.ratioBtn.textContent, "1:1");
  h.project = { kind: "job", id: "j1" };
  await h.ui.refresh();
  await settle();
  assert.equal(h.ratioBtn.textContent, "4:5");
  assert.deepEqual(h.puts, []);   // opening a project saves nothing
  h.project = { kind: "job", id: "j3" };
  await h.ui.refresh();
  await settle();
  assert.equal(h.ratioBtn.textContent, "Ratio");
});

test("a pick made while the job's own ratio is still being read is not undone", async () => {
  const h = harness({ views: { j1: { ratio: "4:5" } } });
  h.pick(h.ratioMenu, "1:1");
  await settle();
  assert.equal(h.ratioBtn.textContent, "1:1");
});

test("the preview does not follow from one project to the next", async () => {
  const h = harness();
  h.pick(h.previewMenu, "tiktok");
  h.project = { kind: "job", id: "j2" };
  h.views.j2 = { ratio: "9:16" };
  await h.ui.refresh();
  await settle();
  assert.equal(h.ui.current(), "9:16");
  assert.equal(h.ui.currentPreview(), "none");
});

test("a draft keeps its ratio in the draft, and the job it becomes starts on it", async () => {
  const h = harness({ project: { kind: "draft", id: "d1", ratio: "original" } });
  await h.ui.refresh();
  await settle();
  h.pick(h.ratioMenu, "9:16");
  assert.deepEqual(h.draftRatios, ["9:16"]);
  assert.deepEqual(h.puts, []);
  h.ui.carryTo("j9");
  assert.deepEqual(h.puts, [["j9", { ratio: "9:16" }]]);
});

test("a draft on Original, or a job, carries nothing to a new job", async () => {
  const d = harness({ project: { kind: "draft", id: "d1", ratio: "original" } });
  await d.ui.refresh();
  await settle();
  d.ui.carryTo("j9");
  const j = harness();
  j.pick(j.ratioMenu, "1:1");
  j.ui.carryTo("j9");
  assert.deepEqual(d.puts, []);
  assert.deepEqual(j.puts, [["j1", { ratio: "1:1" }]]);
});

test("a draft reopened shows the ratio it carries", async () => {
  const h = harness({ project: null });
  assert.equal(h.ratioBtn.disabled, true);
  h.project = { kind: "draft", id: "d2", ratio: "4:5" };
  await h.ui.refresh();
  await settle();
  assert.equal(h.ratioBtn.disabled, false);
  assert.equal(h.ratioBtn.textContent, "4:5");
});

test("until the video knows its size there is no canvas, and then there is", () => {
  const h = harness({ size: [0, 0] });
  h.pick(h.ratioMenu, "9:16");
  assert.equal(h.canvas.hidden, true);
  assert.equal(h.video.style.width, "");
  h.video.videoWidth = 1080; h.video.videoHeight = 1920;
  h.video.fire("loadedmetadata");
  assert.equal(h.canvas.hidden, false);
  // A 9:16 picture in a 9:16 canvas fills it.
  assert.deepEqual([px(h.video.style.width), px(h.video.style.height)], [253.13, 450]);
});

// Sound has no picture to put in a canvas or under a phone's buttons.
test("an audio project's Ratio and Preview stay in their place, off, as they are with no project", () => {
  for (const project of [{ kind: "job", id: "j1", media: "audio" }, { kind: "draft", id: "d1", media: "audio" }]) {
    const h = harness({ project, size: [0, 0] });
    assert.equal(h.ratioBtn.disabled, true, project.kind);
    assert.equal(h.previewBtn.disabled, true, project.kind);
    assert.equal(h.ratioBtn.textContent, "Ratio");
    assert.equal(h.canvas.hidden, true);
  }
  // A video is as it was, and so is no project at all.
  const video = harness();
  assert.equal(video.ratioBtn.disabled, false);
  assert.equal(video.previewBtn.disabled, false);
  const none = harness({ project: null });
  assert.equal(none.ratioBtn.disabled, true);
});

test("the draft carries its ratio without redrawing everything that watches it", () => {
  setDraft({ downloadId: "d1", name: "a.mp4", duration: 10, videoUrl: "/v" });
  assert.equal(getDraft().ratio, "original");
  let told = 0;
  const off = onDraftChange(() => { told += 1; });
  setDraftRatio("9:16");
  assert.equal(getDraft().ratio, "9:16");
  assert.equal(told, 0);
  off();
  clearDraft();
  setDraftRatio("1:1");   // no draft: nothing to keep it in
  assert.equal(getDraft(), null);
});

// ---- The saves that carry the ratio (ui/src/dubApi.mjs) ---------------------

test("a saved clip and a saved erase carry the ratio only when one is picked", async () => {
  const { saveDownloadClip, saveErased } = await import("./dubApi.mjs");
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push([url, JSON.parse(opts.body)]);
    return { ok: true, json: async () => ({ path: "/x.mp4" }) };
  };
  try {
    await saveDownloadClip("d1", null);
    await saveDownloadClip("d1", null, { ratio: "original" });
    await saveDownloadClip("d1", { start: 2, end: 8 }, { ratio: "9:16" });
    await saveErased("e1");
    await saveErased("e1", { ratio: "1:1" });
    await saveErased("e1", { audio: "wav", ratio: "1:1" });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(sent, [
    ["/api/downloads/d1/save", {}],
    ["/api/downloads/d1/save", {}],
    ["/api/downloads/d1/save", { start: 2, end: 8, ratio: "9:16" }],
    ["/api/erase/e1/save", {}],
    ["/api/erase/e1/save", { ratio: "1:1" }],
    // The sound alone has no picture: the ratio stays behind.
    ["/api/erase/e1/save", { audio: "wav" }],
  ]);
});
