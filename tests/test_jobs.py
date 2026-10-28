import json
import logging
import re
import threading
import time

import pytest

from app.jobs import JobCancelled, JobStore, error_text_for_ui, kind_of, raise_if_cancelled, timed_step
from app.perso_client import PersoCreditExhaustedError


def _wait(store, jid):
    # Through queued as well as running: a job started while the one before
    # it is still on air waits in line first, and a slow runner (CI's Windows,
    # 2026-10-21) handed back "queued" where the test expected its ending.
    for _ in range(300):
        j = store.get(jid)
        if j and j["status"] not in ("running", "queued"):
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

    store = JobStore()  # created "too early", like state.job_store
    monkeypatch.setattr(jobs_module, "PERSODUB_LOG_DIR", str(tmp_path / "redir"))
    jid = store.create()
    store.append_log(jid, "redirected line")
    assert (tmp_path / "redir" / ("job-%s.log" % jid)).exists()


# Each line in the file is stamped like the app's own log (time - job - level),
# so a job log reads like an operations log; the list the screen parses keeps
# the bare line.
_STAMPED = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - job-(\w+) - (INFO|ERROR) - (.*)$")


def _file_text(tmp_path, jid):
    return (tmp_path / ("job-%s.log" % jid)).read_text(encoding="utf-8")


def test_a_file_line_is_stamped_and_the_screen_line_is_not(tmp_path):
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store.append_log(jid, "1/6 Separating background audio…")
    m = _STAMPED.match(_file_text(tmp_path, jid).splitlines()[0])
    assert m and m.groups() == (jid, "INFO", "1/6 Separating background audio…")
    assert store.get(jid)["logs"] == ["1/6 Separating background audio…"]


def test_an_error_line_is_written_at_error(tmp_path):
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store.append_log(jid, "Error: RuntimeError: No dialogue lines were found in this video.")
    store.append_log(jid, "   Error: Perso credits are used up. Recharge to continue.")
    store.append_log(jid, "   leakage gate: PASS (3 windows checked)")
    levels = [_STAMPED.match(line).group(2) for line in _file_text(tmp_path, jid).splitlines()]
    assert levels == ["ERROR", "ERROR", "INFO"]


def test_a_file_only_line_stays_off_the_screen(tmp_path):
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store.append_log(jid, "[Step 1/6] separate START", screen=False)
    assert store.get(jid)["logs"] == []
    assert _file_text(tmp_path, jid).endswith(" - INFO - [Step 1/6] separate START\n")


def test_a_job_writes_its_start_inputs_and_end_to_the_file_only(tmp_path, caplog):
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, language="Korean", language_code="ko", translator="gemma", quality=3,
                  project="my wedding", title="my wedding", work_dir=str(tmp_path / "x"),
                  source_url="https://example.com/watch?v=1")

    def work(log):
        log("1/6 Separating background audio…")
        log.trace("a structural line")
        return {"ok": True}

    with caplog.at_level(logging.INFO, logger="persodub.jobs"):
        store.start(jid, work)
        # The ending is written just after the status flips, and the app
        # log's copy of it last of all: wait for that, not for the status.
        for _ in range(100):
            if "job-%s: JOB ALL DONE (" % jid in caplog.text:
                break
            time.sleep(0.02)
    text = _file_text(tmp_path, jid)
    assert store.get(jid)["status"] == "done"
    assert store.get(jid)["logs"] == ["1/6 Separating background audio…"]
    assert " - INFO - JOB START (dub)\n" in text
    assert " - INFO - a structural line\n" in text
    assert re.search(r" - INFO - JOB ALL DONE \(\d+\.\ds\)$", text, re.M)
    inputs = json.loads(text.split(" - Inputs: ", 1)[1].splitlines()[0])
    assert inputs["language"] == "Korean" and inputs["translator"] == "gemma" and inputs["quality"] == 3
    # Nothing that names the video or says where it lives: the job's log goes
    # out with a failure report (docs/privacy.md).
    assert not {"id", "status", "project", "title", "work_dir", "source_url"} & set(inputs)
    assert "wedding" not in text and "example.com" not in text
    # The app log carries the same timeline.
    assert "job-%s: JOB START (dub)" % jid in caplog.text
    assert "job-%s: JOB ALL DONE (" % jid in caplog.text


def test_a_job_measures_its_memory_before_it_reads_done(monkeypatch):
    # Measuring takes a moment (psutil walks every process), and a job that
    # read "done" while it still measured held the one local seat: a dub
    # started that moment was queued behind it (the Linux and Windows
    # runners, 2026-10-18). Measured first, as a failure and a cancel are.
    from app import jobs as jobs_module

    store = JobStore()
    jid = store.create()
    seen = []
    monkeypatch.setattr(jobs_module, "_trace_memory", lambda trace: seen.append(store.get(jid)["status"]))
    store.start(jid, lambda log: {"ok": True})
    assert _wait(store, jid)["status"] == "done"
    assert seen == ["running", "running"]


def test_a_jobs_inputs_name_the_edition_it_ran_under_first(tmp_path, monkeypatch):
    # The edition decides where a dub runs when nothing is chosen (app/setup.py);
    # the desktop shell hands it over (desktop/src/orchestrator.js). A plain
    # server run has none, and runs as the open-source edition does.
    def inputs_under(edition):
        if edition is None:
            monkeypatch.delenv("PERSODUB_EDITION", raising=False)
        else:
            monkeypatch.setenv("PERSODUB_EDITION", edition)
        store = JobStore(log_dir=str(tmp_path))
        jid = store.create()
        store._update(jid, language="Korean", language_code="ko")
        store.start(jid, lambda log: {"ok": True})
        path = tmp_path / ("job-%s.log" % jid)
        for _ in range(100):
            if path.exists() and "JOB ALL DONE (" in path.read_text(encoding="utf-8"):
                break
            time.sleep(0.02)
        line = _file_text(tmp_path, jid).split(" - Inputs: ", 1)[1].splitlines()[0]
        return list(json.loads(line).items())

    assert inputs_under("production")[0] == ("edition", "production")
    assert inputs_under(None)[0] == ("edition", "opensource")


def test_a_failed_job_names_the_step_it_stopped_in(tmp_path, caplog, fixed_memory):
    store = JobStore(log_dir=str(tmp_path))

    def work(log):
        with timed_step(log, "2/6", "transcribe"):
            raise ValueError("no speech")

    with caplog.at_level(logging.INFO, logger="persodub.jobs"):
        jid = store.run_async(work)
        _wait(store, jid)
    # A traceback's own lines carry no stamp of their own, as in the app log.
    lines = [m.groups()[1:] for m in map(_STAMPED.match, _file_text(tmp_path, jid).splitlines()) if m]
    shapes = [(level, re.sub(r"\(\d+\.\ds\)", "(Ns)", msg)) for level, msg in lines]
    mem = ("INFO", "Mem[Host total 24576M avail 11376M | backend 310M]")
    assert shapes[-6:] == [
        ("ERROR", "[Step 2/6] transcribe FAILED (Ns): ValueError: no speech"),
        mem,
        ("ERROR", "Error: ValueError: no speech"),
        ("ERROR", "Traceback (most recent call last):"),
        mem,
        ("ERROR", "JOB FAILED at step 2/6 transcribe (Ns): ValueError: no speech"),
    ]
    assert store.get(jid)["logs"] == ["Error: ValueError: no speech"]
    assert any(r.levelname == "ERROR" and "JOB FAILED at step 2/6 transcribe" in r.getMessage()
               for r in caplog.records)


def test_a_failure_re_raised_as_a_sentence_still_names_its_step(tmp_path):
    # The cloud dub turns Perso's error into a sentence of its own
    # (app/dub_launch.py); the step is found on the error it came from.
    store = JobStore(log_dir=str(tmp_path))

    def work(log):
        try:
            with timed_step(log, "2/3", "perso-dubbing"):
                raise ConnectionError("peer closed connection")
        except ConnectionError as e:
            raise RuntimeError("Perso dubbing failed (peer closed connection).") from e

    jid = store.run_async(work)
    _wait(store, jid)
    assert "JOB FAILED at step 2/3 perso-dubbing (" in _file_text(tmp_path, jid)


def test_a_failure_between_steps_says_it_does_not_know_where(tmp_path):
    store = JobStore(log_dir=str(tmp_path))

    def work(log):
        raise RuntimeError("Not enough room on this computer.")

    jid = store.run_async(work)
    _wait(store, jid)
    assert "JOB FAILED at step ? (" in _file_text(tmp_path, jid)


def test_a_cancelled_job_says_so_in_its_file(tmp_path):
    store = JobStore(log_dir=str(tmp_path))

    def work(log):
        with timed_step(log, "4/6", "synthesize"):
            raise JobCancelled("cancelled by user")

    jid = store.run_async(work)
    j = _wait(store, jid)
    text = _file_text(tmp_path, jid)
    assert j["status"] == "cancelled"
    assert "[Step 4/6] synthesize CANCELLED (" in text and " - INFO - JOB CANCELLED (" in text


def test_a_job_that_ran_to_its_end_after_cancel_is_logged_as_cancelled(tmp_path):
    # Its result is dropped and its status says cancelled, so its file must too.
    store = JobStore(log_dir=str(tmp_path))
    started, release = threading.Event(), threading.Event()

    def work(log):
        started.set()
        release.wait(2)
        return {"ok": True}

    jid = store.run_async(work)
    started.wait(2)
    store.request_cancel(jid)
    release.set()
    for _ in range(100):  # the ending is written just after the status flips
        text = _file_text(tmp_path, jid)
        if "JOB CANCELLED (" in text:
            break
        time.sleep(0.02)
    assert store.get(jid)["status"] == "cancelled"
    assert "JOB CANCELLED (" in text and "JOB ALL DONE" not in text


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


def test_a_skipped_job_folder_is_logged_by_its_day_never_its_name(tmp_path, caplog):
    # The folder is named after the video's file, and persodub.log is sent with
    # a failure report, which docs/privacy.md says carries no filename.
    work = tmp_path / "2026-09-21" / "my wedding video_ko"
    work.mkdir(parents=True)
    (work / "job.json").write_text("{ not json", encoding="utf-8")
    with caplog.at_level("WARNING"):
        JobStore(log_dir=str(tmp_path)).restore(str(tmp_path))
    assert "wedding" not in caplog.text
    assert "Skipping a job folder under 2026-09-21" in caplog.text


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


def test_what_kind_of_job_it_is_survives_a_restart(tmp_path):
    # The boot re-arm has nothing but job.json to tell an erase from a dub, and
    # it starts them with different work.
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="queued", kind="erase", project="a",
                  area=[660, 800, 0, 608])
    store.persist(jid, str(tmp_path / "x"))
    store2 = JobStore(log_dir=str(tmp_path)); store2.restore(str(tmp_path))
    assert store2.get(jid)["kind"] == "erase"
    assert store2.get(jid)["area"] == [660, 800, 0, 608]
    assert store2.all()[0]["kind"] == "erase"


def test_a_job_that_says_nothing_about_its_kind_is_a_dub(tmp_path):
    # Every job this app made until subtitle erasing arrived, and every job a
    # dub makes now -- nothing writes "dub" onto a record.
    (tmp_path / "x").mkdir()
    store = JobStore(log_dir=str(tmp_path))
    jid = store.create()
    store._update(jid, status="done", project="a")
    store.persist(jid, str(tmp_path / "x"))
    store2 = JobStore(log_dir=str(tmp_path)); store2.restore(str(tmp_path))
    assert kind_of(store2.get(jid)) == "dub"
    assert store2.all()[0]["kind"] == "dub"


# --- what a failed job shows the user --------------------------------------
# A pipeline stage's RuntimeError carries a sentence written for the screen; an
# AttributeError from a corner nobody wrote a message for carries a fragment of
# Python. Only the first kind belongs under the red bar.

def test_error_text_keeps_a_message_written_for_the_user():
    assert error_text_for_ui(RuntimeError("No dialogue lines were found in this video.")) == \
        "No dialogue lines were found in this video."
    assert error_text_for_ui(PersoCreditExhaustedError("Perso credits are used up.")) == \
        "Perso credits are used up."
    assert error_text_for_ui(JobCancelled("cancelled by user")) == "cancelled by user"


def test_error_text_hides_an_unexpected_failure_behind_its_type():
    text = error_text_for_ui(AttributeError("'NoneType' object has no attribute 'x'"))
    assert text == "Unexpected error (AttributeError) - see the job log"
    assert "NoneType" not in text


def test_a_failed_job_writes_its_traceback_to_the_job_log():
    """The generic sentence above is only fair if the details are somewhere."""
    store = JobStore()

    def boom(log):
        raise AttributeError("'NoneType' object has no attribute 'x'")

    j = _wait(store, store.run_async(boom))
    assert j["error"] == "Unexpected error (AttributeError) - see the job log"
    assert any("Traceback (most recent call last)" in line for line in j["logs"])


def test_run_async_lifts_perso_credits_and_duration_onto_the_record():
    # What a dub spent on Perso and how long the video was travel in the
    # result, and land on the record before the status flips -- the shell
    # reads them off the job the moment it sees "done" -- and are saved with it.
    store = JobStore()
    jid = store.run_async(lambda log: {"ok": True, "perso_credits": 7, "duration": 150.2})
    j = _wait(store, jid)
    assert j["status"] == "done"
    assert j["perso_credits"] == 7
    assert j["duration"] == 150.2
    saved = JobStore._saved(j)
    assert saved["perso_credits"] == 7 and saved["duration"] == 150.2


def test_a_dubbing_perso_will_not_hand_over_ends_on_perso_with_what_it_spent(caplog):
    # A free-plan workspace's Perso API dubbing: made and paid for, no file
    # home. Its own ending, not "done" (no out_path to open) and not "error".
    store = JobStore()
    with caplog.at_level(logging.INFO, logger="persodub.jobs"):
        jid = store.run_async(lambda log: {"out_path": "/nowhere/dubbed.mp4", "on_perso": True,
                                           "perso_credits": 7, "duration": 150.2})
        j = _wait(store, jid)
        for _ in range(100):
            if "JOB DONE ON PERSO (" in caplog.text:
                break
            time.sleep(0.02)
    assert j["status"] == "on_perso"
    assert j["result"] is None and not j.get("error")
    assert j["perso_credits"] == 7 and j["duration"] == 150.2
    assert JobStore._saved(j)["status"] == "on_perso"
    assert "job-%s: JOB DONE ON PERSO (" % jid in caplog.text


def test_a_finished_or_failed_job_says_when_it_started_and_how_long_each_step_took():
    # Whole numbers for the usage count (desktop/src/analytics.js dubFacts),
    # on the record before the status flips; a step that did not run is not
    # named, and none of it is saved with the job.
    store = JobStore()

    def work(log):
        with timed_step(log, "1/6", "separate"):
            pass
        with timed_step(log, "2/6", "transcribe"):
            pass
        return {"ok": True}

    j = _wait(store, store.run_async(work))
    assert j["status"] == "done"
    assert j["stage_seconds"] == {"separate": 0, "transcribe": 0}
    assert j["elapsed_seconds"] == 0
    assert j["started_hour"] in range(24)
    assert "stage_seconds" not in JobStore._saved(j)

    def fails(log):
        with timed_step(log, "3/6", "translate"):
            raise RuntimeError("Translation failed.")

    j = _wait(store, store.run_async(fails))
    assert j["status"] == "error"
    assert j["stage_seconds"] == {"translate": 0}
    assert isinstance(j["elapsed_seconds"], int) and j["started_hour"] in range(24)


def test_run_async_leaves_the_record_alone_when_the_result_says_nothing():
    store = JobStore()
    jid = store.run_async(lambda log: {"ok": True, "perso_credits": None})
    j = _wait(store, jid)
    assert j["status"] == "done"
    assert "perso_credits" not in j and "duration" not in j


def test_a_restart_keeps_the_lines_that_were_cut_short(tmp_path):
    work = tmp_path / "day" / "clip_es"
    work.mkdir(parents=True)
    (work / "job.json").write_text(json.dumps({
        "id": "abc12345", "status": "done",
        "result": {"out_path": str(work / "dubbed.mp4")}}), encoding="utf-8")
    (work / "clipped_lines.json").write_text(json.dumps({
        "clipped": [{"line": 2, "cut_s": 0.901}], "clipped_count": 1}), encoding="utf-8")

    store = JobStore(log_dir=str(tmp_path))
    store.restore(str(tmp_path))

    result = store.get("abc12345")["result"]
    assert result["clipped"] == [{"line": 2, "cut_s": 0.901}]
    assert result["clipped_count"] == 1


def test_a_restart_without_a_cut_list_leaves_the_result_alone(tmp_path):
    work = tmp_path / "day" / "clip_es"
    work.mkdir(parents=True)
    (work / "job.json").write_text(json.dumps({
        "id": "abc12346", "status": "done",
        "result": {"out_path": str(work / "dubbed.mp4")}}), encoding="utf-8")

    store = JobStore(log_dir=str(tmp_path))
    store.restore(str(tmp_path))

    assert "clipped" not in store.get("abc12346")["result"]


# The screen's list of log lines lives in memory only, so a job loaded after a
# restart answered with no log at all although its job-<id>.log was on disk:
# the agent's get_job_status said "0 log lines" for a finished dub (Windows,
# 0.9.2).
def test_a_restarted_job_answers_with_the_lines_in_its_log_file(tmp_path):
    (tmp_path / "x").mkdir()
    logs = tmp_path / "logs"
    store = JobStore(log_dir=str(logs))
    jid = store.create()
    store.append_log(jid, "1/6 Separating background audio…")
    store.append_log(jid, "Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: boom\n")
    store.append_log(jid, "✅ Done!")
    store.update(jid, status="done", result={"out_path": str(tmp_path / "x" / "dubbed.mp4")})
    store.persist(jid, str(tmp_path / "x"))

    store2 = JobStore(log_dir=str(logs)); store2.restore(str(tmp_path))
    assert store2.get(jid)["logs"] == store.get(jid)["logs"]


def test_a_restarted_job_whose_log_cannot_be_read_still_comes_back(tmp_path):
    # A folder where the file should be, and a Windows file (CRLF) holding a
    # byte that is not UTF-8: the job loads either way.
    logs = tmp_path / "logs"
    (logs / "job-aaaa0001.log").mkdir(parents=True)
    (logs / "job-aaaa0002.log").write_bytes(
        b"2026-10-28 09:00:00,123 - job-aaaa0002 - INFO - caf\xe9 line\r\n"
        b"2026-10-28 09:00:01,456 - job-aaaa0002 - ERROR - Error: RuntimeError: x\r\n")
    for jid in ("aaaa0001", "aaaa0002"):
        (tmp_path / "day" / jid).mkdir(parents=True)
        (tmp_path / "day" / jid / "job.json").write_text(
            json.dumps({"id": jid, "status": "done"}), encoding="utf-8")

    store = JobStore(log_dir=str(logs))
    store.restore(str(tmp_path))

    assert store.get("aaaa0001")["logs"] == []
    assert store.get("aaaa0002")["logs"] == ["caf� line", "Error: RuntimeError: x"]


def test_a_restarted_job_keeps_only_the_end_of_a_long_log(tmp_path, monkeypatch):
    from app import jobs as jobs_module

    monkeypatch.setattr(jobs_module, "RESTORED_LOG_BYTES", 1000)
    (tmp_path / "x").mkdir()
    logs = tmp_path / "logs"
    store = JobStore(log_dir=str(logs))
    jid = store.create()
    for n in range(100):
        # Two lines each, so the cut lands inside a message as often as not.
        store.append_log(jid, "line %d\n  more %d" % (n, n))
    store.update(jid, status="done")
    store.persist(jid, str(tmp_path / "x"))

    store2 = JobStore(log_dir=str(logs)); store2.restore(str(tmp_path))
    kept = store2.get(jid)["logs"]
    assert 0 < len(kept) < 100
    # Whole messages from the end, never the back half of one cut in two.
    assert kept == store.get(jid)["logs"][-len(kept):]


def test_the_cancel_checkpoint_writes_its_line_and_stops_only_when_cancel_was_pressed():
    # One checkpoint for the stages, the voice lines and the pace-fit rounds:
    # the job log's line and the exception's text are what each wrote before.
    logs = []
    raise_if_cancelled(None, logs.append)
    raise_if_cancelled(lambda: False, logs.append)
    assert logs == []
    with pytest.raises(JobCancelled, match="^cancelled by user$"):
        raise_if_cancelled(lambda: True, logs.append)
    assert logs == ["Cancelled by user request"]
