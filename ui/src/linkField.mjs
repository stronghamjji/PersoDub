// What counts as a link, and the one sentence every link field says to
// something that is not one (the Import block's, ui/src/importBlock.mjs).
// Also the one way a link field is pointed at (askForLink).
const LINK_RE = /^https?:\/\/\S+$/;
/** What every link field says to something that is not a link. */
export const NOT_A_LINK = "That is not a link. Paste one that starts with https://";
export const isLink = (text) => LINK_RE.test(String(text || "").trim());

// How long the field's two blinks take (app.css "link-ask": half a second,
// twice). The mark comes off after them, so the field does not blink again
// by itself the next time its screen is shown.
const ASK_MS = 1000;
const asking = new WeakMap();

/** Point at a link field: its ring blinks white twice (stands still for
    someone who asked for less motion), and the caret is in it. `row` is the
    field's frame, `input` the field. */
export function askForLink(row, input) {
  clearTimeout(asking.get(row));
  row.classList.remove("ask");
  void row.offsetWidth;   // read in between, so a second press blinks again from the start
  row.classList.add("ask");
  asking.set(row, setTimeout(() => row.classList.remove("ask"), ASK_MS));
  input.focus();
}
