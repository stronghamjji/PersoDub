import json
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


# ---------------- job.json: a job outlives the process that ran it ----------
# Before this, the whole job list lived in memory: quitting the app lost every
# record, so yesterday's finished dub could not be reopened even though its
# folder was still sitting there.


def test_job_store_survives_a_restart(tmp_path):
    (tmp_path / "x").mkdir()  # persist writes into a job's own folder, never makes one
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="done", project="a", day="2026-08-26", language_code="ko", result={"out_path": str(tmp_path / "x" / "dubbed.mp4")})
    store.persist(jid, str(tmp_path / "x"))
    store2 = JobStore(log_dir=str(tmp_path)); store2.restore(str(tmp_path))
    assert store2.get(jid)["status"] == "done"


def test_job_json_leaves_out_the_noisy_fields(tmp_path):
    # logs can run to thousands of lines and notices/cancel_requested only mean
    # anything while the job is running -- none of them belong in the file the
    # Projects list is built from.
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store.append_log(jid, "a line")
    store._update(jid, status="done", project="a")
    store.persist(jid, str(tmp_path / "x"))
    with open(str(tmp_path / "x" / "job.json"), encoding="utf-8") as f:
        saved = json.load(f)
    assert "logs" not in saved and "notices" not in saved
    assert "cancel_requested" not in saved
    assert saved["created"]


def test_a_job_that_was_running_comes_back_as_interrupted(tmp_path):
    # The thread died with the process; nothing will ever finish this job, so
    # showing it as still running would be a lie the screen never recovers from.
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store.persist(jid, str(tmp_path / "x"))
    store2 = JobStore(log_dir=str(tmp_path)); store2.restore(str(tmp_path))
    j = store2.get(jid)
    assert j["status"] == "error" and j["error"] == "interrupted"
    # The screen reads these on every job it draws.
    assert j["logs"] == [] and j["notices"] == []


def test_restore_skips_a_broken_job_json(tmp_path):
    (tmp_path / "day" / "job").mkdir(parents=True)
    (tmp_path / "day" / "job" / "job.json").write_text("{ not json", encoding="utf-8")
    store = JobStore(log_dir=str(tmp_path))
    store.restore(str(tmp_path))  # must not raise


def test_restore_finds_old_folders_that_have_no_job_json(tmp_path):
    # Every folder made before job.json existed. They still hold a dubbed.mp4,
    # so rebuild just enough of a record for the Projects list to reopen them.
    work = tmp_path / "2026-08-26" / "my clip_ko_001"
    work.mkdir(parents=True)
    (work / "dubbed.mp4").write_bytes(b"x")
    store = JobStore(log_dir=str(tmp_path))
    store.restore(str(tmp_path))
    jobs = store.all()
    assert len(jobs) == 1
    assert jobs[0]["status"] == "done"
    assert jobs[0]["project"] == "my clip"
    assert jobs[0]["language_code"] == "ko"
    assert jobs[0]["day"] == "2026-08-26"
    assert store.get(jobs[0]["id"])["work_dir"] == str(work)
    # Restoring twice must not double the list.
    store.restore(str(tmp_path))
    assert len(store.all()) == 1


def test_all_lists_the_newest_job_first(tmp_path):
    store = JobStore(log_dir=str(tmp_path))
    old = store.create()
    store._update(old, created="2026-08-01T09:00:00")
    new = store.create()
    store._update(new, created="2026-08-26T09:00:00")
    assert [j["id"] for j in store.all()][:2] == [new, old]


def test_a_damaged_job_json_does_not_hide_a_finished_dub(tmp_path):
    # The file is written beside the video, so a machine switched off mid-write
    # could leave half of one. That folder must still reach Projects: the
    # rebuild-from-the-folder-name path is exactly the fallback for it, and a
    # broken file used to block it -- the finished dub then had no way back
    # inside the app at all.
    work = tmp_path / "2026-08-26" / "halfwritten_ko"
    work.mkdir(parents=True)
    (work / "dubbed.mp4").write_bytes(b"x")
    (work / "job.json").write_text('{"id": "abc", "status": "do', encoding="utf-8")
    store = JobStore(log_dir=str(tmp_path))
    store.restore(str(tmp_path))
    jobs = store.all()
    assert len(jobs) == 1
    assert jobs[0]["status"] == "done"
    assert jobs[0]["project"] == "halfwritten"


def test_persist_never_leaves_a_half_written_file(tmp_path):
    # Written to a scratch name and swapped in, so the file on disk is always
    # either the whole old record or the whole new one.
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="done", project="a")
    store.persist(jid, str(tmp_path / "x"))
    store.persist(jid, str(tmp_path / "x"))
    assert not (tmp_path / "x" / "job.json.tmp").exists()
    with open(str(tmp_path / "x" / "job.json"), encoding="utf-8") as f:
        assert json.load(f)["project"] == "a"


def test_the_jobs_list_keeps_the_file_paths_to_itself(tmp_path):
    # The sidebar names a job and addresses everything else by id, so there is
    # no reason to send the user's home directory out in every row.
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="done", work_dir=str(tmp_path / "x"),
                  result={"out_path": str(tmp_path / "x" / "dubbed.mp4")})
    row = store.all()[0]
    assert "work_dir" not in row and "result" not in row
    # The full record still has both -- the download endpoints read them.
    assert store.get(jid)["work_dir"] == str(tmp_path / "x")


# --- the language a job detected for itself ---------------------------------
# Auto-detect only ever said so inside the result, and the file kept just the
# out_path -- so a restart left the done screen with no source language to name.


def test_an_auto_detected_language_is_kept_on_the_job(tmp_path):
    work = tmp_path / "x"
    work.mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, work_dir=str(work))
    store.start(jid, lambda log: {"out_path": str(work / "dubbed.mp4"),
                                  "detected_source_language": "en"})
    j = _wait(store, jid)

    assert j["source_lang"] == "en"
    # The status flips just before the file is written, so give that write a
    # moment rather than racing it.
    for _ in range(100):
        if (work / "job.json").exists():
            break
        time.sleep(0.02)
    with open(str(work / "job.json"), encoding="utf-8") as f:
        saved = json.load(f)
    assert saved["source_lang"] == "en"
    assert saved["result"]["detected_source_language"] == "en"


def test_a_language_the_user_chose_is_not_overwritten(tmp_path):
    work = tmp_path / "x"
    work.mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, work_dir=str(work), source_lang="ja")
    store.start(jid, lambda log: {"out_path": str(work / "dubbed.mp4"),
                                  "detected_source_language": "en"})
    j = _wait(store, jid)

    assert j["source_lang"] == "ja"


def test_persist_does_not_bring_back_a_deleted_folder(tmp_path):
    # Deleting a job removes its folder; recreating it here would leave a row in
    # Projects pointing at a folder holding nothing but this file.
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="done")
    store.persist(jid, str(tmp_path / "gone"))
    assert not (tmp_path / "gone").exists()


def test_the_target_language_name_survives_a_restart(tmp_path):
    # run_dub is given the language's NAME, so a job that comes back from a
    # file and is run again has to still know it -- with only the code left,
    # "Korean" turned into "ko" in the translation prompt and in what the voice
    # sidecar was told to speak.
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="error", language="Korean", language_code="ko")
    store.persist(jid, str(tmp_path / "x"))

    store2 = JobStore(log_dir=str(tmp_path)); store2.restore(str(tmp_path))
    assert store2.get(jid)["language"] == "Korean"


def test_a_cut_still_owed_survives_a_restart(tmp_path):
    # A link job is cut after its download, inside the job thread. Quit the app
    # around that moment and the record has to say which side of the cut it is
    # on, or running it again cuts an already-cut video a second time.
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="error", trim={"start": 5, "end": 20}, trim_pending=True)
    store.persist(jid, str(tmp_path / "x"))

    store2 = JobStore(log_dir=str(tmp_path)); store2.restore(str(tmp_path))
    assert store2.get(jid)["trim"] == {"start": 5, "end": 20}
    assert store2.get(jid)["trim_pending"] is True


def test_separation_choice_survives_persist_and_shows_in_the_list(tmp_path):
    # The Separation chip and "Try again" both read this back after a restart;
    # a SAVED_FIELDS miss silently dropped it (found in live testing 2026-08-31).
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="done", project="a", separation="perso")
    store.persist(jid, str(tmp_path / "x"))
    store2 = JobStore(log_dir=str(tmp_path)); store2.restore(str(tmp_path))
    assert store2.get(jid)["separation"] == "perso"
    assert store2.all()[0]["separation"] == "perso"
