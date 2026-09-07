// Where a subtitle's words break into lines, and how big its box is.
//
// The player draws the subtitle, and the exported video has it drawn again by
// ffmpeg. Two drawings from two different rulers came out different: the burn
// guessed letter widths and broke "…a single soul" onto two lines where the
// screen showed one (user, 2026-09-07). Now the player is the ruler for both:
// it measures with the real font, keeps the result as the job's `layout`, and
// the burn draws that verbatim (app/subtitle_ass.py).
//
// This file is the arithmetic only. It takes a ruler -- a function from text
// to width -- so the page can hand it a canvas that measures in the burn's
// font, and the tests can hand it one where every letter is 10 wide.

/** The burn's fonts (app/api/results.py, _BURN_FONT), one per platform. The
 *  page lists all three so the browser lands on the one ffmpeg will use. */
export const SUB_FONT_STACK = ["Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR"];
export const SUB_FONT_CSS = SUB_FONT_STACK.map((f) => `"${f}"`).join(", ") + ", sans-serif";

/**
 * Break text into lines no wider than `room`, by the ruler's measure.
 * Breaks fall between words; a single word wider than the room is broken
 * between letters, which is how Chinese and Japanese -- no spaces -- wrap.
 * The writer's own line breaks are kept.
 */
export function wrapLines(text, room, ruler) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of raw.split(" ")) {
      const next = line ? line + " " + word : word;
      if (line && ruler(next) > room) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
      while (line.length > 1 && ruler(line) > room) {
        let cut = line.length - 1;
        while (cut > 1 && ruler(line.slice(0, cut)) > room) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * The lines and the box, in the ruler's units.
 *   boxWidth  a fixed outer width (the user dragged the handles), or null to
 *             hug the widest line
 *   cap       the widest a box may be (the page's max-width)
 *   padX/padY the box's padding on each side
 *   lineHeight one line's height in the font
 */
export function layoutOf({ text, ruler, boxWidth, cap, padX, padY, lineHeight }) {
  const fixed = boxWidth == null ? null : Math.min(boxWidth, cap);
  const room = Math.max(1, (fixed == null ? cap : fixed) - 2 * padX);
  const lines = wrapLines(text, room, ruler);
  const widest = Math.max(...lines.map(ruler));
  const w = fixed == null ? Math.min(cap, widest + 2 * padX) : fixed;
  return { lines, w, h: lines.length * lineHeight + 2 * padY };
}

/**
 * Where the picture sits inside a <video> element that keeps its aspect
 * (object-fit: contain): the element's box less the letterbox. Subtitles are
 * placed against the picture, as the burn places them.
 */
export function pictureRect({ left, top, width, height, videoWidth, videoHeight }) {
  if (!videoWidth || !videoHeight || !width || !height) return { left, top, width, height };
  const s = Math.min(width / videoWidth, height / videoHeight);
  const w = videoWidth * s, h = videoHeight * s;
  return { left: left + (width - w) / 2, top: top + (height - h) / 2, width: w, height: h };
}
