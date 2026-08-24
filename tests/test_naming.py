# -*- coding: utf-8 -*-
"""Turning a video's title into a folder name. Pure string work, no filesystem."""
import unicodedata

from app.text.naming import next_free, safe_name


def test_keeps_a_plain_name_as_is():
    assert safe_name("참교육1화") == "참교육1화"
    assert safe_name("Breaking Bad S01E01") == "Breaking Bad S01E01"


def test_normalizes_korean_to_nfc():
    # macOS hands back decomposed Korean (NFD). Storing it that way makes the
    # folder unfindable later by a name built the normal (NFC) way.
    decomposed = unicodedata.normalize("NFD", "참교육")
    assert decomposed != "참교육"  # the two really are different strings
    assert safe_name(decomposed) == "참교육"


def test_strips_characters_a_path_cannot_hold():
    assert safe_name('a/b:c*d?e"f<g>h|i') == "abcdefghi"


def test_trims_leading_and_trailing_junk():
    assert safe_name("  . 참교육 . ") == "참교육"


def test_truncates_a_very_long_name():
    assert len(safe_name("가" * 300, max_len=80)) == 80


def test_falls_back_to_empty_when_nothing_survives():
    # The caller treats "" as "could not build a name" and uses a random one.
    assert safe_name("///") == ""
    assert safe_name("   ") == ""


def test_next_free_returns_the_base_when_nothing_taken():
    assert next_free("참교육1화_en", []) == "참교육1화_en"


def test_next_free_counts_up_from_001():
    assert next_free("참교육1화_en", ["참교육1화_en"]) == "참교육1화_en_001"


def test_next_free_skips_over_what_is_already_there():
    taken = ["참교육1화_en", "참교육1화_en_001", "참교육1화_en_002"]
    assert next_free("참교육1화_en", taken) == "참교육1화_en_003"


def test_next_free_gives_up_after_three_digits():
    # 999 of the same name on one day means something is wrong; fall back to
    # the caller's random-name path rather than growing a fourth digit.
    taken = ["x"] + ["x_%03d" % i for i in range(1, 1000)]
    assert next_free("x", taken) is None


def test_job_dir_uses_date_project_and_language(tmp_path, monkeypatch):
    from app import main

    monkeypatch.setattr(main, "WORKSPACE", str(tmp_path))
    monkeypatch.setattr(main, "_today", lambda: "2026-08-21")

    first = main._job_dir("참교육1화", "en")
    assert first.endswith("2026-08-21/참교육1화_en")
    assert main.os.path.isdir(first)

    # a second English run of the same title on the same day counts up
    assert main._job_dir("참교육1화", "en").endswith("2026-08-21/참교육1화_en_001")

    # a different language is a different folder, not a collision
    assert main._job_dir("참교육1화", "ja").endswith("2026-08-21/참교육1화_ja")


def test_job_dir_falls_back_to_a_random_name(tmp_path, monkeypatch):
    # A title that survives sanitizing as "" must not fail the job -- the old
    # random-name behaviour (app/main.py:374) is the safety net.
    from app import main

    monkeypatch.setattr(main, "WORKSPACE", str(tmp_path))
    monkeypatch.setattr(main, "_today", lambda: "2026-08-21")

    made = main._job_dir("///", "en")
    assert main.os.path.isdir(made)
    assert "2026-08-21" in made
    assert main.os.path.basename(made) not in ("_en", "")


def _finished_job(tmp_path, **extra):
    """A job record shaped like a finished dub, with its files on disk."""
    work = tmp_path / "job"
    work.mkdir()
    (work / "dubbed.mp4").write_bytes(b"vid")
    (work / "input.mp4").write_bytes(b"src")
    job = {"id": "abc123", "status": "done", "language_code": "en",
           "result": {"out_path": str(work / "dubbed.mp4")}}
    job.update(extra)
    return job


def test_download_names_are_short_and_say_the_language(tmp_path, monkeypatch):
    from app import main

    job = _finished_job(tmp_path, from_link=True)
    monkeypatch.setattr(main.job_store, "get", lambda jid: job)

    assert main.dub_result("abc123").filename == "dub_en.mp4"
    assert main.dub_result_original("abc123").filename == "org.mp4"


def test_original_is_refused_for_an_uploaded_file(tmp_path, monkeypatch):
    # The user already has the file they uploaded; only a link job has an
    # original they cannot otherwise get.
    import pytest
    from fastapi import HTTPException
    from app import main

    job = _finished_job(tmp_path, from_link=False)
    monkeypatch.setattr(main.job_store, "get", lambda jid: job)

    with pytest.raises(HTTPException) as e:
        main.dub_result_original("abc123")
    assert e.value.status_code == 404


def test_job_dir_cannot_be_walked_out_of_the_workspace(tmp_path, monkeypatch):
    """The language half of the folder name is caller-supplied and was pasted
    into the path unchecked, so "../../.." in it escaped the workspace and the
    job then wrote input.mp4 over whatever lived there. The title half was
    already run through safe_name; this is the half that was not.
    """
    from app import main

    monkeypatch.setattr(main, "WORKSPACE", str(tmp_path))
    monkeypatch.setattr(main, "_today", lambda: "2026-08-21")

    for hostile in ["../../../../tmp/PWNED", "..", "a/b", "a\\b", "ko\x00"]:
        work = main._job_dir("myvideo", hostile)
        real = main.os.path.realpath(work)
        root = main.os.path.realpath(str(tmp_path))
        assert real.startswith(root + main.os.sep), f"{hostile!r} escaped to {real}"
