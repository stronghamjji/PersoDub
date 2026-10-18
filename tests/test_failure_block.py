"""What a failed step leaves in the job's file (app/jobs.py timed_step): its
FAILED line names the error and what it says, and the lines under it say why
-- the errors it came from, the HTTP answer or the program output behind it
-- and where in app/ it broke. The traceback follows once: in the file only,
for a failure worded for the user."""
import re
import subprocess
import time
from types import SimpleNamespace

import httpx
import pytest

from app import pipeline
from app.jobs import JobStore, timed_step


def _traced_log():
    """A log shaped like JobStore's: the screen's lines, and the file-only ones."""
    def log(msg):
        log.screen.append(msg)

    log.screen, log.traced = [], []
    log.trace = lambda msg, level="INFO": log.traced.append((level, msg))
    return log


def _failed(raise_it, step="3/6", name="translate"):
    """The file-only lines of a step that fails with what raise_it() raises,
    without the memory lines and with the seconds as "Ns"."""
    log = _traced_log()
    with pytest.raises(Exception), timed_step(log, step, name):  # noqa: B017 -- any; the lines are under test
        raise_it()
    return [(level, re.sub(r"\(\d+\.\ds\)", "(Ns)", msg)) for level, msg in log.traced
            if not msg.startswith("Mem[")]


def test_a_failure_says_what_it_was_and_what_it_came_from():
    def raise_it():
        raise RuntimeError("x") from ValueError("y")

    assert _failed(raise_it)[2:] == [   # after the banner and START
        ("ERROR", "[Step 3/6] translate FAILED (Ns): RuntimeError: x"),
        ("ERROR", "  Caused by: ValueError: y"),
    ]


def test_a_long_message_is_one_line_cut_short():
    def raise_it():
        raise RuntimeError("first line\nsecond line " + "z" * 400)

    failed = _failed(raise_it)[2][1]
    said = failed.split("RuntimeError: ", 1)[1]
    assert said.startswith("first line second line zzz") and len(said) == 300


def test_an_http_failure_names_its_answer_without_the_query_string():
    request = httpx.Request("GET", "https://api.example.com/v1/jobs/7?fileName=input.mp4")
    response = httpx.Response(503, text="busy", request=request)

    def raise_it():
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RuntimeError("Perso's server is temporarily unavailable.") from e

    lines = _failed(raise_it, "2/6", "transcribe")
    assert ("ERROR", "  HTTP 503 GET https://api.example.com/v1/jobs/7: busy") in lines
    assert lines[3][1].startswith("  Caused by: HTTPStatusError: Server error '503 Service Unavailable'")


def test_a_signed_link_keeps_its_address_but_never_its_query():
    # Perso's upload goes to a storage link whose query is a signed token.
    def raise_it():
        raise RuntimeError("upload refused for url 'https://x.blob/y?sig=abc&se=1' (403)") from \
            ConnectionError("PUT https://x.blob/y?sig=abc failed")

    lines = _failed(raise_it, "1/3", "upload")
    assert lines[2][1].endswith("): RuntimeError: upload refused for url 'https://x.blob/y?…' (403)")
    assert lines[3] == ("ERROR", "  Caused by: ConnectionError: PUT https://x.blob/y?… failed")
    assert not any("sig=abc" in msg for _level, msg in lines)


def test_a_program_that_failed_leaves_its_last_twenty_lines():
    said = "".join(f"line {i}\n" for i in range(1, 26)).encode()

    def raise_it():
        raise subprocess.CalledProcessError(1, ["ffprobe", "input.mp4"], output=b"", stderr=said)

    lines = [msg for _level, msg in _failed(raise_it, "6/6", "build")]
    at = lines.index("  Output:")
    assert lines[at + 1:] == [f"    line {i}" for i in range(6, 26)]

    def prints_only_to_stdout():
        raise subprocess.CalledProcessError(2, "tool", output="it said this\n")

    assert _failed(prints_only_to_stdout)[-2:] == [("ERROR", "  Output:"), ("ERROR", "    it said this")]


def test_the_at_lines_name_where_in_app_it_broke(monkeypatch, tmp_path):
    # ffmpeg could not put the sound on the picture: app/pipeline.py says so.
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 1.0)
    monkeypatch.setattr(pipeline, "_mux", lambda *a: SimpleNamespace(returncode=1, stderr="Conversion failed!"))
    log = _traced_log()
    with pytest.raises(RuntimeError, match="Could not build the finished video"), \
            pipeline._timed_stage(log, "build"):
        pipeline._stage_finish(str(tmp_path / "input.mp4"), str(tmp_path / "mix.wav"),
                               str(tmp_path / "dubbed.mp4"), str(tmp_path), log)
    at = [msg for _level, msg in log.traced if msg.startswith("  At: ")]
    assert re.fullmatch(r"  At: app/pipeline\.py:\d+ in _stage_finish", at[0])


def test_a_step_says_what_it_was_given_under_its_start():
    log = _traced_log()
    with timed_step(log, "3/6", "translate", translate_engine="gemma", lines=12, target="English",
                    source="ko", srt_given=False, num_speakers=None):
        pass
    assert [msg for _level, msg in log.traced if not msg.startswith("Mem[")][1:3] == [
        "[Step 3/6] translate START",
        "[Step 3/6] translate Context: translate_engine=gemma lines=12 target=English source=ko srt_given=False",
    ]


def test_describing_a_failure_never_becomes_the_failure():
    class Odd(Exception):
        @property
        def response(self):
            raise KeyError("nothing here")

    def raise_it():
        raise Odd("the real failure")

    log = _traced_log()
    with pytest.raises(Odd, match="the real failure"), timed_step(log, "1/6", "separate"):
        raise_it()
    assert any(msg.endswith("s): Odd: the real failure") for _level, msg in log.traced)


def _job(tmp_path, work):
    """A job run to its end: its record, and its file."""
    store = JobStore(log_dir=str(tmp_path))
    jid = store.run_async(work)
    for _ in range(100):
        if store.get(jid)["status"] != "running":
            break
        time.sleep(0.02)
    return store.get(jid), (tmp_path / ("job-%s.log" % jid)).read_text(encoding="utf-8")


def test_a_failure_worded_for_the_user_keeps_its_traceback_off_the_screen(tmp_path):
    def work(log):
        raise RuntimeError("No dialogue lines were found in this video.")

    job, text = _job(tmp_path, work)
    assert text.count("Traceback (most recent call last):") == 1
    assert " - ERROR - Traceback (most recent call last):\n" in text
    assert job["logs"] == ["Error: RuntimeError: No dialogue lines were found in this video."]


def test_a_signed_link_in_a_cause_never_reaches_the_job_file(tmp_path):
    # The traceback quotes the cause too, so it is cut the same way.
    def work(log):
        with timed_step(log, "1/3", "upload"):
            try:
                raise ConnectionError("PUT https://x.blob/y?sig=abc failed")
            except ConnectionError as e:
                raise RuntimeError("Perso dubbing failed (connection reset).") from e

    _job_record, text = _job(tmp_path, work)
    assert "https://x.blob/y?…" in text
    assert "sig=abc" not in text


def test_a_bug_keeps_its_traceback_on_the_screen_and_once_in_the_file(tmp_path):
    def work(log):
        raise AttributeError("'NoneType' object has no attribute 'x'")

    job, text = _job(tmp_path, work)
    assert text.count("Traceback (most recent call last):") == 1
    assert " - ERROR - Traceback (most recent call last):\n" in text
    assert any(line.startswith("Traceback (most recent call last):") for line in job["logs"])


def test_an_os_error_names_its_errno_code_in_english():
    # Windows words a refused connection in the computer's language; the
    # errno name does not change with it.
    import errno as _errno

    from app.jobs import _described

    e = ConnectionRefusedError(_errno.ECONNREFUSED, "대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다")
    line = _described(e)
    assert line.startswith("ConnectionRefusedError: ")
    assert line.endswith("[ECONNREFUSED]")


def test_a_windows_socket_error_reads_as_macos_and_linux_name_it(monkeypatch):
    # Windows' own table names 10061 WSAECONNREFUSED; the same refusal is
    # ECONNREFUSED on macOS and Linux, and a report should read the same from
    # all three (the Windows runner, 2026-10-18).
    import errno as _errno

    from app.jobs import _described

    monkeypatch.setitem(_errno.errorcode, 10061, "WSAECONNREFUSED")
    assert _described(ConnectionRefusedError(10061, "refused")).endswith("[ECONNREFUSED]")
