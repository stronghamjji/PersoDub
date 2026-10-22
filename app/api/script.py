"""The script screen: the lines of a finished dub, and everything that rewrites
one -- edit a line, listen to its voice, speak it again, remake every line whose
words changed or every line at once ("read it all again"), put a line back, and
the two Perso-side routes (fetch a Perso dub for local editing, give one line a
new speaker). The lines also go out as a spreadsheet, laid out the way Perso's
web app hands them out (script.xlsx).

One module because they are one screen: every route here starts from the same
job folder, and the private helpers below (_dubbed_texts, _line_manifest,
_remake_one_voice, _perso_is_materialized) are shared between them.

Lifted out of app/main.py unchanged (2026-09-06). The three names it shares
with other routers come from the module that owns each: the job store from
app/state.py, the Perso client from app.perso_client (both read at call time
off the module object, which is what makes the tests' fakes land here too),
and script_work_dir from app/api/_shared.py, where redub reads it as well.
resynth_one_line and rebuild_dub are NOT among them: no other module calls
them, so they are imported here from app.qwen_pipeline where they live, and
the tests that stub them patch this module.
"""
import contextlib
import io
import json
import logging
import os
import re
import threading
import zipfile
from typing import List, Optional
from urllib.parse import quote
from xml.sax.saxutils import escape

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app import config, dub_launch, engines_status, netlog, perso_client, perso_edit, perso_materialize, state
from app import setup as dub_setup
from app.api._launch import check_space
from app.api._shared import script_work_dir
from app.api.dub import require_translator
from app.downloads import file_stem
from app.dub_script import (
    DUB_NAME,
    EDITED_NAME,
    VOICE_TEXTS_NAME,
    edit_line,
    line_wav_path,
    load_lines,
    note_voice_text,
)
from app.engines.base import SynthesisTimeout, VoiceEngineDown
from app.i18n import t
from app.jobs import JobStatus
from app.models import dub_in_progress
from app.perso_client import (
    PersoCreditExhaustedError,
    PersoInvalidKeyError,
    PersoModelRefusedError,
    PersoProjectFailedError,
    PersoUnavailableError,
    short_reason,
)
from app.qwen_pipeline import rebuild_dub, resynth_one_line
from app.retranslate import retranslate_lines
from app.text.srt import _to_ts, parse_srt
from app.translate import ChatGptLimitError, ChatGptNotSignedInError, get_translator

router = APIRouter()


@router.get("/api/dub/jobs/{jid}/script")
def dub_job_script(jid: str):
    """This job's script, line by line, with the source line beside each one.

    The same reading app/mcp_server.py's get_script hands the assistant. Until
    now only the assistant could see it: the page had no route to ask for the
    original-language lines, so the export screen could only list the finished
    subtitles with nothing to compare them against.
    """
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    if job.get("dub_mode") == "perso" and not _perso_is_materialized(job):
        # A Perso dub's script lives on Perso's side; read it back live.
        seq = job.get("perso_project_seq")
        if not seq:
            raise HTTPException(status_code=404, detail=t("No script was recorded for this project."))
        try:
            script = perso_client.PersoClient().get_project_script(int(seq))
        except Exception:
            raise HTTPException(status_code=503,
                                detail=t("Could not reach Perso for this project's script. Try again in a moment."))
        lines = []
        for n, sent in enumerate(script.get("sentences") or [], start=1):
            start = (sent.get("offsetMs") or 0) / 1000.0
            dur = (sent.get("durationMs") or 0) / 1000.0
            lines.append({
                "line": n,
                "start": round(start, 2),
                "end": round(start + dur, 2),
                "slot": round(dur, 2),
                "source": sent.get("originalText"),
                "text": sent.get("translatedText") or "",
                # The voice already exists and fills its slot exactly -- there
                # is nothing to estimate and nothing stale.
                "estimated": round(dur, 2),
                "fits": True,
                "speaker": sent.get("speakerOrderIndex"),
                "audio_sec": None,
                "voice_stale": False,
                "edited": False,
                "was": None,
            })
        # Read-only until its parts are fetched (perso/materialize).
        return {"lines": lines, "edited": False, "readonly": True,
                "perso_edit": perso_edit.state(job, os.path.dirname(
                    (job.get("result") or {}).get("out_path") or ""))}
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409,
                            detail=t("This project has no finished script yet."))
    work_dir = os.path.dirname(out)
    try:
        lines = load_lines(work_dir, job.get("language_code") or "en")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=t("No script was recorded for this project."))
    # Mark which lines differ from what the translation produced, so the page can
    # badge them and offer to put them back.
    for line, original in zip(lines, _dubbed_texts(work_dir)):
        line["was"] = original
        line["edited"] = original is not None and original != line["text"]
    if job.get("dub_mode") == "perso":
        perso_edit.mark_reworded(work_dir, lines)
    return {"lines": lines,
            "edited": any(l.get("edited") for l in lines),
            # When the words, the voices or the video last changed: the page
            # asks /script/stamp now and then and draws again when it moves.
            "stamp": _script_stamp(work_dir, out),
            # What the last assembly cut short, kept beside the job so a
            # remade line's new length is reflected (rebuild_dub rewrites it).
            "clipped": _clipped_lines(work_dir),
            # Only on a Perso dub: whether its lines are still Perso's to
            # voice, and why not when they are not.
            **({"perso_edit": perso_edit.state(job, work_dir)}
               if job.get("dub_mode") == "perso" else {})}


def _script_stamp(work_dir: str, out: str) -> str:
    """The newest change time among the files the script table is drawn from.
    A string: nanoseconds are past what a JavaScript number holds exactly."""
    paths = [os.path.join(work_dir, n) for n in (DUB_NAME, EDITED_NAME, VOICE_TEXTS_NAME)] + [out]
    return str(max((os.stat(p).st_mtime_ns for p in paths if os.path.exists(p)), default=0))


@router.get("/api/dub/jobs/{jid}/script/stamp")
def dub_job_script_stamp(jid: str):
    """Only the script's stamp (see dub_job_script): a look at four files, no
    Perso call. The agent or another window changes a script behind the
    table's back, and this is how the table finds out (night test
    2026-10-01). None while there is no script here to draw."""
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    out = (job.get("result") or {}).get("out_path")
    if not out or (job.get("dub_mode") == "perso" and not _perso_is_materialized(job)):
        return {"stamp": None}
    return {"stamp": _script_stamp(os.path.dirname(out), out)}


# The script as a spreadsheet, laid out the way Perso's web app downloads it:
# one sheet, a header row, then a row per line, every cell an inline string.
# Perso's file also carries styles, a theme and document properties; none of
# them shows, so these are only the parts an .xlsx cannot open without.
_XLSX_HEAD = ("speaker_id", "start_time", "end_time", "original_segment", "translated_segment")
_XLSX_PARTS = {
    "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml"'
        ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml"'
        ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>',
    "_rels/.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"'
        ' Target="xl/workbook.xml" Id="rId1"/></Relationships>',
    "xl/workbook.xml":
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
        ' Target="/xl/worksheets/sheet1.xml" Id="rId1"/></Relationships>',
}
# Characters XML 1.0 cannot hold at all: one pasted into a line would leave a
# file Excel refuses to open.
_NOT_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _xlsx(rows: List[tuple]) -> bytes:
    """The rows as a workbook of one sheet, every cell a string."""
    sheet = ""
    for n, row in enumerate(rows, start=1):
        cells = "".join('<c r="%s%d" t="inlineStr"><is><t>%s</t></is></c>' % (col, n, escape(_NOT_XML.sub("", text)))
                        for col, text in zip("ABCDE", row))
        sheet += '<row r="%d">%s</row>' % (n, cells)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, xml in _XLSX_PARTS.items():
            z.writestr(name, xml)
        z.writestr("xl/worksheets/sheet1.xml",
                   '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<dimension ref="A1:E%d"/><sheetData>%s</sheetData></worksheet>' % (len(rows), sheet))
    return buf.getvalue()


@router.get("/api/dub/jobs/{jid}/script.xlsx")
def dub_job_script_xlsx(jid: str):
    """The script as the spreadsheet Perso's web app downloads: who speaks,
    when, the original line and its translation, a row each.

    The lines are dub_job_script's, so a Perso dubbing's come back from Perso
    as the table's do. Speakers are SPEAKER_01, SPEAKER_02 ... in the order
    they first speak, the order the table letters them in
    (ui/src/speakers.mjs); a script nobody is labelled in is one voice, and a
    line left unlabelled among labelled ones names nobody. The file is named
    the way Perso names it, after the project as the screens show it.
    """
    lines = dub_job_script(jid)["lines"]
    job = state.job_store.get(jid)
    speaker_ids = {}
    for line in lines:
        if line.get("speaker") is not None:
            speaker_ids.setdefault(line["speaker"], "SPEAKER_%02d" % (len(speaker_ids) + 1))
    rows = [_XLSX_HEAD] + [(speaker_ids.get(line.get("speaker"), "" if speaker_ids else "SPEAKER_01"),
                            _to_ts(line["start"]), _to_ts(line["end"]),
                            line.get("source") or "", line.get("text") or "") for line in lines]
    langs = "%sto%s" % ((job.get("source_lang") or "auto").upper(), (job.get("language_code") or "out").upper())
    # Perso adds a timestamp before .xlsx; the dated Downloads folder already says when.
    name = "%s_%s_OriginalTranslatedScript.xlsx" % (
        file_stem((job.get("title") or "").strip() or job.get("project") or ""), langs)
    return Response(content=_xlsx(rows),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(name)})


def _clipped_lines(work_dir: str) -> Optional[list]:
    """The lines the latest assembly cut short, or None when nothing was recorded."""
    try:
        with open(os.path.join(work_dir, "clipped_lines.json"), encoding="utf-8") as f:
            return list(json.load(f)["clipped"])
    except Exception:
        return None


def _dubbed_texts(work_dir: str) -> List[Optional[str]]:
    """What the translation wrote, line by line, before anything was rewritten.

    edit_line only ever changes a line's words, never the count or the timings,
    so line N here is line N there.
    """
    path = os.path.join(work_dir, DUB_NAME)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig") as f:
        return [c["text"] for c in parse_srt(f.read())]




class ScriptLineRequest(BaseModel):
    text: str



@router.post("/api/dub/jobs/{jid}/script/{line}")
def dub_job_script_edit(jid: str, line: int, body: ScriptLineRequest):
    """Rewrite one line. Same path the assistant takes -- edited.srt only."""
    job, work_dir = script_work_dir(jid)
    try:
        return edit_line(work_dir, line, body.text, job.get("language_code") or "en")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=t("No script was recorded for this project."))


@router.get("/api/dub/jobs/{jid}/script/{line}/audio")
def dub_job_line_audio(jid: str, line: int):
    """The voice that was made for one line, on its own."""
    _job, work_dir = script_work_dir(jid)
    path = line_wav_path(work_dir, line)
    if not os.path.exists(path):
        raise HTTPException(
            status_code=404,
            detail=t("This project has no per-line audio. Per-line audio has only "
                     "been kept since 2026-08-24, so a job made before that "
                     "has to be dubbed again before you can listen to it."))
    return FileResponse(path, media_type="audio/wav")


def _line_manifest(work_dir: str) -> dict:
    """What the synthesizer recorded about each line, or the right HTTP error."""
    manifest = os.path.join(work_dir, "lines.json")
    if not os.path.exists(manifest):
        raise HTTPException(status_code=409, detail=t(
            "This project cannot be remade one line at a time. It was made before "
            "2026-08-24, so it has no line information -- remake the whole job."))
    with open(manifest, encoding="utf-8") as f:
        return json.load(f)


def _voice_language(job: dict, data: dict) -> str:
    """The language name the voice engine speaks, from the job's code.

    The line manifest carries a name too, but for a Perso result made editable
    it is Perso's name for the language ("English (US)"), and the engine knows
    only "English": every remake on such a job was refused with "Unsupported
    languages" (0.6.2 full test, 2026-09-16). The code's first half is the
    engine's language whatever the region.
    """
    code = (job.get("language_code") or "").split("-")[0].lower()
    return config.LANGUAGE_NAMES.get(code) or data.get("language") or "English"


logger = logging.getLogger("persodub.api.script")

# Projects whose voices are being remade right now. Two remakes of one project
# at once wrote the same line files and the same finished video together
# (final review, 2026-10-12).
_remaking = set()
_remaking_lock = threading.Lock()


@contextlib.contextmanager
def _remaking_voices(jid: str):
    with _remaking_lock:
        if jid in _remaking:
            raise HTTPException(status_code=409, detail=t(
                "This project's voices are being remade already. Wait for that to finish."))
        _remaking.add(jid)
    try:
        yield
    finally:
        with _remaking_lock:
            _remaking.discard(jid)


def _remake_one_voice(work_dir: str, data: dict, line: int, text: str, language: str) -> None:
    """Speak one line again, over its own old wav. The video is NOT rebuilt here.

    Rebuilding is the caller's call: one line at a time rebuilds after each one,
    a sweep of several rebuilds once at the end.
    """
    entries = data.get("lines") or []
    if not 1 <= line <= len(entries):
        raise HTTPException(status_code=422, detail=t("There is no line {line}.", line=line))
    if not text.strip():
        # A line left untranslated stays silent until someone writes it; asking
        # the engine to speak nothing gives back noise, not silence.
        raise HTTPException(status_code=422, detail=t(
            "Line {line} has no words yet. Write its translation first.", line=line))
    try:
        new_path = resynth_one_line(work_dir, entries[line - 1], text, language)
    except FileNotFoundError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (httpx.HTTPError, VoiceEngineDown, SynthesisTimeout) as e:
        # Nothing answering at all while no dubbing runs is an engine that is
        # not there, and "wait for the running dubbing" would have the user
        # wait for ever (2026-09-30). The sentence is the one the engine's own
        # status uses (app/engines_status.py).
        if isinstance(e, (httpx.ConnectError, VoiceEngineDown)) and not dub_in_progress():
            raise HTTPException(status_code=503, detail=t(
                "The voice engine is not running. Quit and reopen PersoDub."))
        # The engine did not answer in time or answered with an error: on a
        # machine that is also dubbing, that is the dub holding it. A 500 here
        # read to the agent as "still waiting" (2026-09-16).
        raise HTTPException(status_code=503, detail=t(
            "The voice engine is busy. Wait for the running dubbing to finish, "
            "then try this line again."))
    if new_path is None:
        raise HTTPException(status_code=502, detail=t("Could not make the voice."))
    note_voice_text(work_dir, line, text)


@router.post("/api/dub/jobs/{jid}/script/{line}/voice")
def dub_job_line_voice(jid: str, line: int):
    """Speak ONE line again and rebuild the dub around it.

    Everything else is reused: the other lines' audio, the background bed and
    the speaker's cloned voice all stay on disk after a job (app/pipeline.py).
    Rewriting two lines of ten should not cost a whole synthesis pass.
    """
    job, work_dir = script_work_dir(jid)
    data = _line_manifest(work_dir)
    lines = load_lines(work_dir, job.get("language_code") or "en")
    if not 1 <= line <= len(lines):
        raise HTTPException(status_code=422, detail=t("There is no line {line}.", line=line))
    # The rebuild writes the dub again; the same floor a new dub starts with.
    check_space(work_dir)

    with _remaking_voices(jid):
        _remake_one_voice(work_dir, data, line, lines[line - 1]["text"], _voice_language(job, data))
        rebuild_dub(work_dir, data, os.path.join(work_dir, "input.mp4"),
                    (job.get("result") or {}).get("out_path"))
    return {"line": line, "ok": True}


@router.post("/api/dub/jobs/{jid}/voices/stale")
def dub_job_stale_voices(jid: str):
    """Remake only the lines whose words changed since their voice was made.

    Exactly the work the screen's filled wave buttons offer, in one press: each
    such line is spoken again in place and the video is put back together once
    at the end, instead of once per line. Nothing else moves -- no new job, no
    new folder, no status change, and a line nobody rewrote keeps its voice.

    Which lines those are is decided the same way the screen decides it
    (ui/src/scriptTable.mjs: `l.voice_stale`), so one press does the set
    of lines the buttons were offering and not a line more.
    """
    return _remake_voices(jid, lambda line: line["voice_stale"])


@router.post("/api/dub/jobs/{jid}/voices/all")
def dub_job_all_voices(jid: str):
    """Speak every line that has words again, in place, and rebuild the video
    once: "read it all again". Only the changed lines could be remade before,
    so with none changed the Dub Agent had nothing to do (Windows test F18,
    2026-10-11). A line left untranslated has no words to speak and stays
    as it is."""
    return _remake_voices(jid, lambda line: bool(line["text"].strip()))


def _remake_voices(jid: str, pick) -> dict:
    """The lines `pick` chooses, spoken again in place, then one rebuild."""
    job, work_dir = script_work_dir(jid)
    if job.get("status") in (JobStatus.RUNNING, JobStatus.CANCELLING):
        raise HTTPException(status_code=409, detail=t("This project is still running."))
    data = _line_manifest(work_dir)
    lines = load_lines(work_dir, job.get("language_code") or "en")
    chosen = [
        line for line, original in zip(lines, _dubbed_texts(work_dir))
        if original is not None and pick(line)
    ]
    if not chosen:
        return {"remade": [], "skipped": len(lines)}
    check_space(work_dir)

    language = _voice_language(job, data)
    out_path = (job.get("result") or {}).get("out_path")
    with _remaking_voices(jid):
        remade = []
        try:
            for line in chosen:
                _remake_one_voice(work_dir, data, line["line"], line["text"], language)
                remade.append(line["line"])
        except Exception:
            # The lines made so far are on file as up to date: the video gets
            # them before the error goes back, or it kept their old voices.
            if remade:
                try:
                    rebuild_dub(work_dir, data, os.path.join(work_dir, "input.mp4"), out_path)
                except Exception as e:
                    logger.warning("No rebuild after a remake stopped part-way: %s", type(e).__name__)
            raise
        # Once, at the end: the rebuild is the slow half, and laying down five new
        # lines five times over would spend it five times for the same video.
        rebuild_dub(work_dir, data, os.path.join(work_dir, "input.mp4"), out_path)
    return {"remade": remade, "skipped": len(lines) - len(chosen)}


class RetranslateRequest(BaseModel):
    # Line numbers, or None for every line.
    lines: Optional[List[int]] = None
    # Another translator for these lines: ChatGPT's limit or sign-in stopped
    # them and the user picked one. The job's record is left as it is.
    translator: Optional[str] = None


@router.post("/api/dub/jobs/{jid}/retranslate")
def dub_job_retranslate(jid: str, body: RetranslateRequest):
    """Translate the chosen lines again. Words only: the voices stay as they
    are until they are remade (voices/stale, or Perso's own line voice).

    A dub that is still Perso's to edit is translated by Perso, every other
    by the translator the project was dubbed with (its record's, which a
    Resume with another translator rewrote) -- ChatGPT's limit stopped every
    Translate again, even on a Hunyuan project (Windows, 2026-10-06). The
    page's Translate again button and the assistant's retranslate_lines tool
    both land here, so the two do exactly the same work.
    """
    job, work_dir = script_work_dir(jid)
    if job.get("status") in (JobStatus.RUNNING, JobStatus.CANCELLING):
        raise HTTPException(status_code=409, detail=t("This project is still running."))
    if body.lines is not None and not body.lines:
        raise HTTPException(status_code=422, detail=t("Choose at least one line."))
    if (job.get("dub_mode") == "perso" and job.get("perso_project_seq")
            and not perso_edit.voiced_here(work_dir)):
        pc = _perso_home(jid)[3]
        try:
            with perso_edit.working(jid, "line"):
                return {"changed": perso_edit.translate_lines(
                    pc, job, work_dir, body.lines,
                    lambda msg: state.job_store.append_log(jid, msg))}
        except Exception as e:
            raise _perso_error(e)
    translator = ((body.translator or "").strip().lower()
                  or job.get("translator") or dub_setup.default_for("translator"))
    if body.translator and translator not in dub_setup.STAGES["translator"][1]:
        raise HTTPException(status_code=422, detail=t("Cannot translate with: {translator}", translator=translator))
    # The page answers these two with the dubbing's own popup: wait, sign in,
    # or carry on with another translator (ui/src/translatorChoice.mjs). Both
    # stay in English: the page knows them by their words ("Sign in to
    # ChatGPT", and the "Resets ..." sentence it puts in the popup).
    if translator == "chatgpt":
        if not engines_status.chatgpt_available():
            raise HTTPException(status_code=422, detail="Sign in to ChatGPT first.")
    else:
        require_translator(translator)
    name = engines_status.TRANSLATOR_NAMES.get(translator, translator.capitalize())
    code = job.get("language_code") or "en"
    language = job.get("language") or dub_launch.language_name(code)
    try:
        changed = retranslate_lines(work_dir, body.lines, code, language,
                                    get_translator(translator))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=t("No script was recorded for this project."))
    except ChatGptNotSignedInError:
        raise HTTPException(status_code=422, detail="Sign in to ChatGPT first.")
    except ChatGptLimitError as e:
        raise HTTPException(status_code=429, detail=(
            f"ChatGPT usage limit reached. Resets {e.resets}." if e.resets
            else "ChatGPT usage limit reached for now. Try again after it resets."))
    except Exception as e:
        raise HTTPException(status_code=502, detail=t(
            "{translator} could not translate these lines ({reason}). Try again.",
            translator=name, reason=short_reason(e)))
    return {"changed": changed}


@router.post("/api/dub/jobs/{jid}/script/{line}/revert")
def dub_job_script_revert(jid: str, line: int):
    """Put one line back to what the translation wrote."""
    job, work_dir = script_work_dir(jid)
    texts = _dubbed_texts(work_dir)
    if not 1 <= line <= len(texts):
        raise HTTPException(status_code=422, detail=t("There is no line {line}.", line=line))
    return edit_line(work_dir, line, texts[line - 1], job.get("language_code") or "en")



class PersoSpeakerRequest(BaseModel):
    line: int


def _perso_is_materialized(job) -> bool:
    """True once a Perso dub's parts were fetched for local editing -- from
    then on its script (and every edit tool) runs on the local files."""
    out = (job.get("result") or {}).get("out_path")
    return bool(out and os.path.exists(os.path.join(os.path.dirname(out), DUB_NAME)))


@router.post("/api/dub/jobs/{jid}/perso/materialize")
def dub_job_perso_materialize(jid: str):
    """Fetch a Perso dub's parts (script, per-line audio, background bed) and
    write the local job files -- after this the dub edits like any other job.
    Downloads only; no Perso credits are spent."""
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        raise HTTPException(status_code=409, detail=t("Only Perso dubbing can be fetched for editing."))
    if perso_edit.nightingale(job):
        raise HTTPException(status_code=409, detail=perso_edit.nightingale_fixed())
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail=t("This project has no finished video yet."))
    try:
        summary = perso_materialize.materialize(
            perso_client.PersoClient(), int(job["perso_project_seq"]), os.path.dirname(out),
            job.get("language") or "English",
            log=lambda msg: state.job_store.append_log(jid, msg))
    except (PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503,
                            detail=t("Could not fetch this dubbing from Perso ({reason}).", reason=str(e)[:80]))
    return summary


@router.post("/api/dub/jobs/{jid}/perso/speaker")
def dub_job_perso_speaker(jid: str, body: PersoSpeakerRequest):
    """Give one line of a Perso dub a NEW speaker, on Perso's side.

    The agent's change_speaker tool lands here. Line numbers are the same
    1-based order the script endpoint serves. The write is verified the way
    the official plugin does it: re-read the script and report what it says.
    """
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        raise HTTPException(status_code=409, detail=t("Only Perso dubbing has server-side speakers."))
    seq = int(job["perso_project_seq"])
    pc = perso_client.PersoClient()
    try:
        sents = (pc.get_project_script(seq).get("sentences") or [])
        if not 1 <= body.line <= len(sents):
            raise HTTPException(status_code=422, detail=t("There is no line {line}.", line=body.line))
        sent = sents[body.line - 1]
        old = sent.get("speakerOrderIndex")
        pc.add_speaker_from_sentence(seq, int(sent["seq"]))
        after = pc.get_project_script(seq).get("sentences") or []
        new = after[body.line - 1].get("speakerOrderIndex") if len(after) >= body.line else None
    except HTTPException:
        raise
    except (PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=t("Perso did not accept the change ({reason}).", reason=str(e)[:80]))
    return {"line": body.line, "old_speaker": old, "new_speaker": new}


# -- Editing a Perso dub on Perso's side (app/perso_edit.py) -----------------
# The rule between these and the local remakes above is written out at the
# top of app/perso_edit.py. Every route that can spend credits wants
# confirm=true in its body: the screen and the agent both ask the user first,
# and a request that did not is one nobody agreed to.

class PersoConfirm(BaseModel):
    confirm: bool = False
    # Remake voices: leave a line alone whose voice already says its words.
    changed_only: bool = False


class PersoFitRequest(BaseModel):
    text: str


def _perso_says(e: Exception) -> tuple:
    """(status, sentence) for whatever went wrong between here and Perso."""
    if isinstance(e, perso_edit.Refused):
        return e.status, str(e)
    if isinstance(e, PersoCreditExhaustedError):
        return 402, t("Perso credits are used up. Recharge to continue.")
    if isinstance(e, PersoInvalidKeyError):
        return 409, t("Perso rejected the API key. Open Settings and check the key.")
    if isinstance(e, PersoUnavailableError):
        return 503, t("Perso's server is temporarily unavailable. Try again in a few minutes.")
    if isinstance(e, PersoModelRefusedError):
        return 409, t("This dubbing's Perso voice cannot remake one line at a time. "
                      "Use All at once to remake every line.")
    if isinstance(e, PersoProjectFailedError):
        # Ours, with what to press, and on a line under it Perso's own words
        # and code -- as a failed dub shows them (app/pipeline.py raise_notice).
        said = t("Perso said: {said}", said=e.reason) if e.reason else t("Perso said: no reason given")
        return 502, "%s\n%s" % (t("Perso could not finish this job. Press it again in a moment."),
                                 "%s (%s)" % (said, e.code) if e.code else said)
    if isinstance(e, (httpx.TimeoutException, TimeoutError)):
        return 504, t("Perso did not answer in time. The change may still have been "
                      "made: wait a minute, then press again.")
    if isinstance(e, httpx.HTTPStatusError):
        return 409, t("Perso did not accept the change ({reason}).", reason=short_reason(e))
    if isinstance(e, httpx.HTTPError):
        # A company network or security program refusing Perso's certificate:
        # checking the connection on the same network changes nothing.
        if netlog.certificate_refused(str(e)):
            return 503, t("A company network or security program blocked the connection. "
                          "Connect to another Wi-Fi or a hotspot, then press it again.")
        return 503, t("Could not reach Perso. Check the connection, then try again.")
    if isinstance(e, FileNotFoundError):
        return 409, short_reason(e)
    # The type name for the log only: on screen it is a program's word.
    logger.warning("Editing through Perso failed (%s)", type(e).__name__)
    return 500, t("Perso could not make the change. Press it again in a moment.")


def _perso_error(e: Exception) -> HTTPException:
    status, said = _perso_says(e)
    return HTTPException(status_code=status, detail=said)


def _perso_home(jid: str, fetch: bool = True) -> tuple:
    """(job, folder, finished video, client) of a Perso dub, its parts fetched
    first when they never were -- or the right HTTP error."""
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        raise HTTPException(status_code=409, detail=perso_edit.not_perso())
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail=t("This project has no finished video yet."))
    try:
        pc = perso_client.PersoClient()
    except ValueError:
        raise HTTPException(status_code=409, detail=t("Add your Perso API key in Settings first."))
    if fetch and not _perso_is_materialized(job):
        dub_job_perso_materialize(jid)
    return job, os.path.dirname(out), out, pc


def _confirmed(body: PersoConfirm) -> None:
    if not body.confirm:
        raise HTTPException(status_code=409, detail=t(
            "This uses Perso credits. Ask the user, then send confirm=true."))


@router.get("/api/dub/jobs/{jid}/perso/edit")
def dub_job_perso_edit(jid: str, price: bool = False):
    """Whether this dub can be edited through Perso, asked of Perso itself:
    is it a NIGHTINGALE project (no single-line voices), would it take a
    proofread, and is a proofread under way. With price=1, also what a
    proofread would cost (proofread_price, None when unknown). Free."""
    job, work_dir, _out, pc = _perso_home(jid, fetch=False)
    try:
        return perso_edit.live_state(pc, job, work_dir, price=price)
    except Exception as e:
        raise _perso_error(e)


@router.post("/api/dub/jobs/{jid}/perso/script/{line}/fit")
def dub_job_perso_fit(jid: str, line: int, body: PersoFitRequest):
    """Perso's own verdict on new words for one line. Nothing is saved."""
    job, work_dir, _out, pc = _perso_home(jid)
    try:
        return perso_edit.check_fit(pc, job, work_dir, line, body.text)
    except Exception as e:
        raise _perso_error(e)


def _perso_line(jid: str, line: int, body: PersoConfirm, what) -> dict:
    """One line's Perso work, start to finish: the seat, the space on disk,
    the work itself and the video rebuilt around it."""
    _confirmed(body)
    job, work_dir, out, pc = _perso_home(jid)
    data = _line_manifest(work_dir)
    check_space(work_dir)
    try:
        with perso_edit.working(jid, "line"):
            return what(pc, job, work_dir, line,
                        lambda msg: state.job_store.append_log(jid, msg),
                        lambda: rebuild_dub(work_dir, data,
                                            os.path.join(work_dir, "input.mp4"), out))
    except Exception as e:
        raise _perso_error(e)


@router.post("/api/dub/jobs/{jid}/perso/script/{line}/voice")
def dub_job_perso_line_voice(jid: str, line: int, body: PersoConfirm):
    """Speak ONE line again in Perso's own voice, from the words the script
    now has, and rebuild the dub around it. Spends Perso credits."""
    return _perso_line(jid, line, body, lambda *a: perso_edit.revoice_line(
        *a, changed_only=body.changed_only))


@router.post("/api/dub/jobs/{jid}/perso/script/{line}/reset")
def dub_job_perso_line_reset(jid: str, line: int, body: PersoConfirm):
    """Put ONE line back to what Perso's last proofread left, words and voice."""
    return _perso_line(jid, line, body, perso_edit.reset_line)


@router.post("/api/dub/jobs/{jid}/perso/proofread")
def dub_job_perso_proofread(jid: str, body: PersoConfirm):
    """Have Perso go over the whole dub again. Spends Perso credits (what the
    dub cost), and takes minutes: this answers at once, and perso/edit says
    `working` until the new script, voices and video are home."""
    _confirmed(body)
    job, work_dir, out, pc = _perso_home(jid)
    check_space(work_dir)
    try:
        plan = perso_edit.check_proofread(pc, job, work_dir)
        perso_edit.in_background(
            jid, "proofread",
            lambda: perso_edit.proofread(
                pc, job, work_dir, out,
                lambda msg: state.job_store.append_log(jid, msg), plan),
            lambda e: _perso_says(e)[1])
    except Exception as e:
        raise _perso_error(e)
    return {"started": True, "fetch_only": plan["fetch_only"]}
