"""Result downloads: original.mp4 / dubbed_<lang>.mp4 / dubbed_<lang>.srt,
the sound alone in four formats, and what an audio project hands back (the
sound it is, and nothing that needs a picture)."""
import json
import os
import pathlib
import time

import pytest
from fastapi.testclient import TestClient

from app import engines_status, i18n, media, state
from app.api import dub as dub_api
from app.main import app
from tests.marks import needs_ffmpeg


@pytest.fixture(autouse=True)
def _models_ready(monkeypatch):
    # Model files live in a kit these tests never build -- the 409
    # preflight is exercised in tests/test_dub_start_preflight.py.
    from app.api import _launch as launch_api
    monkeypatch.setattr(launch_api, "missing_models", lambda *a, **kw: [])

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _all_engines_available(monkeypatch):
    for name in ("gemma_available", "qwen_available", "gemini_available", "perso_available"):
        monkeypatch.setattr(engines_status, name, lambda: True)
    monkeypatch.setattr(engines_status, "gemma_status", lambda: "available")
    monkeypatch.setattr(engines_status, "hunyuan_status", lambda: "available")
    monkeypatch.setattr(engines_status, "qwen_status", lambda: "available")


def _finished_job(monkeypatch, target="en", upload=("v.mp4", b"FAKEMP4", "video/mp4")):
    """Start a real upload job whose pipeline is faked, and wait for it."""
    def fake_run_dub(**kw):
        work = os.path.dirname(kw["out_path"])
        with open(kw["out_path"], "wb") as f:
            f.write(b"FAKEDUB")
        with open(os.path.join(work, "translated.srt"), "w", encoding="utf-8") as f:
            f.write("1\n00:00:00,000 --> 00:00:01,000\nhello\n")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1,
                "auto_translated": True}

    monkeypatch.setattr(dub_api, "run_dub", fake_run_dub)
    r = client.post("/api/dub/start",
                    data={"language_code": target},
                    files={"video": upload})
    jid = r.json()["job_id"]
    deadline = time.time() + 5
    while time.time() < deadline:
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] == "done":
            return jid
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_dub_download_is_named_for_the_target_language(monkeypatch):
    jid = _finished_job(monkeypatch, target="ko")
    r = client.get(f"/api/dub/result/{jid}")
    assert r.status_code == 200
    assert 'filename="dub_ko.mp4"' in r.headers["content-disposition"]


def test_original_is_downloadable_for_a_link_job(monkeypatch):
    # _finished_job posts an uploaded file; stamping from_link makes the job
    # look like one that pulled its video from a URL, which is the only case
    # where the original is handed back.
    # state.job_store, not `from app.state import job_store`: the store is a
    # module attribute other tests reassign, and a name bound at import time
    # would keep pointing at whichever object existed then.
    jid = _finished_job(monkeypatch)
    state.job_store._update(jid, from_link=True)

    r = client.get(f"/api/dub/result/{jid}/original")
    assert r.status_code == 200
    assert r.content == b"FAKEMP4"
    assert 'filename="org.mp4"' in r.headers["content-disposition"]

    # The URL the Download original button actually points at, so the gate
    # cannot be inverted without a test noticing.
    d = client.get(f"/api/dub/result/{jid}/original?download=1")
    assert d.status_code == 200
    assert d.content == b"FAKEMP4"


def test_original_download_is_refused_for_an_uploaded_file(monkeypatch):
    # The screens play an uploaded original freely (the running screen blurs it
    # behind the progress card), but the Download original button stays link-
    # only: the user already has the file they uploaded.
    jid = _finished_job(monkeypatch)
    assert client.get(f"/api/dub/result/{jid}/original").status_code == 200
    assert client.get(f"/api/dub/result/{jid}/original?download=1").status_code == 404


def test_original_404s_when_the_job_is_unknown():
    assert client.get("/api/dub/result/nope/original").status_code == 404


def test_srt_download_has_a_filename(monkeypatch):
    jid = _finished_job(monkeypatch, target="ja")
    r = client.get(f"/api/dub/result/{jid}/srt?download=1")
    assert r.status_code == 200
    assert 'filename="dub_ja.srt"' in r.headers["content-disposition"]


def test_srt_viewer_response_is_unchanged(monkeypatch):
    # The in-app subtitle viewer fetches this without ?download -- it must keep
    # returning plain text with no attachment header.
    jid = _finished_job(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/srt")
    assert r.status_code == 200
    assert "content-disposition" not in {k.lower() for k in r.headers}
    assert "hello" in r.text


# --- Audio only: the dub's sound as mp3 or wav ------------------------------

def _fake_ffmpeg(monkeypatch):
    from app import media
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        with open(cmd[-1], "wb") as f:
            f.write(b"SOUND")
        class R:
            returncode = 0
            stderr = ""
        return R()
    monkeypatch.setattr(media.subprocess, "run", fake_run)
    return calls


def test_audio_only_is_the_dubs_sound_named_for_the_language(monkeypatch):
    jid = _finished_job(monkeypatch, target="ko")
    calls = _fake_ffmpeg(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/audio?format=mp3&download=1")
    assert r.status_code == 200 and r.content == b"SOUND"
    assert 'filename="dub_ko.mp3"' in r.headers["content-disposition"]
    assert calls[-1][calls[-1].index("-c:a") + 1] == "libmp3lame"
    # Built once: the second ask is served from the job's folder.
    client.get(f"/api/dub/result/{jid}/audio?format=mp3&download=1")
    assert len(calls) == 1
    r = client.get(f"/api/dub/result/{jid}/audio?format=wav&download=1")
    assert 'filename="dub_ko.wav"' in r.headers["content-disposition"]
    assert calls[-1][calls[-1].index("-c:a") + 1] == "pcm_s16le"


def test_audio_only_is_made_again_after_the_video_is(monkeypatch):
    jid = _finished_job(monkeypatch)
    calls = _fake_ffmpeg(monkeypatch)
    client.get(f"/api/dub/result/{jid}/audio")
    out = state.job_store.get(jid)["result"]["out_path"]
    later = time.time() + 60
    os.utime(out, (later, later))
    client.get(f"/api/dub/result/{jid}/audio")
    assert len(calls) == 2


def test_audio_only_refuses_another_format_and_an_unknown_job(monkeypatch):
    jid = _finished_job(monkeypatch)
    assert client.get(f"/api/dub/result/{jid}/audio?format=ogg").status_code == 422
    assert client.get("/api/dub/result/nope/audio").status_code == 404


# --- the four formats a sound is saved as: MP3, WAV, FLAC, M4A ---------------

FOUR = [("mp3", "audio/mpeg", "libmp3lame"), ("wav", "audio/wav", "pcm_s16le"),
        ("flac", "audio/flac", "flac"), ("m4a", "audio/mp4", "aac")]
SOUND_FORMATS = "Audio is saved as MP3, WAV, FLAC or M4A."


@pytest.mark.parametrize("fmt,mime,codec", FOUR)
def test_the_dubs_sound_goes_out_in_each_of_the_four_formats(monkeypatch, fmt, mime, codec):
    jid = _finished_job(monkeypatch, target="ko")
    calls = _fake_ffmpeg(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/audio?format={fmt}&download=1")
    assert r.status_code == 200 and r.content == b"SOUND"
    assert r.headers["content-type"] == mime
    assert f'filename="dub_ko.{fmt}"' in r.headers["content-disposition"]
    assert calls[-1][calls[-1].index("-c:a") + 1] == codec
    assert calls[-1][-1].endswith("dub-audio." + fmt)


@pytest.mark.parametrize("fmt,mime,codec", FOUR)
def test_voice_and_background_go_out_in_each_of_the_four_formats(monkeypatch, fmt, mime, codec):
    jid = _finished_job(monkeypatch)
    job = state.job_store.get(jid)
    for name in ("vocals.wav", "background.wav"):
        with open(os.path.join(job["work_dir"], name), "wb") as f:
            f.write(b"STEM")
    calls = _fake_ffmpeg(monkeypatch)
    for which in ("voice", "background"):
        r = client.get(f"/api/dub/result/{jid}/stem/{which}?format={fmt}")
        assert r.status_code == 200 and r.content == b"SOUND"
        assert r.headers["content-type"] == mime
        assert f'{job["project"]}_{which}.{fmt}' in r.headers["content-disposition"]
        assert calls[-1][calls[-1].index("-c:a") + 1] == codec


def test_a_format_that_is_not_one_of_the_four_is_refused_with_all_four_named(monkeypatch):
    jid = _finished_job(monkeypatch)
    for url in (f"/api/dub/result/{jid}/audio?format=ogg", f"/api/dub/result/{jid}/stem/voice?format=ogg"):
        r = client.get(url)
        assert r.status_code == 422 and r.json()["detail"] == SOUND_FORMATS
    monkeypatch.setattr(i18n, "_language", "ko")
    r = client.get(f"/api/dub/result/{jid}/audio?format=ogg")
    assert r.json()["detail"] == "오디오는 MP3, WAV, FLAC, M4A로 저장돼요."


def test_the_sentence_about_sound_formats_names_every_format_wherever_it_is_said():
    # One sentence, said by four routes: this file's two, a held file's save
    # (app/api/downloads.py) and an erased video's (app/api/erase.py). It
    # names what media.AUDIO_CODECS takes, in both languages, and the
    # sentence from when there were two formats is said nowhere.
    root = pathlib.Path(__file__).resolve().parent.parent / "app"
    tables = {code: json.loads((root / "i18n" / f"app.{code}.json").read_text(encoding="utf-8"))
              for code in ("en", "ko")}
    for code, table in tables.items():
        assert all(fmt.upper() in table[SOUND_FORMATS] for fmt in media.AUDIO_CODECS), code
        assert "Audio is saved as mp3 or wav." not in table, code
    # Korean app copy says what happens ("~돼요"); it does not tell the user what to do.
    assert tables["ko"][SOUND_FORMATS].endswith("돼요.")
    for name in ("results.py", "downloads.py", "erase.py"):
        assert f't("{SOUND_FORMATS}")' in (root / "api" / name).read_text(encoding="utf-8"), name
    assert not [p.name for p in root.rglob("*.py") if not p.name.startswith("._")
                and 't("Audio is saved as mp3 or wav.")' in p.read_text(encoding="utf-8")]


# --- an audio project: the sound it is, and nothing that needs a picture -----

VIDEO_ONLY = "Only for projects with a video."


def _audio_job(monkeypatch, fmt="mp3", target="en"):
    """A finished dubbing of an audio file. ffprobe is replaced, as in
    tests/test_audio_intake.py: the file is sound with no picture, in `fmt`."""
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    monkeypatch.setattr(media, "audio_format", lambda path: fmt)
    jid = _finished_job(monkeypatch, target=target, upload=("talk." + fmt, b"THESONG", "audio/mpeg"))
    job = state.job_store.get(jid)
    assert job["media"] == "audio" and job["result"]["out_path"].endswith("dubbed.wav")
    return jid


def test_an_audio_projects_result_is_served_as_the_sound_it_is(monkeypatch):
    jid = _audio_job(monkeypatch, target="ko")
    for url in (f"/api/dub/result/{jid}", f"/api/dub/result/{jid}?ratio=original"):
        r = client.get(url)
        assert r.status_code == 200 and r.content == b"FAKEDUB"
        assert r.headers["content-type"] == "audio/wav"
        assert 'filename="dub_ko.wav"' in r.headers["content-disposition"]


def test_an_audio_project_has_no_picture_to_put_in_a_canvas(monkeypatch):
    jid = _audio_job(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}?ratio=9:16")
    assert r.status_code == 409 and r.json()["detail"] == VIDEO_ONLY
    # A shape the menu does not offer is refused as it is for a video.
    assert client.get(f"/api/dub/result/{jid}?ratio=7:3").status_code == 422


@pytest.mark.parametrize("fmt", ["wav", "flac", "mp3", "m4a"])
def test_an_audio_projects_original_is_served_as_the_sound_it_is(monkeypatch, fmt):
    # input.mp4 keeps its name whatever it holds (the user's bytes, or FLAC
    # after a cut), so the type comes from the file and not from the name.
    jid = _audio_job(monkeypatch, fmt=fmt)
    r = client.get(f"/api/dub/result/{jid}/original")
    assert r.status_code == 200 and r.content == b"THESONG"
    assert r.headers["content-type"] == media.AUDIO_MIME[fmt]
    assert f'filename="org.{fmt}"' in r.headers["content-disposition"]


@pytest.mark.parametrize("route", ["subtitled", "subtitled?preset=clean&download=1", "subtitle_preview"])
def test_an_audio_project_has_no_video_to_lay_subtitles_on(monkeypatch, route):
    jid = _audio_job(monkeypatch)
    calls = _fake_ffmpeg(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/{route}")
    assert r.status_code == 409 and r.json()["detail"] == VIDEO_ONLY
    assert calls == []
    monkeypatch.setattr(i18n, "_language", "ko")
    assert client.get(f"/api/dub/result/{jid}/{route}").json()["detail"] == "영상이 있는 프로젝트에서만 쓸 수 있어요."


def test_an_audio_project_keeps_its_subtitles_file_and_its_subtitle_style(monkeypatch):
    # The subtitles on screen and the .srt stay (they need no picture).
    jid = _audio_job(monkeypatch, target="ja")
    r = client.get(f"/api/dub/result/{jid}/srt?download=1")
    assert r.status_code == 200 and 'filename="dub_ja.srt"' in r.headers["content-disposition"]
    assert client.get(f"/api/dub/jobs/{jid}/subtitle_style").status_code == 200


@pytest.mark.parametrize("fmt,mime,codec", FOUR)
def test_an_audio_projects_dubbed_sound_downloads_in_each_of_the_four_formats(monkeypatch, fmt, mime, codec):
    jid = _audio_job(monkeypatch, target="ko")
    calls = _fake_ffmpeg(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/audio?format={fmt}&download=1")
    assert r.status_code == 200 and r.headers["content-type"] == mime
    assert f'filename="dub_ko.{fmt}"' in r.headers["content-disposition"]
    # Made from the project's result, which is the dubbed sound itself.
    assert calls[-1][calls[-1].index("-i") + 1].endswith("dubbed.wav")
    assert calls[-1][calls[-1].index("-c:a") + 1] == codec


def test_a_video_project_is_served_as_it_always_was(monkeypatch):
    # No file of a video project is asked what it is: nothing here probes.
    def never(path):
        raise AssertionError("a video project's file was probed")
    monkeypatch.setattr(media, "audio_format", never)
    jid = _finished_job(monkeypatch, target="ko")
    r = client.get(f"/api/dub/result/{jid}")
    assert r.status_code == 200 and r.content == b"FAKEDUB"
    assert r.headers["content-type"] == "video/mp4"
    assert 'filename="dub_ko.mp4"' in r.headers["content-disposition"]
    r = client.get(f"/api/dub/result/{jid}/original")
    assert r.status_code == 200 and r.content == b"FAKEMP4"
    assert r.headers["content-type"] == "video/mp4"
    assert 'filename="org.mp4"' in r.headers["content-disposition"]


# ---- the original's voice and background, out of the job's folder ----

def _with_stems(jid, *names):
    """A second of real silence under each name the separation stage writes."""
    import subprocess
    work = state.job_store.get(jid)["work_dir"]
    for name in names:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                        "anullsrc=r=48000:cl=stereo", "-t", "1", os.path.join(work, name)],
                       check=True)
    return work


@needs_ffmpeg
def test_voice_and_background_go_out_as_mp3_or_wav_named_for_the_project(monkeypatch):
    jid = _finished_job(monkeypatch)
    work = _with_stems(jid, "vocals.wav", "background.wav")
    project = state.job_store.get(jid)["project"]
    assert client.get(f"/api/dub/result/{jid}/stems").json() == {"voice": True, "background": True}
    for which in ("voice", "background"):
        r = client.get(f"/api/dub/result/{jid}/stem/{which}?format=mp3")
        assert r.status_code == 200
        assert r.headers["content-type"] == "audio/mpeg"
        assert f"{project}_{which}.mp3" in r.headers["content-disposition"]
        assert os.path.exists(os.path.join(work, f"stem-{which}.mp3"))
        r = client.get(f"/api/dub/result/{jid}/stem/{which}?format=wav")
        assert r.status_code == 200
        assert r.headers["content-type"] == "audio/wav"
        assert r.content[:4] == b"RIFF"
        assert f"{project}_{which}.wav" in r.headers["content-disposition"]


@needs_ffmpeg
def test_a_missing_stem_is_404_and_the_list_says_which_is_there(monkeypatch):
    jid = _finished_job(monkeypatch)
    _with_stems(jid, "background.wav")
    assert client.get(f"/api/dub/result/{jid}/stems").json() == {"voice": False, "background": True}
    assert client.get(f"/api/dub/result/{jid}/stem/voice").status_code == 404
    assert client.get(f"/api/dub/result/{jid}/stem/background").status_code == 200
    assert client.get(f"/api/dub/result/{jid}/stem/drums").status_code == 404
    assert client.get(f"/api/dub/result/{jid}/stem/background?format=ogg").status_code == 422
    assert client.get("/api/dub/result/nope/stem/voice").status_code == 404
    assert client.get("/api/dub/result/nope/stems").status_code == 404


@needs_ffmpeg
def test_stems_are_refused_for_a_job_that_is_not_a_dubbing(monkeypatch):
    jid = _finished_job(monkeypatch)
    _with_stems(jid, "vocals.wav", "background.wav")
    state.job_store._update(jid, kind="erase")
    assert client.get(f"/api/dub/result/{jid}/stems").status_code == 409
    assert client.get(f"/api/dub/result/{jid}/stem/voice").status_code == 409
