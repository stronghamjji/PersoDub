"""The memory line in a job's log (app/memline.py): the computer, the backend
and the two pack processes the desktop shell names in runtime.json, each with
every process it started, in MiB. psutil is faked (conftest.py fixed_memory)
so the figures are the same on every machine."""
import json
import logging
import re
import sys
import time

from app.jobs import JobStore, timed_step
from app.memline import mem_line

MEM = "Mem[Host total 24576M avail 11376M | backend 310M]"


def _kit_naming(tmp_path, monkeypatch, **pids):
    """A kit whose runtime.json names the given pids beside the URLs."""
    (tmp_path / "runtime.json").write_text(json.dumps(
        {"version": 1, "tts_url": "http://127.0.0.1:5001", "ollama_url": "http://127.0.0.1:5002", **pids}),
        encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))


def test_the_line_names_both_packs_the_shell_started(tmp_path, monkeypatch, fixed_memory):
    fixed_memory.mib.update({4101: 8200, 4102: 1200})
    _kit_naming(tmp_path, monkeypatch, tts_pid=4101, ollama_pid=4102)
    assert mem_line() == "Mem[Host total 24576M avail 11376M | backend 310M | engine 8200M | ollama-runtime 1200M]"


def test_without_runtime_json_only_the_computer_and_the_backend(tmp_path, monkeypatch, fixed_memory):
    assert mem_line() == MEM                                   # no kit at all
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(tmp_path))      # a kit, no runtime.json yet
    assert mem_line() == MEM


def test_each_process_counts_with_everything_it_started(tmp_path, monkeypatch, fixed_memory):
    # Where the memory really is: the backend's Whisper worker, the engine
    # under the uvicorn launcher (and a helper it started in turn), Ollama's
    # two model runners.
    fixed_memory.mib.update({5001: 2000,                    # this process's Whisper worker
                             4101: 12, 4201: 8000, 4202: 188,
                             4102: 40, 4301: 700, 4302: 460})
    fixed_memory.kids.update({None: [5001], 4101: [4201], 4201: [4202], 4102: [4301, 4302]})
    _kit_naming(tmp_path, monkeypatch, tts_pid=4101, ollama_pid=4102)
    assert mem_line() == "Mem[Host total 24576M avail 11376M | backend 2310M | engine 8200M | ollama-runtime 1200M]"


def test_a_child_that_ends_mid_walk_is_skipped(tmp_path, monkeypatch, fixed_memory):
    fixed_memory.mib.update({4102: 40, 4301: 1160})
    fixed_memory.kids[4102] = [4301, 4302]                     # 4302 ended after it was listed
    _kit_naming(tmp_path, monkeypatch, ollama_pid=4102)
    assert mem_line() == "Mem[Host total 24576M avail 11376M | backend 310M | ollama-runtime 1200M]"


def test_a_pack_that_has_ended_is_left_out(tmp_path, monkeypatch, fixed_memory):
    fixed_memory.mib.update({4102: 1200})                      # 4101 is gone
    _kit_naming(tmp_path, monkeypatch, tts_pid=4101, ollama_pid=4102)
    assert mem_line() == "Mem[Host total 24576M avail 11376M | backend 310M | ollama-runtime 1200M]"


def test_without_psutil_there_is_no_line_and_the_job_still_finishes(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "psutil", None)          # `import psutil` now fails
    assert mem_line() is None
    store = JobStore(log_dir=str(tmp_path))

    def work(log):
        with timed_step(log, "1/6", "separate"):
            log("1/6 Separating background audio…")
        return {"ok": True}

    jid = store.run_async(work)
    path = tmp_path / ("job-%s.log" % jid)
    for _ in range(100):   # the ending is written just after the status flips
        if path.exists() and "JOB ALL DONE (" in path.read_text(encoding="utf-8"):
            break
        time.sleep(0.02)
    text = path.read_text(encoding="utf-8")
    assert store.get(jid)["status"] == "done"
    assert "[Step 1/6] separate DONE (" in text and "JOB ALL DONE (" in text
    assert "Mem[" not in text


def test_the_lines_go_to_the_file_and_the_app_log_never_the_screen(tmp_path, caplog, fixed_memory):
    store = JobStore(log_dir=str(tmp_path))

    def work(log):
        with timed_step(log, "1/6", "separate"):
            log("1/6 Separating background audio…")
        return {"ok": True}

    with caplog.at_level(logging.INFO, logger="persodub.jobs"):
        jid = store.run_async(work)
        for _ in range(100):   # the app log's copy of the ending comes last
            if "job-%s: JOB ALL DONE (" % jid in caplog.text:
                break
            time.sleep(0.02)
    text = (tmp_path / ("job-%s.log" % jid)).read_text(encoding="utf-8")
    msgs = [re.sub(r"\(\d+\.\ds\)", "(Ns)", line.split(" - ", 3)[3]) for line in text.splitlines()]
    assert msgs[1].startswith("Inputs: ")   # what it holds: tests/test_jobs.py
    assert msgs[:1] + msgs[2:] == [
        "JOB START (dub)", MEM,
        "#" * 30, "[Step 1/6] separate START", MEM,
        "1/6 Separating background audio…",
        "[Step 1/6] separate DONE (Ns)", MEM,
        MEM, "JOB ALL DONE (Ns)",
    ]
    assert " - INFO - %s" % MEM in text
    assert caplog.text.count("job-%s: %s" % (jid, MEM)) == 4
    assert store.get(jid)["logs"] == ["1/6 Separating background audio…"]
