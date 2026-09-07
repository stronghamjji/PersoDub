"""What the four ways of starting a dub actually hand the pipeline.

app/api/dub.py built a job's work in four separate places -- dub_start,
"Try again", a redub, and the boot re-arm -- and they had drifted apart.
Before those four were folded into one builder (app/dub_launch.py) this file
recorded, for a fixed job in each of them, the exact arguments that reach
run_dub / the Perso cloud path / the download / the trim. The recordings
below are literal: they were taken from the code as it stood BEFORE the fold,
and they are what proves the fold changed nothing.

The one difference the fold was allowed to make is a bug fix, and it is
deliberately outside these frozen dicts: "Try again" now carries a job's
subtitle files into the new folder, so a job started from subtitles no longer
comes back transcribed. Every scenario here starts from a folder with no
subtitles in it, where that fix has nothing to change; the fix has its own
test at the bottom.

Recorded through `_as_the_pipeline_reads_it`, not raw, for two reasons that
are both about comparing like with like -- see that function.
"""
import inspect
import os
import time

import pytest
from fastapi.testclient import TestClient

from app import engines_status, pipeline, state
from app.api import dub as dub_api
from app.config import QWEN_N_TAKES
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


# ---------------------------------------------------------------------------
# A fixed world, so the recordings are about the code and not about this
# machine: no saved defaults in kit.env, no engine probes, no model files, and
# a pinned date so folder names are stable.
# ---------------------------------------------------------------------------

_DEFAULTS = {"dub_mode": "local", "separation": "local", "stt": "local",
             "translator": "hunyuan", "voice_quality": "fast"}


@pytest.fixture(autouse=True)
def _fixed_world(monkeypatch):
    monkeypatch.setattr(dub_api.dub_setup, "default_for", lambda stage: _DEFAULTS[stage])
    # None is the "kit.env never chose a quality" case, the one that makes
    # dub_start hand run_dub no n_takes at all.
    monkeypatch.setattr(dub_api.dub_setup, "default_n_takes", lambda: None)
    monkeypatch.setattr(dub_api, "default_stt_engine", lambda: "")
    monkeypatch.setattr(dub_api, "_today", lambda: "2026-09-06")
    monkeypatch.setattr(dub_api, "_missing_models", lambda *a, **kw: [])
    monkeypatch.setattr(dub_api, "current_value",
                        lambda k: "1" if k == "PERSO_SPACE_SEQ" else "x")
    for name in ("gemma_status", "hunyuan_status", "qwen_status"):
        monkeypatch.setattr(engines_status, name, lambda: "available")
    for name in ("gemma_available", "hunyuan_available", "qwen_available",
                 "gemini_available", "perso_available"):
        monkeypatch.setattr(engines_status, name, lambda: True)


@pytest.fixture
def recorder(monkeypatch):
    """Stand in for everything a job's work calls, and write down the call."""
    seen = {"run_dub": [], "cloud": [], "fetch": [], "cut": []}

    def fake_run_dub(**kw):
        seen["run_dub"].append(kw)
        return {"out_path": kw["out_path"], "num_segments": 0}

    def fake_cloud(jid, video_path, out_path, source_code, target_code, num_speakers, log):
        seen["cloud"].append({"jid_is_the_new_job": jid, "video_path": video_path,
                              "out_path": out_path, "source_code": source_code,
                              "target_code": target_code, "num_speakers": num_speakers})
        return {"out_path": out_path}

    def fake_fetch(url, dest, log=None, cancel_check=None):
        seen["fetch"].append({"url": url, "dest": dest,
                              "cancel_check_given": callable(cancel_check)})
        with open(dest, "wb") as f:
            f.write(b"FAKEMP4")

    def fake_cut(path, start, end, on_cut=None):
        seen["cut"].append({"path": path, "start": start, "end": end,
                            "on_cut_given": on_cut is not None})
        if on_cut:
            on_cut()

    monkeypatch.setattr(dub_api, "run_dub", fake_run_dub)
    monkeypatch.setattr(dub_api, "_run_cloud_dub", fake_cloud)
    monkeypatch.setattr(dub_api, "fetch_source", fake_fetch)
    monkeypatch.setattr(dub_api, "_cut_video", fake_cut)
    return seen


# ---------------------------------------------------------------------------
# Comparing like with like
# ---------------------------------------------------------------------------

# Three of run_dub's arguments are not read as the strings they arrive as, and
# freezing them raw would pin a spelling instead of a behaviour:
#   stt_engine  -- read as `stt_engine == "perso"`      (app/pipeline.py)
#   sep_engine  -- read as `(sep_engine or "").lower() == "perso"`
#   n_takes     -- read as `n_takes if n_takes is not None else QWEN_N_TAKES`
# The record a job is saved with keeps the same three as "perso"/"whisper",
# "perso"/"demucs" and a resolved take count, so a builder that reads them back
# off the record says "None" where dub_start said "local" and "4" where
# dub_start said nothing at all. The pipeline cannot tell those apart, so this
# folds each pair into the single value the pipeline acts on.
_PERSO_OR_NOT = ("stt_engine", "sep_engine")


def _as_the_pipeline_reads_it(kw, work):
    """One recorded run_dub call, in the form run_dub actually acts on.

    Missing arguments are filled in from run_dub's own defaults (passing
    srt_path=None and not passing srt_path at all are the same call), the
    three engine selectors above are folded to what the pipeline tests them
    for, the callbacks are reduced to "a callback was wired", and paths are
    made relative to the job's folder so the recordings do not carry a
    tmp_path.
    """
    bound = inspect.signature(pipeline.run_dub).bind_partial(**kw)
    bound.apply_defaults()
    out = dict(bound.arguments)
    for key in _PERSO_OR_NOT:
        out[key] = "perso" if (out.get(key) or "").lower() == "perso" else None
    out["n_takes"] = out["n_takes"] if out["n_takes"] is not None else QWEN_N_TAKES
    for key in ("log", "cancel_check", "on_notice"):
        out[key] = "wired" if callable(out[key]) else None
    for key in ("video_path", "out_path", "srt_path", "source_srt_path"):
        out[key] = _under(out[key], work)
    # Never set by any caller here; they are the sidecar seams tests inject.
    for key in ("diar_engine", "qwen_engine", "perso_client", "translator"):
        out.pop(key, None)
    return out


def _under(path, work):
    if not path:
        return None
    return "<work>/" + os.path.relpath(path, work)


def _wait(calls, n=1, secs=5.0):
    deadline = time.time() + secs
    while time.time() < deadline:
        if len(calls) >= n:
            return calls
        time.sleep(0.02)
    raise AssertionError("the job's work never ran")


def _work_dir(jid):
    return state.job_store.get(jid)["work_dir"]


# ---------------------------------------------------------------------------
# The frozen recordings
# ---------------------------------------------------------------------------

# A local dub started from an upload, with both subtitle files handed in.
START_UPLOAD = {
    "video_path": "<work>/input.mp4",
    "out_path": "<work>/dubbed.mp4",
    "srt_path": "<work>/sub.srt",
    "source_srt_path": "<work>/source.srt",
    "language": "Korean",
    "language_code": "ko",
    "num_speakers": 2,
    "translate_engine": "gemini",
    "stt_engine": None,
    "sep_engine": None,
    "source_language_code": "en",
    "n_takes": QWEN_N_TAKES,
    "log": "wired",
    "cancel_check": "wired",
    "on_notice": "wired",
}

# The same dub started from a link, with a trim the download owes.
START_URL_TRIM = {
    "video_path": "<work>/input.mp4",
    "out_path": "<work>/dubbed.mp4",
    "srt_path": None,
    "source_srt_path": None,
    "language": "Korean",
    "language_code": "ko",
    "num_speakers": None,
    "translate_engine": "hunyuan",
    "stt_engine": None,
    "sep_engine": None,
    "source_language_code": None,
    "n_takes": QWEN_N_TAKES,
    "log": "wired",
    "cancel_check": "wired",
    "on_notice": "wired",
}

# "Try again" on a failed Perso-transcribed job.
RETRY = {
    "video_path": "<work>/input.mp4",
    "out_path": "<work>/dubbed.mp4",
    "srt_path": None,
    "source_srt_path": None,
    "language": "Korean",
    "language_code": "ko",
    "num_speakers": None,
    "translate_engine": "gemini",
    "stt_engine": "perso",
    "sep_engine": "perso",
    "source_language_code": "en",
    "n_takes": 2,
    "log": "wired",
    "cancel_check": "wired",
    "on_notice": "wired",
}

# A redub: the script goes back in, only the voices are made again.
REDUB = {
    "video_path": "<work>/input.mp4",
    "out_path": "<work>/dubbed.mp4",
    "srt_path": "<work>/sub.srt",
    "source_srt_path": None,
    "language": "Korean",
    "language_code": "ko",
    "num_speakers": None,
    "translate_engine": None,
    "stt_engine": None,
    "sep_engine": None,
    "source_language_code": None,
    "n_takes": 2,
    "log": "wired",
    "cancel_check": "wired",
    "on_notice": "wired",
}

# A job that waited out a restart, rebuilt from its job.json and its folder.
REARM = {
    "video_path": "<work>/input.mp4",
    "out_path": "<work>/dubbed.mp4",
    "srt_path": "<work>/sub.srt",
    "source_srt_path": "<work>/source.srt",
    "language": "Korean",
    "language_code": "ko",
    "num_speakers": 3,
    "translate_engine": "gemini",
    "stt_engine": "perso",
    "sep_engine": "perso",
    "source_language_code": "en",
    "n_takes": 2,
    "log": "wired",
    "cancel_check": "wired",
    "on_notice": "wired",
}


# ---------------------------------------------------------------------------
# Starting from the screen
# ---------------------------------------------------------------------------

def test_start_from_an_upload(recorder):
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"video-bytes", "video/mp4"),
               "srt": ("sub.srt", b"1\n", "text/plain"),
               "source_srt": ("src.srt", b"1\n", "text/plain")},
        data={"language": "Korean", "language_code": "ko", "num_speakers": 2,
              "translate_engine": "gemini", "source_language_code": "en"},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]
    kw = _wait(recorder["run_dub"])[0]
    assert _as_the_pipeline_reads_it(kw, _work_dir(jid)) == START_UPLOAD
    assert recorder["fetch"] == [] and recorder["cut"] == []


def test_start_from_a_link_with_a_trim(recorder):
    r = client.post(
        "/api/dub/start",
        data={"source_url": "https://example.test/v", "language": "Korean",
              "language_code": "ko", "trim_start": 5.0, "trim_end": 20.0},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]
    work = _work_dir(jid)
    kw = _wait(recorder["run_dub"])[0]
    assert _as_the_pipeline_reads_it(kw, work) == START_URL_TRIM
    assert recorder["fetch"] == [{"url": "https://example.test/v",
                                  "dest": os.path.join(work, "input.mp4"),
                                  "cancel_check_given": True}]
    # The cut runs inside the job, after the download, and records itself the
    # instant it lands (on_cut) so a restart cannot cut the same seconds twice.
    assert recorder["cut"] == [{"path": os.path.join(work, "input.mp4"),
                                "start": 5.0, "end": 20.0, "on_cut_given": True}]
    assert state.job_store.get(jid)["trim_pending"] is False


def test_start_a_perso_cloud_dub(recorder):
    r = client.post(
        "/api/dub/start",
        files={"video": ("v.mp4", b"video-bytes", "video/mp4")},
        data={"language": "Korean", "language_code": "ko", "dub_mode": "perso",
              "num_speakers": 2, "source_language_code": "en"},
    )
    assert r.status_code == 200
    jid = r.json()["job_id"]
    work = _work_dir(jid)
    assert _wait(recorder["cloud"])[0] == {
        "jid_is_the_new_job": jid,
        "video_path": os.path.join(work, "input.mp4"),
        "out_path": os.path.join(work, "dubbed.mp4"),
        "source_code": "en",
        "target_code": "ko",
        "num_speakers": 2,
    }
    assert recorder["run_dub"] == []


# ---------------------------------------------------------------------------
# Starting again from a job that already exists
# ---------------------------------------------------------------------------

def _saved_job(tmp_path, name="saved", **fields):
    """A job as job.json holds it: a folder with the video in it, and only the
    fields that survive a restart."""
    work = tmp_path / name
    work.mkdir(exist_ok=True)
    (work / "input.mp4").write_bytes(b"vid")
    jid = state.job_store.create()
    state.job_store._update(jid, status="error", work_dir=str(work),
                            project=name, **fields)
    return jid, work


_FIRST_RUN = {"language": "Korean", "language_code": "ko", "source_lang": "en",
              "stt_engine": "perso", "translator": "gemini", "tts": "qwen3",
              "quality": 2, "separation": "perso", "dub_mode": "local"}


def test_try_again(recorder, tmp_path):
    jid, _ = _saved_job(tmp_path, **_FIRST_RUN)
    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200
    kw = _wait(recorder["run_dub"])[0]
    assert _as_the_pipeline_reads_it(kw, _work_dir(r.json()["job_id"])) == RETRY


def test_redub(recorder, tmp_path):
    jid, work = _saved_job(tmp_path, name="finished", **_FIRST_RUN)
    (work / "translated.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n\n")
    # A redub starts from a job that finished: the folder is found through the
    # result, not through work_dir (app/api/_shared.py:script_work_dir).
    state.job_store._update(jid, status="done",
                            result={"out_path": str(work / "dubbed.mp4")})
    r = client.post(f"/api/dub/jobs/{jid}/redub")
    assert r.status_code == 200
    kw = _wait(recorder["run_dub"])[0]
    assert _as_the_pipeline_reads_it(kw, _work_dir(r.json()["job_id"])) == REDUB


def test_rearm_after_a_restart(recorder, tmp_path):
    jid, work = _saved_job(tmp_path, name="queued", num_speakers=3, **_FIRST_RUN)
    (work / "sub.srt").write_text("1\n")
    (work / "source.srt").write_text("1\n")
    job = state.job_store.get(jid)

    dub_api._dub_target_for(job)(lambda msg: None)

    assert _as_the_pipeline_reads_it(recorder["run_dub"][0], str(work)) == REARM


def test_rearm_of_a_cloud_job(recorder, tmp_path):
    jid, work = _saved_job(tmp_path, name="queued-cloud", language="Korean",
                           language_code="ko", source_lang="en", num_speakers=3,
                           dub_mode="perso")
    job = state.job_store.get(jid)

    dub_api._dub_target_for(job)(lambda msg: None)

    assert recorder["cloud"] == [{
        "jid_is_the_new_job": jid,
        "video_path": os.path.join(work, "input.mp4"),
        "out_path": os.path.join(work, "dubbed.mp4"),
        "source_code": "en",
        "target_code": "ko",
        "num_speakers": 3,
    }]


def test_rearm_downloads_only_when_the_video_is_missing(recorder, tmp_path):
    """dub_start downloads whenever the job has a link, the re-arm only when
    input.mp4 is not there. For a fresh start the file cannot exist yet, so the
    two rules agree -- this pins the half that a shared builder must keep."""
    jid, work = _saved_job(tmp_path, name="link-job", source_url="https://x.test/v",
                           **_FIRST_RUN)
    dub_api._dub_target_for(state.job_store.get(jid))(lambda msg: None)
    assert recorder["fetch"] == []   # input.mp4 is already there

    (work / "input.mp4").unlink()
    dub_api._dub_target_for(state.job_store.get(jid))(lambda msg: None)
    assert [f["url"] for f in recorder["fetch"]] == ["https://x.test/v"]


# ---------------------------------------------------------------------------
# The Perso cloud path's three failures
# ---------------------------------------------------------------------------

_CLOUD_FAILURES = [
    ("PersoCreditExhaustedError",
     "   Error: Perso credits are used up. Recharge to continue. (https://perso.ai/billing)",
     {"type": "perso_credit_exhausted",
      "message": "Perso credits are used up. Recharge to continue.",
      "link": "https://perso.ai/billing"}),
    ("PersoInvalidKeyError",
     "   Error: Perso rejected the API key. Open Settings and check the key.",
     {"type": "perso_invalid_key",
      "message": "Perso rejected the API key. Open Settings and check the key."}),
    ("PersoUnavailableError",
     "   Error: Perso's server is temporarily unavailable. Wait a few minutes, then run this job again.",
     {"type": "perso_unavailable",
      "message": "Perso's server is temporarily unavailable. Wait a few minutes, then run this job again."}),
]


@pytest.mark.parametrize("exc_name,expected_line,expected_notice", _CLOUD_FAILURES)
def test_the_cloud_path_reports_a_perso_failure_the_same_way(
        monkeypatch, tmp_path, exc_name, expected_line, expected_notice):
    """The three hand-written except blocks became one call to the pipeline's
    shared reporter; this pins the log line and the notice dict byte for byte."""
    from app import perso_client as pc_module

    exc = getattr(pc_module, exc_name)

    class FakeClient:
        def describe_workspace(self):
            return None

        def dub_video(self, *a, **kw):
            raise exc("boom", link="https://perso.ai/billing") if exc_name.startswith(
                "PersoCredit") else exc("boom")

    monkeypatch.setattr(pc_module, "PersoClient", FakeClient)
    jid = state.job_store.create()
    lines = []

    with pytest.raises(RuntimeError) as caught:
        dub_api._run_cloud_dub(jid, str(tmp_path / "in.mp4"), str(tmp_path / "out.mp4"),
                               "en", "ko", None, lines.append)

    assert str(caught.value) == expected_notice["message"]
    assert lines[-1] == expected_line
    assert state.job_store.get(jid)["notices"] == [expected_notice]


# ---------------------------------------------------------------------------
# The one deliberate change: "Try again" on a job made from subtitles
# ---------------------------------------------------------------------------

def test_try_again_keeps_the_subtitles_the_job_was_made_from(recorder, tmp_path):
    """The bug this refactor fixes. "Try again" copied only input.mp4 and passed
    run_dub no subtitles, so a job started from a source-subtitle file came back
    transcribed by Whisper instead -- a different dub, with no sign on screen
    that anything had changed. The re-arm path always did this right."""
    jid, work = _saved_job(tmp_path, name="from-subs", **_FIRST_RUN)
    (work / "sub.srt").write_text("1\ntranslated\n")
    (work / "source.srt").write_text("1\nsource\n")

    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200
    new_work = _work_dir(r.json()["job_id"])
    kw = _wait(recorder["run_dub"])[0]

    assert kw["srt_path"] == os.path.join(new_work, "sub.srt")
    assert kw["source_srt_path"] == os.path.join(new_work, "source.srt")
    # Copied, not pointed at the old folder: the old job stays intact.
    assert open(os.path.join(new_work, "source.srt")).read() == "1\nsource\n"


def test_try_again_on_a_cloud_job_goes_back_to_the_cloud(recorder, tmp_path):
    """A cloud job has no local engine choices to inherit, so the retried
    record has to carry dub_mode itself -- and it does, so a retry that waits
    out a restart in the queue is rebuilt as a cloud job too (the re-arm reads
    nothing but job.json). Speaker count stays unset, as it always has --
    retry does not carry one."""
    jid, work = _saved_job(tmp_path, name="cloud", language="Korean",
                           language_code="ko", source_lang="en",
                           num_speakers=3, dub_mode="perso")
    r = client.post(f"/api/dub/jobs/{jid}/retry")
    assert r.status_code == 200
    new_jid = r.json()["job_id"]
    new_work = _work_dir(new_jid)
    assert _wait(recorder["cloud"])[0] == {
        "jid_is_the_new_job": new_jid,
        "video_path": os.path.join(new_work, "input.mp4"),
        "out_path": os.path.join(new_work, "dubbed.mp4"),
        "source_code": "en",
        "target_code": "ko",
        "num_speakers": None,
    }
    assert recorder["run_dub"] == []
    assert state.job_store.get(new_jid)["dub_mode"] == "perso"
