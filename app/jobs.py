"""Simple background job management.

Dubbing takes time, so when a request comes in it runs on a separate thread
and its progress status (running/done/error/cancelling/cancelled) can be
queried.
"""
import glob
import hashlib
import json
import os
import threading
import uuid
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from app.config import PERSODUB_LOG_DIR

# What a job.json holds. Deliberately not the whole record: `logs` runs to
# thousands of lines, and `notices`/`cancel_requested` only mean anything while
# the job is still running. `result` is added separately -- only its out_path
# and the language it detected, because the rest of run_dub's return value is of
# no use once the job is over.
# `language` is the target language's NAME ("Korean"), which is what run_dub
# takes -- without it a job restored from a file could only be run again on its
# code. `trim_pending` says the cut has NOT been made in input.mp4 yet, which is
# only ever true of a link job between its download and its cut; written that way
# round so that a job.json from before it existed (no key, so false) is read as
# "already cut", which is what every job saved until now was.
# The engine choices a job was started with (stt_engine "whisper"/"perso",
# translator "gemma"/"gemini"/..., tts "qwen3", quality = how many takes per line,
# separation "demucs"/"perso") are saved too, so a finished job can say what made it and "Try again" can
# repeat the same choices instead of falling back to today's defaults. A job.json
# written before they existed simply has no such keys -- every reader treats them
# as unknown and shows nothing.
SAVED_FIELDS = ("id", "status", "language", "language_code", "source_lang",
                "project", "day", "from_link", "created", "work_dir", "trim",
                "trim_pending", "error", "remade_as",
                "stt_engine", "translator", "tts", "quality", "separation",
                "dub_mode", "perso_project_seq")

# What GET /api/dub/jobs sends the screen: the same minus the two absolute
# paths. The sidebar names a job, colours its dot and addresses everything else
# -- open, delete, retry -- by id, so shipping the user's home directory in
# every row would be for nothing.
LIST_FIELDS = tuple(f for f in SAVED_FIELDS if f != "work_dir")


class JobCancelled(Exception):
    """Raised by a job's target function (see app/pipeline.py's cancel_check
    checkpoints) to signal cooperative cancellation -- caught by JobStore's
    thread wrapper and turned into a "cancelled" status instead of "error"."""


class JobStore:
    def __init__(self, log_dir: Optional[str] = None):
        self._jobs: Dict[str, dict] = {}
        self._lock = threading.Lock()
        self._log_dir = log_dir

    @property
    def log_dir(self) -> str:
        # Resolved on every read, not in __init__: app/main.py builds its store
        # at import time, before test fixtures can redirect PERSODUB_LOG_DIR --
        # a snapshot taken then would litter the real logs/ on every test run.
        return self._log_dir or PERSODUB_LOG_DIR

    @staticmethod
    def _blank(jid: str) -> dict:
        """A fresh record. Also the shape a restored job is filled out to, so
        every reader (the screen, the poll endpoint) finds the keys it expects
        even on a job that came back from a file."""
        return {
            "id": jid,
            "status": "running",
            "result": None,
            "error": None,
            "logs": [],
            "notices": [],
            "cancel_requested": False,
            # When the job was started -- the only thing that can order the
            # Projects list, since a dict remembers nothing after a restart.
            # Down to the microsecond: two jobs started in the same second
            # would otherwise tie, and the list would order them by chance.
            "created": datetime.now().isoformat(),
        }

    def create(self) -> str:
        jid = uuid.uuid4().hex[:8]
        with self._lock:
            self._jobs[jid] = self._blank(jid)
        return jid

    def _update(self, jid: str, **kw):
        with self._lock:
            if jid in self._jobs:
                self._jobs[jid].update(kw)

    def _write_log_line(self, jid: str, msg: str):
        """Mirror a log line to log_dir/job-<jid>.log. Best-effort: a logging
        problem must never fail the dub it is describing."""
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            with open(os.path.join(self.log_dir, "job-%s.log" % jid), "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except Exception:
            pass

    def append_log(self, jid: str, msg: str):
        with self._lock:
            if jid not in self._jobs:
                return
            self._jobs[jid]["logs"].append(msg)
        self._write_log_line(jid, msg)

    def append_notice(self, jid: str, notice: dict):
        """Record a structured mid-job event (e.g. {"type": "perso_credit_exhausted",
        "message": ..., "link": ...}) in the job status JSON -- for events the UI
        needs to render specially (a message + link), not just as a plain log line.
        See app/pipeline.py's on_notice parameter and app/main.py, which wires it here.
        """
        with self._lock:
            if jid in self._jobs:
                self._jobs[jid]["notices"].append(notice)

    def get(self, jid: str) -> Optional[dict]:
        with self._lock:
            return dict(self._jobs[jid]) if jid in self._jobs else None

    def all(self) -> List[dict]:
        """Every job, newest first, without the logs or the file paths. What
        GET /api/dub/jobs (and so the Projects sidebar) is built from."""
        with self._lock:
            jobs = [dict(j) for j in self._jobs.values()]
        jobs.sort(key=lambda j: j.get("created") or "", reverse=True)
        return [{k: j.get(k) for k in LIST_FIELDS} for j in jobs]

    @staticmethod
    def _saved(j: dict) -> dict:
        rec = {k: j.get(k) for k in SAVED_FIELDS}
        result = j.get("result") or {}
        out = result.get("out_path")
        rec["result"] = {"out_path": out} if out else None
        # The done screen reads the source language from here when the job was
        # left on auto-detect, so it has to be in the file too -- otherwise a
        # restart empties that column.
        if rec["result"] and result.get("detected_source_language"):
            rec["result"]["detected_source_language"] = result["detected_source_language"]
        return rec

    def persist(self, jid: str, work_dir: str) -> None:
        """Write the job's record to work_dir/job.json.

        The record itself lives in memory and dies with the process, but the
        folder it describes does not -- so the file beside the video is what
        lets Projects reopen a job after a restart. Best-effort, like the log
        mirror: a job must not fail because its bookkeeping could not be saved.

        The folder is never created here. A real job always has one already, and
        making it would resurrect a folder the user has just deleted -- a ghost
        row in Projects holding nothing but a job.json.
        """
        j = self.get(jid)
        if j is None:
            return
        # Written beside the real file and then swapped in, never over the top
        # of it. open(..., "w") empties the file first, and the two moments this
        # is called -- as a job starts and as it ends -- are exactly when the
        # app is most likely to be quit; a half-written file would leave the
        # folder holding invalid JSON for good. os.replace within one folder is
        # atomic, so the file on disk is either the old record or the new one.
        final = os.path.join(work_dir, "job.json")
        tmp = final + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._saved(j), f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, final)
        except Exception:
            # Best-effort, like the log mirror -- but don't leave the scratch
            # file behind to be mistaken for something.
            try:
                os.remove(tmp)
            except OSError:
                pass

    def restore(self, root: str) -> None:
        """Read every job.json under root back into the store.

        Both folder depths are searched: real jobs live at
        <workspace>/<day>/<project_lang>/job.json, and a caller pointed
        straight at a day's folder is one level shallower.
        """
        paths = (glob.glob(os.path.join(root, "*", "*", "job.json"))
                 + glob.glob(os.path.join(root, "*", "job.json")))
        loaded = set()
        for path in sorted(paths):
            try:
                with open(path, encoding="utf-8") as f:
                    rec = json.load(f)
                jid = rec["id"]
            except Exception as e:
                # One unreadable file must not cost the user every other job.
                print("PersoDub: skipping %s (%s)" % (path, type(e).__name__))
                continue
            if rec.get("status") in ("running", "cancelling"):
                # The thread died with the process; nothing will ever finish it.
                # The token stays machine-readable; the screen turns it into a
                # sentence.
                rec["status"] = "error"
                rec["error"] = "interrupted"
            loaded.add(os.path.dirname(path))
            job = self._blank(jid)
            job.update(rec)
            with self._lock:
                self._jobs.setdefault(jid, job)
        self._restore_old_folders(root, loaded)

    def _restore_old_folders(self, root: str, loaded) -> None:
        """Rebuild a record for a finished folder that has no readable job.json.

        Only what the folder itself says: it holds a dubbed.mp4, its name is
        <project>_<lang> (plus _001 when the name was taken) and its parent is
        the day. The id is derived from the path so a second restore finds the
        same job rather than a duplicate.

        `loaded` is the folders whose job.json actually parsed -- not merely the
        ones that have a file. A folder whose job.json is damaged falls through
        to here and is rebuilt, instead of the broken file hiding a finished dub
        from Projects on every launch with no way back inside the app.
        """
        for work in sorted(glob.glob(os.path.join(root, "*", "*"))):
            if work in loaded:
                continue
            try:
                out = os.path.join(work, "dubbed.mp4")
                if not os.path.isfile(out):
                    continue
                parts = os.path.basename(work).split("_")
                if len(parts) > 1 and parts[-1].isdigit():
                    parts = parts[:-1]
                jid = hashlib.md5(work.encode("utf-8")).hexdigest()[:8]
                job = self._blank(jid)
                job.update(
                    status="done",
                    project="_".join(parts[:-1]) or os.path.basename(work),
                    language_code=parts[-1] if len(parts) > 1 else None,
                    day=os.path.basename(os.path.dirname(work)),
                    work_dir=work,
                    created=datetime.fromtimestamp(os.path.getmtime(out)).isoformat(timespec="seconds"),
                    result={"out_path": out},
                )
            except Exception as e:
                # Same promise as above: one odd folder is skipped, not fatal.
                print("PersoDub: skipping %s (%s)" % (work, type(e).__name__))
                continue
            with self._lock:
                self._jobs.setdefault(jid, job)

    def forget(self, jid: str) -> None:
        """Drop a job's record. Called when its folder is deleted: the record
        is what puts a row in Projects, so a job whose files are gone has to
        leave the list with them."""
        with self._lock:
            self._jobs.pop(jid, None)

    def is_cancel_requested(self, jid: str) -> bool:
        """Polled by app/pipeline.py's cancel_check at stage boundaries."""
        with self._lock:
            j = self._jobs.get(jid)
            return bool(j and j.get("cancel_requested"))

    def request_cancel(self, jid: str) -> Optional[str]:
        """Ask a running job to stop at its next stage boundary.

        Returns the job's status right after the call, or None if jid is
        unknown. A job that isn't "running" is left untouched (e.g. an
        already-finished job can't be cancelled) -- its current status is
        returned so the caller (POST /api/dub/jobs/{id}/cancel) can tell a
        real cancel apart from a no-op.
        """
        with self._lock:
            j = self._jobs.get(jid)
            if j is None:
                return None
            if j["status"] != "running":
                return j["status"]
            j["cancel_requested"] = True
            j["status"] = "cancelling"
            return "cancelling"

    def run_async(self, target: Callable[[Callable[[str], None]], Any]) -> str:
        """Create a job, run target(log) on a background thread, return the job id.

        target is passed a log(msg) function it can use to record progress.
        """
        jid = self.create()
        self.start(jid, target)
        return jid

    def start(self, jid: str, target: Callable[[Callable[[str], None]], Any]) -> None:
        """Run target(log) on a background thread for an already-created job id.

        Used when the caller needs the job id before the thread starts (e.g.
        to build a cancel_check closure bound to that id -- see app/main.py).
        """
        def log(msg: str):
            self.append_log(jid, msg)

        def _wrap():
            try:
                result = target(log)
                # A job left on auto-detect only learns its source language by
                # running, and the answer arrives inside the result. Copying it
                # onto the record is what makes it outlive the process: the file
                # keeps the record, and the done screen names the source column
                # from it. A language the user actually chose is never overwritten.
                detected = result.get("detected_source_language") if isinstance(result, dict) else None
                with self._lock:
                    if self._jobs[jid]["status"] == "cancelling":
                        self._jobs[jid]["status"] = "cancelled"
                    else:
                        self._jobs[jid]["status"] = "done"
                        self._jobs[jid]["result"] = result
                        if detected and not self._jobs[jid].get("source_lang"):
                            self._jobs[jid]["source_lang"] = detected
            except JobCancelled:
                self._update(jid, status="cancelled")
            except Exception as e:
                # The class name stays in the log for debugging; the stored
                # error is what the UI shows the user under the red bar, and
                # "RuntimeError:" in front of a plain-language sentence only
                # made it read like a crash.
                log(f"Error: {type(e).__name__}: {e}")
                self._update(jid, status="error", error=str(e) or type(e).__name__)
            # However it ended, the file beside the video now says so -- this is
            # the only moment the final status exists to be written down.
            work_dir = (self.get(jid) or {}).get("work_dir")
            if work_dir:
                self.persist(jid, work_dir)

        threading.Thread(target=_wrap, daemon=True).start()
