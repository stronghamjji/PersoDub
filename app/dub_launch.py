"""One builder for the work a dub job runs.

There are four doors into a dub -- a new upload or link, "Try again", a redub,
and the boot re-arm that picks up a job which waited out a restart -- and until
now each of them built the pipeline call itself, out of the same facts, in its
own words. Four copies of one mapping is four chances to drift, and they had:
"Try again" alone forgot the subtitle files, so a job made from a subtitle file
came back transcribed by Whisper, silently, with a different script.

So the mapping lives here once, and it reads nothing but a job's own record.
That is deliberate: the re-arm has only job.json to go on, so a builder that
can satisfy the re-arm can satisfy every other door too, and the record becomes
the single description of what a job is. The routes above (app/api/dub.py) keep
what is genuinely theirs -- the HTTP preflights, the folder, the copies -- and
hand the finished record here.

Domain only: nothing in this file knows about FastAPI or about a request. The
seams the tests fake (run_dub, the cloud path, the download, the trim) come in
as arguments so app/api/dub.py can keep passing its own module attributes,
which is where they have always been patched.
"""
import os
from typing import Optional

from app import config, engines_status, languages, media, perso_client, state
from app.jobs import JobCancelled
from app.pipeline import _PERSO_NOTICE_ERRORS, _raise_perso_failed, raise_notice
from app.pipeline import run_dub as _run_dub
from app.source_fetch import fetch as _fetch_source


def language_name(code: str, dub_mode: str = "local") -> str:
    """The name a job shows for its target: Perso's own for its list ("Hindi",
    "English (UK)"), the model's for the local ten; the code itself when
    neither knows it."""
    entry = languages.lookup(dub_mode, code)
    if entry:
        return entry["name"]
    return _legacy_language_name(code)


def _legacy_language_name(code: str) -> str:
    """The language's name for a code, or the code itself for one we don't know
    (a region variant, say) -- which is no worse than what we were given.

    run_dub is given the NAME: it goes into the translation prompt and to the
    voice sidecar, so a job whose record predates `language` must have its name
    worked out rather than being told to speak "ko".
    """
    return config.LANGUAGE_NAMES.get((code or "").lower(), code)


def translate_model_missing(translator: str, status: Optional[str] = None) -> Optional[str]:
    """The catalog id a local translator still needs, or None.

    Only a translator whose model the app downloads (app/engines_status.py
    TRANSLATORS: gemma and hunyuan) has one to be missing; Gemini is a key and
    lives on the web. `status` is for the caller that already asked (dub_start
    also has to tell an unreachable Ollama apart from a missing model, and one
    probe per start is enough) -- left out, this asks.
    """
    info = engines_status.TRANSLATORS.get(translator)
    if info is None or not info.catalog_id:
        return None
    if status is None:
        status = info.probe()
    return info.catalog_id if status == "model_missing" else None


def run_cloud_dub(jid, video_path, out_path, source_code, target_code, num_speakers, log,
                  tts_model=None, title=None):
    """The whole-job Perso path: upload -> cloud dub -> download. Same failure
    grammar as the Perso STT/separation stages (no silent local fallback).
    tts_model is the Perso voice model the job's record names; a record from
    before one was kept names none and gets the language's own. title is the
    project's name, which Perso's workspace shows the project under."""
    log("1/1 Dubbing in the Perso cloud…")
    # Made inside the `try`, as the stages make theirs: a client that cannot
    # be made (no key, or the workspace lookup offline or refused) is worded
    # like a failed call. ws is set first because the `finally` reads it.
    ws = None
    try:
        pc = perso_client.PersoClient()
        pc.cancel_check = lambda: state.job_store.is_cancel_requested(jid)
        # The upload's and the download's lines into the job's file too.
        pc.trace = getattr(log, "trace", None)
        ws = perso_client.begin_credit_watch(pc)
        if ws:
            log(f"   Perso workspace: {ws.get('name') or ws.get('seq')} (#{ws.get('seq')})")
        # The job's language_code is the screen's id (a region tag such as
        # "en-GB" or a plain code); Perso wants the code and the tag apart.
        entry = languages.lookup("perso", target_code) or {"code": target_code, "tag": None}
        tag = {"target_tag": entry["tag"]} if entry.get("tag") else {}
        pc.dub_video(video_path, out_path, source_code, entry["code"], num_speakers=num_speakers, log=log,
                     tts_model=tts_model or languages.model_for(entry), title=title, **tag)
        # The Perso project number is how the script viewer (and later the
        # agent) finds this job's sentences again -- persist it with the job.
        seq = getattr(pc, "last_dub_project_seq", None)
        if seq:
            # The workspace beside it: the project lives in that one, and
            # editing it later must not follow a workspace changed since.
            state.job_store.update(jid, perso_project_seq=seq,
                                   perso_space_seq=getattr(pc, "space_seq", None))
            state.job_store.persist(jid, os.path.dirname(out_path))
        perso_client.note_credits(ws, pc, log, "the Perso cloud dub")
    except JobCancelled:
        raise
    # Among them, a project Perso took and gave up on: the request was fine,
    # the answer said it had failed. Without it here a cloud dub that Perso
    # abandoned fell through to the generic handler and lost Perso's own
    # reason on the way (user, 2026-09-11).
    except _PERSO_NOTICE_ERRORS as e:
        # The same messages the stages report, for the same errors, both from
        # app/pipeline.py (_NOTICE_ERRORS, _PERSO_NOTICE_ERRORS). They used to
        # be hand-copied here, so one path could drift from the other.
        raise_notice(e, log, lambda n: state.job_store.append_notice(jid, n))
    except RuntimeError:
        # The app's own sentences (app/perso_client.py), already worded for
        # the user. Wrapped, one runs past the 140 characters the failure
        # card shows.
        raise
    except Exception as e:
        # Anything else is worded as the stages word it: a short sentence on
        # screen, the address Perso was called at only in the app log. Named
        # "Perso dubbing", short, so a refusal Perso gave no reason for still
        # fits in those 140.
        _raise_perso_failed(e, log, "Perso dubbing")
    finally:
        perso_client.end_credit_watch(ws)   # a dub that failed must not count as still running
    # The length is for the usage count, and a probe that fails must not fail
    # a dub Perso has already delivered.
    try:
        duration = media.video_duration(video_path)
    except Exception:
        duration = None
    return {"job_id": jid, "out_path": out_path, "num_segments": 0, "dub_mode": "perso",
            "perso_credits": getattr(pc, "credits_used", None), "duration": duration}


def work_for(job, *, cancel_check, on_notice, voices_only=False, resume=False,
             run_dub=_run_dub, run_cloud_dub=run_cloud_dub,
             fetch_source=_fetch_source, cut_video=media.cut_video,
             cut_ranges=media.cut_ranges):
    """The work one job runs, built from its record and its folder.

    Returns work(log) -- what JobStore.start wants. Everything it needs it
    reads off `job`: the folder, the link still to download, the cut still
    owed, the target language, and the engine choices the record was stamped
    with. The subtitle files are found in the folder rather than named, so a
    job that was made from subtitles keeps them through every door.

    voices_only is the redub: the script is handed back in and only the voices
    are made again, so the record's transcription and translation choices --
    which it still keeps, because the finished screen shows them -- must not be
    replayed. Without the flag a redub of a Perso-transcribed job would
    transcribe it in the cloud all over again, for nothing.

    The engine arguments are the record's own words read back through the
    mapping that wrote them (app/api/dub.py's _engines_used): the record says
    "whisper"/"perso", and run_dub asks only whether it is "perso"; it says
    "demucs"/"roformer"/"perso", and run_dub separates with that one.
    """
    jid = job["id"]
    work = job["work_dir"]
    video_path = os.path.join(work, "input.mp4")
    out_path = os.path.join(work, "dubbed.mp4")
    language_code = job.get("language_code") or "en"
    language = job.get("language") or language_name(language_code, job.get("dub_mode") or "local")
    srt_path = _in_folder(work, "sub.srt")
    source_srt_path = _in_folder(work, "source.srt")
    trim = job.get("trim")
    source_url = job.get("source_url")

    def work_now(log):
        # A fresh start has no input.mp4 yet, so this fetches exactly when
        # dub_start's own `if source_url:` used to; a job coming back from a
        # restart may already have the file, and must not download it twice.
        if source_url and not os.path.exists(video_path):
            fetch_source(source_url, video_path, log=log, cancel_check=cancel_check)
        if (job.get("trim_pending") and trim
                and trim.get("start") is not None and trim.get("end") is not None):
            # Written to job.json the instant the cut lands, not at the end of
            # the job: quit the app in between and the record still says a cut
            # is owed over a video that has already had one, and running it
            # again would take the same seconds out twice.
            def _cut_recorded():
                state.job_store.update(jid, trim_pending=False)
                state.job_store.persist(jid, work)

            cut_video(video_path, trim["start"], trim["end"], on_cut=_cut_recorded)
        # Parts kept on the timeline, owed the same way: recorded the instant
        # the joined video takes the downloaded one's place.
        if job.get("ranges_pending") and job.get("ranges"):
            def _joined_recorded():
                state.job_store.update(jid, ranges_pending=False)
                state.job_store.persist(jid, work)

            cut_ranges(video_path, job["ranges"], on_cut=_joined_recorded)
        if job.get("dub_mode") == "perso" and not voices_only:
            # Named on Perso's workspace as on this app's screens: the name
            # the person gave it, else the one it was made with.
            return run_cloud_dub(jid, video_path, out_path, job.get("source_lang"),
                                 language_code, job.get("num_speakers"), log,
                                 tts_model=job.get("perso_model"),
                                 title=job.get("title") or job.get("project"))
        # A stage sent to Perso is named on its workspace as the cloud dub is
        # (owner, 2026-10-22); said only then, for the same fakes.
        to_perso = not voices_only and "perso" in (job.get("stt_engine"), job.get("separation"))
        perso_name = (job.get("title") or job.get("project")) if to_perso else None
        return run_dub(
            video_path=video_path,
            srt_path=srt_path,
            source_srt_path=None if voices_only else source_srt_path,
            out_path=out_path,
            language=language,
            language_code=language_code,
            num_speakers=None if voices_only else job.get("num_speakers"),
            stt_engine=None if voices_only or job.get("stt_engine") != "perso" else "perso",
            sep_engine=None if voices_only else job.get("separation"),
            translate_engine=None if voices_only else job.get("translator"),
            # The one engine choice a redub still answers to: how many takes
            # per line the voice engine scores before picking a winner.
            n_takes=job.get("quality"),
            source_language_code=None if voices_only else job.get("source_lang"),
            cancel_check=cancel_check,
            on_notice=on_notice,
            log=log,
            # Only said when it is true: the run_dub fakes in tests predate it.
            **({"resume": True} if resume else {}),
            **({"title": perso_name} if perso_name else {}),
        )

    return work_now


def _in_folder(work: str, name: str) -> Optional[str]:
    path = os.path.join(work, name)
    return path if os.path.exists(path) else None
