// Who is speaking, numbered. The diarizer's own labels ("SPEAKER_00") mean
// nothing to a reader, so the table's chips and the timeline's badges both say
// A, B, C in the order the voices first speak -- letters rather than numbers
// because the column beside them already counts the lines, and two columns of
// digits side by side read as one (user, 2026-09-09).
//
// Its own file because two screens read the same answer: a line that is
// Speaker 2 in the table must be 2 on the strip below it, and two copies of
// "number them as they first speak" is how the two would come to disagree.

/**
 * Number the speakers in the order they first say something.
 *
 * @param {{speaker?: string}[]} lines  the script's lines, in time order
 * @returns {Map<string, number>} the diarizer's label -> its number, starting
 *          at 1. Lines with no speaker are not in it; a script where nobody is
 *          labelled gives an empty map, and `.size` is how many voices there
 *          are -- which is what says whether a number is worth showing at all.
 */
export function numberSpeakers(lines) {
  const seen = new Map();
  for (const l of lines) {
    if (l.speaker && !seen.has(l.speaker)) seen.set(l.speaker, seen.size + 1);
  }
  return seen;
}

/**
 * The letter a speaker wears: 1 -> A, 2 -> B, 26 -> Z, 27 -> AA.
 *
 * The numbering stays the numbering -- everything else counts with it -- and
 * this is only how it is written down where space is short.
 *
 * @param {number} n  a speaker's number, 1-based
 * @returns {string} its letters, or "" for anything that is not a whole
 *          number of at least one.
 */
export function speakerLetter(n) {
  if (!Number.isInteger(n) || n < 1) return "";
  let out = "";
  let left = n;
  while (left > 0) {
    const rest = (left - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    left = Math.floor((left - 1) / 26);
  }
  return out;
}
