# -*- coding: utf-8 -*-
"""Dropping a finished job's intermediate audio. Files only, no pipeline run."""
from app.pipeline import cleanup_intermediates

KEEP = ["dubbed.mp4", "input.mp4", "original.srt", "translated.srt",
        "edited.srt", "sub.srt", "nonverbal_manifest.json"]
DROP = ["vocals.wav", "background.wav", "qwen_dub_48k.wav",
        "qwen_line_0.wav", "qwen_line_12.wav", "qwen_ref_Barack_Obama.wav"]


def _populate(tmp_path):
    for name in KEEP + DROP:
        (tmp_path / name).write_bytes(b"x")


def test_drops_intermediate_audio_and_keeps_the_results(tmp_path):
    _populate(tmp_path)

    removed = cleanup_intermediates(str(tmp_path))

    assert removed == len(DROP)
    for name in KEEP:
        assert (tmp_path / name).exists(), "%s should have been kept" % name
    for name in DROP:
        assert not (tmp_path / name).exists(), "%s should have been dropped" % name


def test_is_safe_to_run_twice(tmp_path):
    _populate(tmp_path)
    cleanup_intermediates(str(tmp_path))
    assert cleanup_intermediates(str(tmp_path)) == 0


def test_survives_a_folder_that_is_not_there(tmp_path):
    assert cleanup_intermediates(str(tmp_path / "gone")) == 0


def test_delete_workspace_removes_the_folder(tmp_path, monkeypatch):
    from app import main

    work = tmp_path / "job"
    work.mkdir()
    (work / "dubbed.mp4").write_bytes(b"vid")
    monkeypatch.setattr(main, "WORKSPACE", str(tmp_path))
    monkeypatch.setattr(main.job_store, "get", lambda jid: {
        "id": jid, "status": "done", "result": {"out_path": str(work / "dubbed.mp4")}})

    assert main.dub_job_delete_workspace("abc")["deleted"] is True
    assert not work.exists()


def test_delete_workspace_refuses_a_path_outside_it(tmp_path, monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app import main

    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "dubbed.mp4").write_bytes(b"vid")
    monkeypatch.setattr(main, "WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setattr(main.job_store, "get", lambda jid: {
        "id": jid, "status": "done", "result": {"out_path": str(outside / "dubbed.mp4")}})

    with pytest.raises(HTTPException) as e:
        main.dub_job_delete_workspace("abc")
    assert e.value.status_code == 400
    assert outside.exists()


def test_delete_workspace_refuses_while_the_job_runs(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app import main

    monkeypatch.setattr(main.job_store, "get", lambda jid: {"id": jid, "status": "running"})
    with pytest.raises(HTTPException) as e:
        main.dub_job_delete_workspace("abc")
    assert e.value.status_code == 409


def test_delete_workspace_clears_a_job_that_never_produced_a_video(tmp_path, monkeypatch):
    # Projects lists failed jobs too, and a job that died in the first stage has
    # no out_path -- only work_dir. Without that fallback its row could never be
    # cleared away.
    from app import main

    work = tmp_path / "job"
    work.mkdir()
    (work / "input.mp4").write_bytes(b"vid")
    monkeypatch.setattr(main, "WORKSPACE", str(tmp_path))
    monkeypatch.setattr(main.job_store, "get", lambda jid: {
        "id": jid, "status": "error", "work_dir": str(work), "result": None})

    assert main.dub_job_delete_workspace("abc")["deleted"] is True
    assert not work.exists()


def test_delete_workspace_forgets_the_job(tmp_path, monkeypatch):
    # The folder is gone, so its job.json is gone -- but the in-memory record
    # would keep drawing the row until the next restart.
    from app import main

    work = tmp_path / "job"
    work.mkdir()
    (work / "dubbed.mp4").write_bytes(b"vid")
    monkeypatch.setattr(main, "WORKSPACE", str(tmp_path))
    jid = main.job_store.create()
    main.job_store._update(jid, status="done", work_dir=str(work),
                           result={"out_path": str(work / "dubbed.mp4")})

    main.dub_job_delete_workspace(jid)
    assert main.job_store.get(jid) is None
