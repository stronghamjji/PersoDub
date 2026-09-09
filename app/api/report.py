# -*- coding: utf-8 -*-
"""What the backend knows about a failure, gathered for an automatic report.

The desktop shell owns the report: it decides whether to send one, adds what
only it knows (the machine, shell.log, the app version) and posts the result.
This route is the half the shell cannot see -- the failed job's record, the
stage it died in, the app's own rolling log and the job's log.

Nothing here reads kit.env. That file holds the user's API keys, and the one
way to be sure a key never travels is for the code that builds the report to
have no way of reading one. The two values from it that the report does carry
(the torch build, and whether the reports switch is on) come from the process
environment the shell injected at startup, never from the file.

Masking happens HERE, at the moment of collection, not at the moment of
sending: a report that is saved to disk after a failed send, or printed by
PERSODUB_REPORTS_DEBUG, has already had the home directory and the keys taken
out of it.
"""
import os
import re
from typing import Optional

from fastapi import APIRouter

from app import models, state
from app.api._shared import work_dir_of
from app.jobs import kind_of
from app.logging_setup import LOG_FILE_NAME
from app.report_mask import mask_tail, mask_text, read_masked
from app.stages import STAGES

router = APIRouter()

# The "N/6" marker every stage log line starts with (app/stages.py). The last
# one in a job's log is the stage the job was in when it stopped.
_MARKER = re.compile(r"\b(\d{1,2})/%d\b" % len(STAGES))

# The engine choices a job was started with. Named one by one rather than
# copied out of the record, for the same reason the shell's report is an
# allow-list: the record also holds the project name, the file paths and the
# link the video came from, and none of those is a fact about the failure.
ENGINE_FIELDS = ("stt_engine", "translator", "tts", "quality", "separation", "dub_mode")


def stage_of(log_text: str):
    """(marker, stage name) for the last stage a job reached, e.g. ("4/6",
    "synthesize"). ("", "") when the log never got that far.

    Read from the stage table rather than from a list of its own: inserting a
    stage renumbers every marker at once (app/stages.py), and a copy here would
    be the thing that did not move.
    """
    last = None
    for m in _MARKER.finditer(log_text or ""):
        n = int(m.group(1))
        if 1 <= n <= len(STAGES):
            last = n
    if last is None:
        return "", ""
    return "%d/%d" % (last, len(STAGES)), STAGES[last - 1][0]


def _packs():
    """Which heavy packs are on this kit, as the models catalog sees them."""
    try:
        return {r["id"]: r["state"] for r in models.status_rows() if r.get("role") == "pack"}
    except Exception:
        return {}


@router.get("/api/report/bundle")
def report_bundle(job: Optional[str] = None):
    """The backend's half of a failure report.

    `job` is the failed job's id; without one (an install or a boot failure,
    where no job exists) the answer still carries the machine's facts and the
    app's own log, which is what a boot failure leaves behind.
    """
    home = os.path.expanduser("~")
    # Asked of the store that writes the job logs rather than read from
    # app.config here: it resolves PERSODUB_LOG_DIR at call time, so a redirect
    # (a test, a user who moved the folder) reaches this route too. The app's
    # own rolling log shares that folder -- see app/logging_setup.py.
    log_dir = state.job_store.log_dir
    app_log = read_masked(os.path.join(log_dir, LOG_FILE_NAME), home)
    job_log = ""
    record = {}

    j = state.job_store.get(job) if job else None
    if j:
        job_log = read_masked(os.path.join(log_dir, "job-%s.log" % job), home)
        marker, stage = stage_of(job_log)
        record = {
            "kind": kind_of(j),
            "status": j.get("status") or "",
            "stage": stage,
            "stageMarker": marker,
            "engines": {k: j.get(k) for k in ENGINE_FIELDS if j.get(k)},
            "error": mask_text(j.get("error") or "", home),
        }

    return {
        "job": record,
        "platformKey": models.platform_key(),
        "torch": os.environ.get("PERSODUB_TORCH_VARIANT", "").strip().lower(),
        "packs": _packs(),
        "freeDiskBytes": models.free_bytes_at(work_dir_of(j) if j else state.WORKSPACE),
        # The ends of the two logs, for the issue body.
        "logTails": {"app": mask_tail(app_log), "job": mask_tail(job_log)},
        # And the whole of them, for the archive the shell uploads beside it.
        "logs": {"app": app_log, "job": job_log},
    }
