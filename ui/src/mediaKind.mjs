// A project is a video, or sound with no picture: the one place the page asks
// which. The app decides it once, when the file comes in, and says it as
// `media: "audio"` on the job record, on the held upload and so on the draft
// made from it; no mark means a video, which is every project made before
// audio came in. Everything that shows a picture -- the video box, the
// timeline's film strip, the cards on Home, the tabs that work on the picture
// -- asks isAudio() rather than reading the mark itself.
//
// Before a file is sent there is only its name to go by: fileKind() and the
// two refusals say which files each tool takes. The app looks inside the file
// when it arrives and has the last word.
import { t } from "./i18n.mjs";

const KINDS = { mp4: "video", mov: "video", wav: "audio", flac: "audio", mp3: "audio", m4a: "audio" };

/** Is this a project of sound alone? Asked of a job record, a draft or a held upload. */
export function isAudio(thing) {
  return !!thing && thing.media === "audio";
}

/** "video" or "audio" by the end of a file's name; "" for a file dubbing does not take. */
export function fileKind(name) {
  const ext = /\.([^./\\]+)$/.exec(String(name || ""));
  return (ext && KINDS[ext[1].toLowerCase()]) || "";
}

/** Why dubbing does not take this file, or null when it does. */
export function dubFormatProblem(file) {
  return fileKind(file.name) ? null : t("Only MP4 or MOV video and WAV, FLAC, MP3 or M4A audio can be used.");
}

/** Why a tool that works on the picture (Erase subtitles, Burn in subtitles)
 *  does not take this file, or null when it does. */
export function videoFormatProblem(file) {
  const kind = fileKind(file.name);
  if (kind === "video") return null;
  return kind === "audio" ? t("This tool takes video files only.") : t("Please choose an MP4 or MOV video file.");
}
