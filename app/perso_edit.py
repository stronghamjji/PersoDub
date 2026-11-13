# -*- coding: utf-8 -*-
"""Editing a Perso dub on Perso's side, and bringing the result home.

A Perso dub made editable (app/perso_materialize.py) is a folder of local
files, and until now a rewritten line was spoken again by this computer's own
engine -- so the line came back in a different voice. Here the line goes back
to Perso instead: Perso speaks it in the voice it dubbed with, and the new
audio replaces the line's wav in the same folder. Everything after that --
the rebuild, the script table, the timeline, export -- is the code that was
already there, reading the same files.

THE RULE between the two ways of remaking a voice, in one place:

  A job is Perso's to edit until a voice in it is made on this computer.
  From the first such voice on, Perso editing is off for that job and says
  so. The two are never mixed silently: Perso's copy of the project does not
  know about a voice made here, so a later proofread would bring back
  Perso's version of that line and the user's would be gone without a word.

  The other direction is guarded too. A proofread replaces every line with
  what Perso made, so it is refused while a line's words are waiting for
  their voice -- those words exist only here, and would be lost. The one
  exception is a NIGHTINGALE project, where Perso makes no single line's
  voice and a proofread is the only way to have new words spoken: there the
  waiting words are sent to Perso first, and then proofread with the rest.

What was made where is read off two small records in the job's folder:
voice_texts.json (app/dub_script.py: every voice made after the dub, by
whoever) and perso_voices.json (here: the ones Perso made). A line in the
first that is not in the second with the same words was made on this computer.

Nothing in this file logs a line's words.
"""
import contextlib
import json
import logging
import os
import shutil
import threading
import time
from typing import Optional

from app import media, perso_materialize
from app.dub_script import (
    EDITED_NAME,
    VOICE_TEXTS_NAME,
    _voice_texts,
    edit_line,
    load_lines,
    note_voice_text,
)
from app.i18n import t
from app.jobs import JobStatus
from app.perso_client import NIGHTINGALE, note_credits

logger = logging.getLogger("persodub.perso_edit")

RECORD_NAME = "perso_voices.json"

# How long a "Perso was asked, the voice has not come back yet" note is
# believed. Past it the line is asked for again rather than waited on forever.
PENDING_S = 600
# How many times the script is read again for a voice Perso said it made.
AUDIO_TRIES = 12


class Refused(Exception):
    """Perso editing said no, in words fit for the screen."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


# Kept in English: the Dub Agent's tools know this reason by its words
# (app/mcp_server.py _perso_edit), and it is the one that means "remake it on
# this computer" rather than "stop".
LOCAL_VOICE = ("A voice in this job was made on this computer, so it is no longer "
               "edited through Perso.")


# The other reasons, said when they are asked for: in the user's language,
# which can change while the app runs.
def not_perso() -> str:
    return t("This job was not dubbed by Perso.")


def still_running() -> str:
    return t("This job is still running.")


def busy() -> str:
    return t("Perso is already working on this job. Wait for it to finish.")


def never_fetched() -> str:
    return t("Perso redid this job and the result was never fetched. "
             "Press All at once to fetch it. It is not paid for again.")


def never_voiced(line) -> str:
    return t("Line {line} has new words that were never voiced. Remake or revert "
             "it first: All at once replaces every line with Perso's.", line=line)


# Perso makes no single line's voice on these, and fetching one for editing
# ended in Perso's HTTP 500 on every press (Windows, 2026-10-06).
def nightingale_fixed() -> str:
    return t("Nightingale dubbings cannot be edited line by line.")


# ── What is going on right now, per job. In memory: it is about this run. ──
_lock = threading.Lock()
_working = {}   # jid -> "line" | "proofread"
_errors = {}    # jid -> what the last proofread ended with, when it failed
_known = {}     # jid -> {"nightingale", "retranslate_available"}, as last read


@contextlib.contextmanager
def working(jid: str, what: str):
    """One piece of Perso work per job at a time."""
    with _lock:
        if jid in _working:
            raise Refused(busy())
        _working[jid] = what
        _errors.pop(jid, None)
    try:
        yield
    finally:
        with _lock:
            _working.pop(jid, None)


def _read(work_dir: str) -> dict:
    try:
        with open(os.path.join(work_dir, RECORD_NAME), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(work_dir: str, data: dict) -> None:
    path = os.path.join(work_dir, RECORD_NAME)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(path + ".tmp", path)


def voiced_here(work_dir: str) -> bool:
    """True once any voice in this job was made on this computer."""
    made = _read(work_dir).get("made") or {}
    return any(made.get(line) != text for line, text in _voice_texts(work_dir).items())


def project_of(job: dict) -> tuple:
    """(projectSeq, spaceSeq) -- the workspace is None on a job dubbed before
    it was kept, and the client's own is used then."""
    return int(job["perso_project_seq"]), job.get("perso_space_seq")


def nightingale(job: dict) -> Optional[bool]:
    """Whether this dub's Perso voice is NIGHTINGALE: the model the job was
    made with says so, else what Perso last said (None until it has)."""
    if job.get("perso_model") == NIGHTINGALE:
        return True
    with _lock:
        return (_known.get(job.get("id")) or {}).get("nightingale")


def state(job: dict, work_dir: str) -> dict:
    """Can this job be edited through Perso right now? No network: this rides
    on every reading of the script. The two facts only Perso knows are the
    ones it last told us (live_state), None until it has -- except a
    NIGHTINGALE dub's, which its own record names (nightingale())."""
    unfetched = False
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        reason = not_perso()
    elif job.get("status") in (JobStatus.RUNNING, JobStatus.CANCELLING, JobStatus.QUEUED):
        reason = still_running()
    elif voiced_here(work_dir):
        reason = LOCAL_VOICE
    else:
        # Asked of Perso, never brought home (the app was closed while Perso
        # worked): the lines here are the old ones until it is.
        unfetched = bool(_read(work_dir).get("proofread_asked"))
        reason = never_fetched() if unfetched else ""
    with _lock:
        known = dict(_known.get(job.get("id")) or {})
        now = _working.get(job.get("id"))
    return {"available": not reason, "reason": reason,
            "nightingale": nightingale(job),
            "retranslate_available": known.get("retranslate_available"),
            "working": now, "unfetched": unfetched and not now}


def live_state(pc, job: dict, work_dir: str, price: bool = False) -> dict:
    """state(), with Perso asked for its two facts. Free: two reads, and a
    third with price=True: what a proofread would cost (proofread_price)."""
    jid = job.get("id")
    model = None
    if job.get("dub_mode") == "perso" and job.get("perso_project_seq"):
        seq, space = project_of(job)
        model = pc.project_detail(seq, space).get("ttsModel")
        known = {
            "nightingale": model == NIGHTINGALE,
            "retranslate_available": pc.retranslation_status(seq, space),
        }
        with _lock:
            _known[jid] = known
    out = state(job, work_dir)
    with _lock:
        out["error"] = _errors.get(jid)
    if price:
        out["proofread_price"] = proofread_price(pc, job, work_dir, model)
    return out


def proofread_price(pc, job: dict, work_dir: str, model) -> Optional[float]:
    """Credits a proofread of this job would take, or None when that is not
    known. Never raises: the price is a courtesy beside the button, and the
    button works without it. Perso prices by the video's length and size,
    read off the copy in the job's folder.

    An audio project has no frame, and a cover picture's size is not one, so
    its size goes as 0 by 0 in the same request a video sends. Whether Perso
    prices that was not seen live: a refusal ends as any other does here,
    with no price."""
    try:
        seq, space = project_of(job)
        video = os.path.join(work_dir, "input.mp4")
        audio = job.get("media") == "audio"
        width, height = (0, 0) if audio else media.video_size(video)
        if not (width and height) and not audio:
            return None
        got = pc.proofread_price(seq, int(media.video_duration(video) * 1000),
                                 width, height, space, tts_model=model)
        # A NIGHTINGALE project's first proofread is free (the documents),
        # and the count is 1 until one has been done.
        if model == NIGHTINGALE and got.get("export_count") == 1:
            return 0
        return got.get("credits")
    except Exception as e:
        logger.debug("No proofread price (%s)", type(e).__name__)
        return None


def require(job: dict, work_dir: str) -> None:
    s = state(job, work_dir)
    if not s["available"]:
        raise Refused(s["reason"])


def _sentence(pc, job: dict, line: int, count: int) -> dict:
    """Perso's sentence for script line `line`. Lines and sentences are paired
    by order, so a project that no longer has as many as the script does is
    not one to write into by number."""
    seq, space = project_of(job)
    sents = pc.get_project_script(seq, space).get("sentences") or []
    if len(sents) != count:
        raise Refused(t("This project changed on Perso since it was fetched. "
                        "Use All at once, or make it editable again."))
    return sents[line - 1]


def _fresh_audio(pc, job: dict, line: int, count: int, before) -> str:
    """The address of the voice Perso just made, read off the script -- for an
    answer that did not carry one."""
    for attempt in range(AUDIO_TRIES):
        url = _sentence(pc, job, line, count).get("audioUrl")
        if url and url != before:
            return url
        if attempt < AUDIO_TRIES - 1:
            time.sleep(getattr(pc, "poll_interval", 10))
    raise Refused(t("Perso is still making this line's voice. Press the button "
                    "again in a minute: it is not paid for twice."), 504)


def _workspace(pc):
    # Plain, not a credit watch: an edit's cost is read the old way, so a
    # failed edit can never leave a watch open against every later call.
    return getattr(pc, "describe_workspace", lambda: None)()


def _credits(ws, pc, log, what: str) -> int:
    """What this piece of work cost, by the balance before and after."""
    if not ws:
        return 0
    before = getattr(pc, "credits_used", 0) or 0
    note_credits(ws, pc, log, what)
    return (getattr(pc, "credits_used", 0) or 0) - before


def _line_count(job: dict, work_dir: str, line: int) -> list:
    lines = load_lines(work_dir, job.get("language_code") or "en")
    if not 1 <= line <= len(lines):
        raise Refused(t("There is no line {line}.", line=line), 422)
    return lines


def _made(work_dir: str, line: int, text: str, was: str = "") -> None:
    """Line `line`'s voice is Perso's, made from `text`. `was` is what the
    user had written, when Perso put other words in its place."""
    note_voice_text(work_dir, line, text)
    rec = _read(work_dir)
    rec.setdefault("made", {})[str(line)] = text
    if was:
        rec.setdefault("reworded", {})[str(line)] = was
    else:
        rec.get("reworded", {}).pop(str(line), None)
    rec.pop("pending", None)
    _write(work_dir, rec)


def mark_reworded(work_dir: str, lines: list) -> None:
    """Give each line Perso reworded when it made the voice its `reworded`:
    the user's own words, for the screen to show beside Perso's. Only while
    the line still says what Perso made: an edit or a revert ends it.
    Perso cannot be told to keep the words as sent (no such field in its
    API, developers.perso.ai read 2026-10-01), so the change is said instead
    of passing in silence (night test 2026-10-01)."""
    rec = _read(work_dir)
    made, was = rec.get("made") or {}, rec.get("reworded") or {}
    for l in lines:
        n = str(l["line"])
        if n in was and made.get(n) == l["text"]:
            l["reworded"] = was[n]


def revoice_line(pc, job: dict, work_dir: str, line: int, log, rebuild, to_wav=None,
                 changed_only: bool = False) -> dict:
    """Send line `line`'s words, as the script now has them, to Perso; have
    Perso speak them; bring the voice home; rebuild() the video around it.
    SPENDS CREDITS.

    Asked twice for the same words, it pays once: what was asked is noted
    before Perso is and crossed out only when the video is whole again, so a
    press after a lost connection (or a rebuild that failed) finds the voice
    Perso had already made and only fetches it.

    Perso does not keep the words as sent: it takes them as the sentence's
    new source and translates them again, fitted to the sentence's time
    (seen live 2026-09-29: three words came back as five). What it keeps is
    what its voice says, so that is what the script here is set to.
    """
    require(job, work_dir)
    lines = _line_count(job, work_dir, line)
    text = lines[line - 1]["text"].strip()
    if not text:
        raise Refused(t("Line {line} has no words yet. Write its translation first.", line=line), 422)
    # Remake voices (changed_only) skips a line whose voice already says its
    # words: a table drawn before the agent remade the line offered it again
    # (night test 2026-10-01). A line asked for by name is still remade.
    if changed_only and not lines[line - 1]["voice_stale"]:
        return {"line": line, "ok": True, "unchanged": True, "reworded": False, "credits": 0}

    seq, _space = project_of(job)
    sent = _sentence(pc, job, line, len(lines))
    rec = _read(work_dir)
    pend = rec.get("pending") or {}
    before = sent.get("audioUrl")
    same = (pend.get("line") == line and pend.get("text") == text
            and time.time() - (pend.get("at") or 0) < PENDING_S)
    said = pend.get("said") or text
    ws = None
    # A sentence whose words were just changed has no voice at all until
    # Perso makes one (audioUrl comes back empty), hence `before and`.
    if (same and before and sent.get("translatedText") == said
            and before != pend.get("audio_before")):
        log("Line %d: Perso had already made this voice. Fetching it…" % line)
        audio = before
    elif same and pend.get("asked"):
        audio = _fresh_audio(pc, job, line, len(lines), pend.get("audio_before"))
    else:
        ws = _workspace(pc)
        rec["pending"] = {"line": line, "text": text, "audio_before": before,
                          "at": time.time()}
        _write(work_dir, rec)
        log("Line %d: asking Perso for a new voice…" % line)
        # Words Perso already holds and has no voice for (translate_lines
        # left them) are not sent again: it would translate them a second time.
        said = text if sent.get("translatedText") == text and not before else (
            pc.edit_sentence(seq, int(sent["seq"]), text).get("translatedText")
            or text).strip()
        rec["pending"]["said"] = said
        _write(work_dir, rec)
        # Perso speaks the words it saved; the text sent here is not used.
        made = pc.regenerate_sentence_audio(seq, int(sent["seq"]), said)
        rec["pending"]["asked"] = True
        _write(work_dir, rec)
        audio = (made.get("generateAudioFilePath")
                 or _fresh_audio(pc, job, line, len(lines), before))

    perso_materialize.fetch_line(pc, audio, work_dir, line - 1, to_wav)
    rebuild()
    if said != text:
        log("Line %d: Perso reworded it to fit its time." % line)
        # The script says what the voice says: Perso's words.
        edit_line(work_dir, line, said, job.get("language_code") or "en")
    _made(work_dir, line, said, text if said != text else "")
    return {"line": line, "ok": True, "reworded": said != text,
            **({"you_wrote": text, "perso_said": said} if said != text else {}),
            "credits": _credits(ws, pc, log, "the Perso voice")}


def translate_lines(pc, job: dict, work_dir: str, numbers: Optional[list], log) -> list:
    """Have Perso translate the given lines (all when None) again, from each
    line's source words, and write what it answers. Words only: no voice is
    made, here or on Perso, until revoice_line. One {"line", "was", "text"}
    per line whose words changed.

    Perso has no call that translates a sentence again by itself: its one
    sentence call takes words and translates them, fitted to the sentence's
    time (edit_sentence), so the source line is what it is sent. An answer
    that is empty, or the source handed back, changes nothing here."""
    require(job, work_dir)
    code = job.get("language_code") or "en"
    lines = load_lines(work_dir, code)
    wanted = set(numbers) if numbers is not None else {l["line"] for l in lines}
    unknown = sorted(n for n in wanted if not 1 <= n <= len(lines))
    if unknown:
        raise Refused(t("There is no line {line}.", line=unknown[0]), 422)
    seq, space = project_of(job)
    sents = pc.get_project_script(seq, space).get("sentences") or []
    if len(sents) != len(lines):
        raise Refused(t("This project changed on Perso since it was fetched. "
                        "Use All at once, or make it editable again."))
    changed = []
    for l in lines:
        source = (l["source"] or "").strip()
        if l["line"] not in wanted or not source:
            continue
        log("Line %d: asking Perso to translate it again…" % l["line"])
        said = (pc.edit_sentence(seq, int(sents[l["line"] - 1]["seq"]), source)
                .get("translatedText") or "").strip()
        if said and said not in (source, l["text"]):
            edit_line(work_dir, l["line"], said, code)
            changed.append({"line": l["line"], "was": l["text"], "text": said})
    return changed


def reset_line(pc, job: dict, work_dir: str, line: int, log, rebuild, to_wav=None) -> dict:
    """Put one line back to what Perso's last proofread left, words and voice,
    and bring both home. Counted as possibly spending credits."""
    require(job, work_dir)
    lines = _line_count(job, work_dir, line)
    seq, _space = project_of(job)
    sent = _sentence(pc, job, line, len(lines))
    ws = _workspace(pc)
    log("Line %d: asking Perso to put it back…" % line)
    pc.reset_sentence(seq, int(sent["seq"]))
    after = _sentence(pc, job, line, len(lines))
    text = after.get("translatedText") or ""
    if after.get("audioUrl"):
        perso_materialize.fetch_line(pc, after["audioUrl"], work_dir, line - 1, to_wav)
    if lines[line - 1]["text"] != text:
        edit_line(work_dir, line, text, job.get("language_code") or "en")
    rebuild()
    _made(work_dir, line, text)
    return {"line": line, "ok": True,
            "credits": _credits(ws, pc, log, "the Perso reset")}


def check_fit(pc, job: dict, work_dir: str, line: int, text: str) -> dict:
    """Perso's own verdict on `text` in line `line`'s time. Nothing is saved."""
    require(job, work_dir)
    lines = _line_count(job, work_dir, line)
    if not text.strip():
        raise Refused(t("There are no words to check."), 422)
    seq, _space = project_of(job)
    sent = _sentence(pc, job, line, len(lines))
    got = pc.match_rewrite(seq, int(sent["seq"]), text.strip())
    return {"line": line, "matching_rate": got.get("matchingRate"),
            "rewrite": got.get("rewrite")}


def fetch_project(pc, job: dict, work_dir: str, out_path: str, log, to_wav=None) -> dict:
    """Bring Perso's whole version home: the script, every line's voice and
    the finished video. Free -- downloads only. What was written here since
    is set aside, not mixed in: the words on screen become Perso's.

    An audio project has no video on Perso: its result is asked for as
    audio, and comes back as the WAV the job keeps (PersoClient.download_dub)."""
    seq, space = project_of(job)
    summary = perso_materialize.materialize(
        pc, seq, work_dir, job.get("language") or "English",
        to_wav=to_wav, log=log, refresh=True, space_seq=space)
    log("Downloading the finished video…")
    new = out_path + ".perso-new"
    try:
        # Only said when it is true, so a video's call is the one it always was.
        pc.download_dub(seq, new, space, **({"audio": True} if job.get("media") == "audio" else {}))
        os.replace(new, out_path)
    finally:
        with contextlib.suppress(OSError):
            os.remove(new)
    edited = os.path.join(work_dir, EDITED_NAME)
    if os.path.exists(edited):
        shutil.move(edited, os.path.join(work_dir, "edited.before-proofread.srt"))
    for name in (VOICE_TEXTS_NAME, RECORD_NAME):
        with contextlib.suppress(OSError):
            os.remove(os.path.join(work_dir, name))
    return summary


def check_proofread(pc, job: dict, work_dir: str) -> dict:
    """Everything that can refuse a proofread, asked before a thread is
    started for it. What comes back is the plan proofread() follows:

      fetch_only  the proofread was already asked for and only its result is
                  missing here -- fetching that costs nothing
      send        the lines whose new words go to Perso first (NIGHTINGALE)
    """
    s = state(job, work_dir)
    if s["reason"] == never_fetched():
        return {"fetch_only": True, "send": []}
    if not s["available"]:
        raise Refused(s["reason"])
    waiting = []
    if os.path.exists(os.path.join(work_dir, EDITED_NAME)):
        waiting = [l["line"] for l in load_lines(work_dir, job.get("language_code") or "en")
                   if l["voice_stale"] and l["text"].strip()]
    seq, space = project_of(job)
    if waiting:
        if pc.project_detail(seq, space).get("ttsModel") != NIGHTINGALE:
            raise Refused(never_voiced(waiting[0]))
        # Whether Perso would take a proofread is only known once the words
        # are there; if it would not, it says so itself.
        return {"fetch_only": False, "send": waiting}
    if not pc.retranslation_status(seq, space):
        raise Refused(t("Perso has nothing to redo in this project yet."))
    return {"fetch_only": False, "send": []}


def proofread(pc, job: dict, work_dir: str, out_path: str, log, plan: dict,
              to_wav=None) -> dict:
    """Have Perso go over the whole project again, wait, bring it home.
    SPENDS CREDITS, once: that it was asked is noted the moment Perso takes
    it, and the next call is told so (check_proofread's plan) and only waits
    and fetches."""
    seq, space = project_of(job)
    ws = None
    if plan["fetch_only"]:
        log("Perso was already asked to redo this. Waiting for it…")
        pc.wait_for_project(seq, space, what="All at once")
    else:
        ws = _workspace(pc)
        if plan["send"]:
            lines = load_lines(work_dir, job.get("language_code") or "en")
            for line in plan["send"]:
                log("Line %d: sending its new words to Perso…" % line)
                sent = _sentence(pc, job, line, len(lines))
                pc.edit_sentence(seq, int(sent["seq"]), lines[line - 1]["text"].strip())

        def asked():
            rec = _read(work_dir)
            rec["proofread_asked"] = time.time()
            _write(work_dir, rec)

        log("Perso is redoing every line… this takes a few minutes.")
        pc.proofread(seq, space, on_asked=asked)
    summary = fetch_project(pc, job, work_dir, out_path, log, to_wav)
    summary["credits"] = _credits(ws, pc, log, "the Perso proofread")
    return summary


def in_background(jid: str, what: str, run, say) -> None:
    """Start run() on a thread of its own, under this job's one seat. When it
    fails, say(exception) is kept for the screen, which asks (live_state)
    until the seat is empty."""
    seat = working(jid, what)
    seat.__enter__()        # raises Refused when the seat is taken

    def _wrap():
        try:
            run()
        except Exception as e:
            with _lock:
                _errors[jid] = say(e)
        finally:
            seat.__exit__(None, None, None)

    threading.Thread(target=_wrap, daemon=True).start()
