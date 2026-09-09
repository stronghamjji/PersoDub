// Who is speaking, numbered. The diarizer's own labels ("SPEAKER_00") mean
// nothing to a reader, so the table's chips and the timeline's badges both say
// "1", "2", "3" in the order the voices first speak.
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
