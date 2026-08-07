"""Simple background job management.

Dubbing takes time, so when a request comes in it runs on a separate thread
and its progress status (running/done/error/cancelling/cancelled) can be
queried.
"""
import os
import threading
import uuid
from typing import Any, Callable, Dict, Optional

from app.config import PERSODUB_LOG_DIR


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

    def create(self) -> str:
        jid = uuid.uuid4().hex[:8]
        with self._lock:
            self._jobs[jid] = {
                "id": jid,
                "status": "running",
                "result": None,
                "error": None,
                "logs": [],
                "notices": [],
                "cancel_requested": False,
            }
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
                with self._lock:
                    if self._jobs[jid]["status"] == "cancelling":
                        self._jobs[jid]["status"] = "cancelled"
                    else:
                        self._jobs[jid]["status"] = "done"
                        self._jobs[jid]["result"] = result
            except JobCancelled:
                self._update(jid, status="cancelled")
            except Exception as e:
                # The class name stays in the log for debugging; the stored
                # error is what the UI shows the user under the red bar, and
                # "RuntimeError:" in front of a plain-language sentence only
                # made it read like a crash.
                log(f"❌ Error: {type(e).__name__}: {e}")
                self._update(jid, status="error", error=str(e) or type(e).__name__)

        threading.Thread(target=_wrap, daemon=True).start()
