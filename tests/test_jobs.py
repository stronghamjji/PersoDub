import threading
import time

from app.jobs import JobCancelled, JobStore


def _wait(store, jid):
    for _ in range(100):
        j = store.get(jid)
        if j and j["status"] != "running":
            return j
        time.sleep(0.02)
    return store.get(jid)


def test_run_async_success():
    store = JobStore()
    jid = store.run_async(lambda log: {"ok": True})
    j = _wait(store, jid)
    assert j["status"] == "done"
    assert j["result"] == {"ok": True}


def test_run_async_logs_captured():
    store = JobStore()

    def work(log):
        log("step 1")
        log("step 2")
        return "ok"

    jid = store.run_async(work)
    j = _wait(store, jid)
    assert j["status"] == "done"
    assert j["logs"] == ["step 1", "step 2"]


def test_run_async_error():
    store = JobStore()

    def boom(log):
        raise ValueError("nope")

    jid = store.run_async(boom)
    j = _wait(store, jid)
    assert j["status"] == "error"
    assert "nope" in j["error"]
    assert any("nope" in line for line in j["logs"])


def test_get_unknown_returns_none():
    store = JobStore()
    assert store.get("does-not-exist") is None


def test_new_job_has_empty_notices():
    store = JobStore()
    jid = store.create()
    assert store.get(jid)["notices"] == []


def test_append_notice_recorded_in_job_status():
    store = JobStore()
    jid = store.create()
    store.append_notice(jid, {"type": "perso_credit_exhausted", "message": "m", "link": "https://x"})
    j = store.get(jid)
    assert j["notices"] == [{"type": "perso_credit_exhausted", "message": "m", "link": "https://x"}]


def test_append_notice_unknown_job_is_a_noop():
    store = JobStore()
    store.append_notice("does-not-exist", {"type": "x"})  # must not raise


# --- cancellation ------------------------------------------------------

def test_request_cancel_unknown_job_returns_none():
    store = JobStore()
    assert store.request_cancel("does-not-exist") is None


def test_request_cancel_marks_running_job_cancelling():
    store = JobStore()
    started = threading.Event()
    release = threading.Event()

    def work(log):
        started.set()
        release.wait(2)
        return "ok"

    jid = store.run_async(work)
    started.wait(2)

    status = store.request_cancel(jid)
    assert status == "cancelling"
    assert store.get(jid)["status"] == "cancelling"
    assert store.is_cancel_requested(jid) is True

    release.set()  # let the fake job finish so its thread doesn't linger


def test_cancelled_job_target_raises_jobcancelled_ends_up_cancelled():
    store = JobStore()

    def work(log):
        raise JobCancelled("stopped at a stage boundary")

    jid = store.run_async(work)
    j = _wait(store, jid)
    assert j["status"] == "cancelled"
    assert j["error"] is None


def test_request_cancel_on_finished_job_is_a_noop():
    store = JobStore()
    jid = store.run_async(lambda log: {"ok": True})
    _wait(store, jid)  # job is "done" by now

    status = store.request_cancel(jid)
    assert status == "done"  # unchanged -- nothing to cancel
    assert store.get(jid)["status"] == "done"


# --- Job logs on disk -------------------------------------------------------
# The 6-stage progress log only ever lived in memory, so it vanished when the
# app closed and a user asking "where is the log?" had nowhere to look. Every
# line now also lands in PERSODUB_LOG_DIR/job-<id>.log.
def test_append_log_writes_a_file(tmp_path):
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store.append_log(jid, "1/6 Separating background audio…")
    store.append_log(jid, "✅ Done!")
    written = (tmp_path / ("job-%s.log" % jid)).read_text(encoding="utf-8")
    assert "1/6 Separating background audio…" in written
    assert "✅ Done!" in written


def test_log_file_survives_an_unwritable_dir(tmp_path):
    # Logging must never be able to fail a dub.
    store = JobStore(log_dir=str(tmp_path / "nope" / "\0bad"))
    jid = store.create()
    store.append_log(jid, "still fine")
    assert store.get(jid)["logs"] == ["still fine"]


def test_log_dir_defaults_to_the_configured_setting():
    # No argument -> the configured directory, not a hardcoded path. Read off
    # the module so the value stays overridable (conftest redirects it).
    from app import jobs as jobs_module

    assert JobStore().log_dir == jobs_module.PERSODUB_LOG_DIR


def test_log_dir_override_applies_to_stores_created_earlier(tmp_path, monkeypatch):
    # app/main.py builds its JobStore at import time -- before test fixtures
    # patch PERSODUB_LOG_DIR. Resolving the dir at write time (not __init__)
    # keeps that store redirectable; without it every API test run littered
    # the real logs/ folder with job-<id>.log stubs.
    from app import jobs as jobs_module

    store = JobStore()  # created "too early", like main.job_store
    monkeypatch.setattr(jobs_module, "PERSODUB_LOG_DIR", str(tmp_path / "redir"))
    jid = store.create()
    store.append_log(jid, "redirected line")
    assert (tmp_path / "redir" / ("job-%s.log" % jid)).exists()
