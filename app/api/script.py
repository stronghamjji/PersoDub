"""The script screen: the lines of a finished dub, and everything that rewrites
one -- edit a line, listen to its voice, speak it again, remake every line whose
words changed, put a line back, and the two Perso-side routes (fetch a Perso dub
for local editing, give one line a new speaker).

One module because they are one screen: every route here starts from the same
job folder, and the private helpers below (_dubbed_texts, _line_manifest,
_remake_one_voice, _perso_is_materialized) are shared between them.

Lifted out of app/main.py unchanged (2026-09-06). Three names it needs are
still main's -- job_store, PersoClient and _script_work_dir are read by routes
that stay there (redub reads the last two), and the tests redirect job_store
and PersoClient on app.main -- so _main() below reads them back at call time
instead of keeping copies a redirect would miss. resynth_one_line and
rebuild_dub are NOT among them: nothing in main calls them any more, so they
are imported here from app.qwen_pipeline where they live, and the tests that
stub them patch this module.
"""
import json
import os
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import perso_materialize
from app.dub_script import DUB_NAME, edit_line, line_wav_path, load_lines
from app.perso_client import (
    PersoCreditExhaustedError,
    PersoInvalidKeyError,
    PersoUnavailableError,
)
from app.qwen_pipeline import rebuild_dub, resynth_one_line
from app.text.srt import parse_srt

router = APIRouter()


def _main():
    """app.main, imported at call time.

    The three names read off it -- job_store, PersoClient and _script_work_dir
    -- are shared with routes that did not move, so they stay defined there;
    the tests redirect job_store and PersoClient on app.main and this is what
    makes a redirect land on these routes too.
    """
    from app import main
    return main


@router.get("/api/dub/jobs/{jid}/script")
def dub_job_script(jid: str):
    """This job's script, line by line, with the source line beside each one.

    The same reading app/mcp_server.py's get_script hands the assistant. Until
    now only the assistant could see it: the page had no route to ask for the
    original-language lines, so the export screen could only list the finished
    subtitles with nothing to compare them against.
    """
    job = _main().job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if job.get("dub_mode") == "perso" and not _perso_is_materialized(job):
        # A Perso dub's script lives on Perso's side; read it back live.
        seq = job.get("perso_project_seq")
        if not seq:
            raise HTTPException(status_code=404, detail="No script was recorded for this job.")
        try:
            script = _main().PersoClient().get_project_script(int(seq))
        except Exception:
            raise HTTPException(status_code=503,
                                detail="Could not reach Perso for this job's script. Try again in a moment.")
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
        # Read-only until editing Perso lines lands (the next stage).
        return {"lines": lines, "edited": False, "readonly": True}
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409,
                            detail="This job has no finished script yet.")
    work_dir = os.path.dirname(out)
    try:
        lines = load_lines(work_dir, job.get("language_code") or "en")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="No script was recorded for this job.")
    # Mark which lines differ from what the translation produced, so the page can
    # badge them and offer to put them back.
    for line, original in zip(lines, _dubbed_texts(work_dir)):
        line["was"] = original
        line["edited"] = original is not None and original != line["text"]
    return {"lines": lines,
            "edited": any(l.get("edited") for l in lines)}


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
    job, work_dir = _main()._script_work_dir(jid)
    try:
        return edit_line(work_dir, line, body.text, job.get("language_code") or "en")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="No script was recorded for this job.")


@router.get("/api/dub/jobs/{jid}/script/{line}/audio")
def dub_job_line_audio(jid: str, line: int):
    """The voice that was made for one line, on its own."""
    _job, work_dir = _main()._script_work_dir(jid)
    path = line_wav_path(work_dir, line)
    if not os.path.exists(path):
        raise HTTPException(
            status_code=404,
            detail=("This job has no per-line audio. Per-line audio has only "
                    "been kept since 2026-08-24, so a job made before that "
                    "has to be dubbed again before you can listen to it."))
    return FileResponse(path, media_type="audio/wav")


def _line_manifest(work_dir: str) -> dict:
    """What the synthesizer recorded about each line, or the right HTTP error."""
    manifest = os.path.join(work_dir, "lines.json")
    if not os.path.exists(manifest):
        raise HTTPException(status_code=409, detail=(
            "This job cannot be remade one line at a time. It was made before "
            "2026-08-24, so it has no line information -- remake the whole job."))
    with open(manifest, encoding="utf-8") as f:
        return json.load(f)


def _remake_one_voice(work_dir: str, data: dict, line: int, text: str) -> None:
    """Speak one line again, over its own old wav. The video is NOT rebuilt here.

    Rebuilding is the caller's call: one line at a time rebuilds after each one,
    a sweep of several rebuilds once at the end.
    """
    entries = data.get("lines") or []
    if not 1 <= line <= len(entries):
        raise HTTPException(status_code=422, detail=f"There is no line {line}.")
    try:
        new_path = resynth_one_line(work_dir, entries[line - 1], text,
                                    data.get("language") or "English")
    except FileNotFoundError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if new_path is None:
        raise HTTPException(status_code=502, detail="Could not make the voice.")


@router.post("/api/dub/jobs/{jid}/script/{line}/voice")
def dub_job_line_voice(jid: str, line: int):
    """Speak ONE line again and rebuild the dub around it.

    Everything else is reused: the other lines' audio, the background bed and
    the speaker's cloned voice all stay on disk after a job (app/pipeline.py).
    Rewriting two lines of ten should not cost a whole synthesis pass.
    """
    job, work_dir = _main()._script_work_dir(jid)
    data = _line_manifest(work_dir)
    lines = load_lines(work_dir, job.get("language_code") or "en")
    if not 1 <= line <= len(lines):
        raise HTTPException(status_code=422, detail=f"There is no line {line}.")

    _remake_one_voice(work_dir, data, line, lines[line - 1]["text"])
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
    (static/index.html: `l.edited && l.voice_stale`), so one press does the set
    of lines the buttons were offering and not a line more.
    """
    job, work_dir = _main()._script_work_dir(jid)
    if job.get("status") in ("running", "cancelling"):
        raise HTTPException(status_code=409, detail="This job is still running.")
    data = _line_manifest(work_dir)
    lines = load_lines(work_dir, job.get("language_code") or "en")
    stale = [
        line for line, original in zip(lines, _dubbed_texts(work_dir))
        if original is not None and original != line["text"] and line["voice_stale"]
    ]
    if not stale:
        return {"remade": [], "skipped": len(lines)}

    for line in stale:
        _remake_one_voice(work_dir, data, line["line"], line["text"])
    # Once, at the end: the rebuild is the slow half, and laying down five new
    # lines five times over would spend it five times for the same video.
    rebuild_dub(work_dir, data, os.path.join(work_dir, "input.mp4"),
                (job.get("result") or {}).get("out_path"))
    return {"remade": [line["line"] for line in stale],
            "skipped": len(lines) - len(stale)}


@router.post("/api/dub/jobs/{jid}/script/{line}/revert")
def dub_job_script_revert(jid: str, line: int):
    """Put one line back to what the translation wrote."""
    job, work_dir = _main()._script_work_dir(jid)
    texts = _dubbed_texts(work_dir)
    if not 1 <= line <= len(texts):
        raise HTTPException(status_code=422, detail=f"There is no line {line}.")
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
    job = _main().job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        raise HTTPException(status_code=409, detail="Only Perso dubs can be fetched for editing.")
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail="This job has no finished video yet.")
    try:
        summary = perso_materialize.materialize(
            _main().PersoClient(), int(job["perso_project_seq"]), os.path.dirname(out),
            job.get("language") or "English",
            log=lambda msg: _main().job_store.append_log(jid, msg))
    except (PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503,
                            detail=f"Could not fetch this dub from Perso ({str(e)[:80]}).")
    return summary


@router.post("/api/dub/jobs/{jid}/perso/speaker")
def dub_job_perso_speaker(jid: str, body: PersoSpeakerRequest):
    """Give one line of a Perso dub a NEW speaker, on Perso's side.

    The agent's change_speaker tool lands here. Line numbers are the same
    1-based order the script endpoint serves. The write is verified the way
    the official plugin does it: re-read the script and report what it says.
    """
    job = _main().job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if job.get("dub_mode") != "perso" or not job.get("perso_project_seq"):
        raise HTTPException(status_code=409, detail="Only Perso dubs have server-side speakers.")
    seq = int(job["perso_project_seq"])
    pc = _main().PersoClient()
    try:
        sents = (pc.get_project_script(seq).get("sentences") or [])
        if not 1 <= body.line <= len(sents):
            raise HTTPException(status_code=422, detail=f"There is no line {body.line}.")
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
        raise HTTPException(status_code=503, detail=f"Perso did not accept the change ({str(e)[:80]}).")
    return {"line": body.line, "old_speaker": old, "new_speaker": new}
