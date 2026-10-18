"""Shared test fixtures.

The suite had no conftest.py at all -- monkeypatching module globals inside each
test was the only isolation mechanism. That left one gap nothing covered: tests
which exercise the upload endpoint write a real job directory into the repo's
own workspace/ and never clean it up (one run of tests/test_dub_api.py leaves 10
behind). By 2026-08-02 that had accumulated 559 litter directories against 4
genuine jobs.
"""
import logging
import sys
import time
from types import SimpleNamespace

import pytest

from app import codex_fetch, i18n, jobs, logging_setup, room, state


@pytest.fixture(autouse=True)
def isolate_job_logs(tmp_path, monkeypatch):
    """Point the log files at a temp directory.

    app/jobs.py mirrors every progress line to PERSODUB_LOG_DIR/job-<id>.log.
    Without this, any test that starts a job drops a log file into the working
    tree -- the same silent, cumulative litter isolate_workspace exists to stop.

    app/logging_setup.py writes the app's own persodub.log into the same
    folder, and a test that enters the lifespan (which is what installs that
    handler) would otherwise start it in the working tree too.

    Tearing the handlers down again is the other half. configure_logging is
    idempotent -- it returns early when the logger already has handlers -- and
    "persodub" is one process-wide logger, so the first test to enter the
    lifespan would otherwise nail the file handler to ITS tmp_path for the
    whole session and every later redirect here would be a no-op. Removing
    them (closing the file ones, so no descriptor leaks over a thousand tests)
    puts the logger back the way this fixture found it.
    """
    monkeypatch.setattr(jobs, "PERSODUB_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setattr(logging_setup, "PERSODUB_LOG_DIR", str(tmp_path / "logs"))
    yield
    logger = logging.getLogger(logging_setup.LOGGER_NAME)
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        if isinstance(handler, logging.FileHandler):
            handler.close()


@pytest.fixture(autouse=True)
def jobs_end_inside_their_test(monkeypatch):
    """A job a test started is over before the next test begins.

    The job store is one for the whole session and a job runs on its own
    thread, so a test that stopped looking once it had its answer left that
    thread running into the next test: there it called that test's fakes and
    held the one local seat that test's job needed. The memory lines
    (app/memline.py) made every job a little slower, and the Linux and
    Windows runners failed 24 and 2 tests this way (2026-10-18). This waits
    before monkeypatch undoes the test's fakes -- it asks for monkeypatch, so
    it is torn down first -- and for five seconds at most.
    """
    yield
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and (state.job_store._active or state.job_store._pending):
        time.sleep(0.01)


@pytest.fixture(autouse=True)
def english_engine(monkeypatch):
    """Every test hears the engine in English, whatever the machine running it
    says (PERSODUB_LOCALE, a kit.env's PERSODUB_LANG): the tests compare its
    sentences with the English in the code. app/i18n.py keeps the language it
    decided on, so a test that switches it must not leave it switched.
    tests/test_i18n.py un-pins it where the deciding is what is tested."""
    monkeypatch.setattr(i18n, "_language", "en")


@pytest.fixture(autouse=True)
def no_codex_prefetch(monkeypatch):
    """A test that enters the lifespan must not fetch 130 MB from npm."""
    monkeypatch.setattr(codex_fetch, "prefetch", lambda: None)


@pytest.fixture(autouse=True)
def isolate_workspace(tmp_path, monkeypatch):
    """Point the upload workspace at a per-test temp directory.

    app/main.py resolves WORKSPACE from __file__ at import time, so without this
    every TestClient upload lands in the working tree and stays there. Autouse
    because the cost of forgetting it is silent and cumulative -- a test that
    pollutes still passes.
    """
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr(state, "WORKSPACE", str(ws))


@pytest.fixture(autouse=True)
def chatgpt_signed_in(monkeypatch):
    """ChatGPT is the default translator (2026-09-23), and a dub start asks
    the sign-in program whether it is signed in. No test may run that program
    on the machine it happens to be on: the answer is "yes" unless a test
    says otherwise. tests/test_chatgpt_translator.py keeps the real check."""
    from app import engines_status
    monkeypatch.setattr(engines_status, "chatgpt_available", lambda: True)


@pytest.fixture(autouse=True)
def dub_on_this_computer(monkeypatch):
    """Dubbing goes to Perso by default in the production edition (app/setup.py),
    which a dub start without a key refuses. The tests that start one watch the
    local path unless they choose a mode themselves, whatever edition the
    machine running them names; tests/test_setup_api.py tests the default
    itself and clears this."""
    monkeypatch.setenv("DUB_MODE", "local")


@pytest.fixture(autouse=True)
def plenty_of_memory(monkeypatch):
    """Every test runs on a 24 GB computer unless it says otherwise.

    app/room.py refuses a local dub under 7 GB and warns under 12, and a CI
    runner's own memory (7 GB on macOS) would otherwise decide whether a test
    about something else is refused or warned. Tests about memory set theirs.
    """
    monkeypatch.setattr(room, "total_ram_bytes", lambda: 24 * room.GB)


@pytest.fixture(autouse=True)
def no_line_check(monkeypatch):
    """Fast mode hears every Qwen line back with Whisper (app/qwen_pipeline
    _check_fast_lines). No test may start Whisper on the machine it runs on:
    the check is skipped unless a test puts its own transcriber in."""
    from app import qwen_pipeline
    monkeypatch.setattr(qwen_pipeline, "transcribe_batch", lambda paths, language=None, timeout=None: None)
    # ...nor CAM++ for the voice check beside it: no reference voice is
    # compared unless a test puts its own embedder in.
    def no_embedder(paths):
        raise RuntimeError("no CAM++ in tests")
    monkeypatch.setattr(qwen_pipeline, "_embed_files", no_embedder)


@pytest.fixture
def fixed_memory(monkeypatch):
    """psutil with fixed figures for the memory lines in a job's log
    (app/memline.py), the same on every machine, psutil installed or not:
    the computer has 24576M with 11376M available and this process (pid
    None) holds 310M and has started nothing. A test adds processes to .mib
    (pid -> MiB) and who started whom to .kids (pid -> child pids); a pid
    with no figure reads as gone. No kit: runtime.json names no process
    unless the test makes one."""
    mib, kids = {None: 310}, {}

    class Process:
        def __init__(self, pid=None):
            self.pid = pid

        def memory_info(self):
            if self.pid not in mib:
                raise ProcessLookupError(self.pid)   # psutil.NoSuchProcess, near enough
            return SimpleNamespace(rss=mib[self.pid] * 1024 * 1024)

        def children(self, recursive=False):
            found = [Process(pid) for pid in kids.get(self.pid, ())]
            if recursive:
                found += [grandchild for child in found for grandchild in child.children(recursive=True)]
            return found

    monkeypatch.setitem(sys.modules, "psutil", SimpleNamespace(
        virtual_memory=lambda: SimpleNamespace(total=24576 * 1024 * 1024, available=11376 * 1024 * 1024),
        Process=Process))
    monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
    return SimpleNamespace(mib=mib, kids=kids)


@pytest.fixture
def wav_factory():
    """Write a silent 48kHz stereo PCM16 wav of the given length, return its path."""
    import wave

    def make(path, seconds=1.0, rate=48000):
        with wave.open(str(path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(b"\x00\x00\x00\x00" * int(seconds * rate))
        return str(path)

    return make


@pytest.fixture
def after_a_restart(monkeypatch):
    """after_a_restart(start) -> the id start() returned, once the dub it
    started has waited out an app restart in the line.

    The test gets a job store of its own first, so no other test's job can
    take the one local seat, and the job left waiting goes with that store
    instead of being started by a later test. start() runs while another
    dubbing holds the seat, so its dub is queued and its job.json says so.
    Then the app closes and opens again: a new store read back from the
    job.json files in the workspace, and the boot re-arm."""
    from app.api import dub as dub_api
    monkeypatch.setattr(state, "job_store", jobs.JobStore())

    def run(start):
        # A job the test ran first hands the seat on a moment after "done".
        for _ in range(250):
            if state.job_store._active is None:
                break
            time.sleep(0.02)
        state.job_store._active = "ffffffff"   # another dubbing, on air
        jid = start()
        assert state.job_store.get(jid)["status"] == "queued"
        reopened = jobs.JobStore()
        reopened.restore(state.WORKSPACE)
        monkeypatch.setattr(state, "job_store", reopened)
        dub_api.rearm_queued_jobs()
        return jid

    return run
