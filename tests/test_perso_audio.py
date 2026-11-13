"""A file that is sound with no picture, sent through Perso (app/perso_client.py).

Perso takes such a file at an address of its own, makes a project of it that
is not a video, and hands the finished dubbing back as sound. What is sent
mirrors the official plugin (perso-dubbing 0.5.0, skills/dubbing/lib/
api_adapter.mjs: upload/audio, isVideoProject false, the download target
voiceWithBackgroundAudio). None of it had been seen live when these were
written, and no test here reaches Perso: httpx is replaced, the way
tests/test_perso.py replaces it.

A video goes exactly as it went before audio was taken. The last tests here
hold every request a video makes, word for word and in order.
"""
import json
import os
from types import SimpleNamespace

import pytest

from app import dub_launch, media, perso_materialize, state
from app import perso_client as pcm
from app.perso_client import PersoClient

API = "https://api.perso.ai"
VT = API + "/video-translator/api/v1"
BLOB = "https://blob.example.com/x?sig=abc"
MEDIA = "https://media.example.com"
SCRIPT = [{"order": 1, "text_original": "hi", "words": [[{"start": 0.0, "end": 1.0}]]}]


class _Answer:
    status_code = 200

    def __init__(self, body=None, content=b""):
        self._body = body
        self.content = content

    def json(self):
        return self._body

    def raise_for_status(self):
        pass


class Perso:
    """Perso's side of one upload and one project (888, in workspace 999),
    and every request made of it, in order."""

    def __init__(self):
        self.sent = []
        self.info = {"hasTranslatedVideo": True, "hasTranslatedVoice": True, "hasTranslateAudio": True}
        self.links = {
            "dubbingVideo": {"videoFile": {"videoDownloadLink": "/perso-storage/dubbed_en.mp4"}},
            "voiceWithBackgroundAudio": {"audioFile": {
                "voiceWithBackgroundAudioDownloadLink": "/perso-storage/dubbed_en.mp3"}},
            "scriptTimestamps": {"audioFile": {"scriptTimestampsDownloadLink": "/perso-storage/script.json"}},
        }

    def get(self, url, params=None, headers=None, timeout=None):
        self.sent.append({"verb": "GET", "url": url, "params": params, "headers": headers})
        project = VT + "/projects/888/spaces/999"
        if url == API + "/file/api/upload/sas-token":
            return _Answer({"blobSasUrl": BLOB})
        if url == VT + "/projects/888/space/999/progress":
            return _Answer({"result": {"progressReason": "Completed"}})
        if url == project + "/download-info":
            return _Answer({"result": self.info})
        if url == project + "/download":
            return _Answer({"result": self.links[params["target"]]})
        if url == project:
            return _Answer({"downloadPathInfo": {"originalVoicePath": "/perso-storage/voice.wav",
                                                 "originalBackgroundPath": "/perso-storage/bed.wav"}})
        if url == MEDIA + "/perso-storage/script.json":
            return _Answer(SCRIPT)
        if url.startswith(MEDIA):
            return _Answer({}, content=b"FROM " + url.rsplit("/", 1)[-1].encode())
        raise AssertionError(f"unexpected GET {url}")

    def put(self, url, content=None, json=None, headers=None, timeout=None):
        self.sent.append({"verb": "PUT", "url": url, "json": json, "content": content, "headers": headers})
        if url == BLOB:
            return _Answer({})
        if url in (API + "/file/api/upload/video", API + "/file/api/upload/audio"):
            return _Answer({"seq": 555})
        raise AssertionError(f"unexpected PUT {url}")

    def post(self, url, json=None, headers=None, timeout=None):
        self.sent.append({"verb": "POST", "url": url, "json": json, "headers": headers})
        return _Answer({"result": {"startGenerateProjectIdList": [888]}})


@pytest.fixture
def perso(monkeypatch):
    side = Perso()
    monkeypatch.setattr(pcm, "MEDIA_HOST", MEDIA)
    monkeypatch.setattr(pcm.time, "sleep", lambda s: None)
    for verb in ("get", "put", "post"):
        monkeypatch.setattr(pcm.httpx, verb, getattr(side, verb))
    return side


@pytest.fixture
def folder(tmp_path):
    """A job's folder, with the file every job keeps its input in."""
    work = tmp_path / "job"
    work.mkdir()
    (work / "input.mp4").write_bytes(b"fake-bytes")
    return work


@pytest.fixture
def sound(monkeypatch, folder):
    """The job's input is sound with no picture, a WAV until the test says
    otherwise (`source`); what Perso hands back is an MP3 (`result`). The
    conversion to WAV is stood in for, and what it was asked is kept."""
    probe = SimpleNamespace(path=str(folder / "input.mp4"), source="wav", result="mp3", converted=[])
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    monkeypatch.setattr(media, "audio_format",
                        lambda path: probe.source if path == probe.path else probe.result)

    def to_wav(src, dest):
        probe.converted.append((os.path.basename(src), os.path.basename(dest)))
        with open(src, "rb") as f, open(dest, "wb") as out:
            out.write(b"WAV OF " + f.read())

    monkeypatch.setattr(perso_materialize, "_ffmpeg_to_wav", to_wav)
    return probe


def _client():
    return PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)


def _wire(sent):
    """Each request as one line: the verb, the address, and what went with it,
    the body as the JSON text it is sent as, so the order of its fields counts."""
    lines = []
    for s in sent:
        line = "%s %s" % (s["verb"], s["url"])
        if s.get("params"):
            line += " ?" + json.dumps(s["params"])
        if s.get("json") is not None:
            line += " " + json.dumps(s["json"])
        if s.get("content") is not None:
            line += " <%d bytes>" % len(s["content"])
        lines.append(line)
    return lines


# ── The upload ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("fmt", ["wav", "flac", "mp3", "m4a"])
def test_an_audio_file_is_registered_as_audio_under_a_name_that_says_its_format(perso, sound, fmt):
    """A job's file is input.mp4 whatever it holds. Perso is told the format
    the file really is, in the token it issues and in the registration."""
    sound.source = fmt
    assert _client()._upload_media(sound.path, 999) == 555
    token, blob, register = perso.sent
    assert token["params"] == {"fileName": "input." + fmt}
    # The user's bytes, untouched.
    assert blob["url"] == BLOB and blob["content"] == b"fake-bytes"
    assert (register["verb"], register["url"]) == ("PUT", API + "/file/api/upload/audio")
    assert register["json"] == {"spaceSeq": 999, "fileUrl": "https://blob.example.com/x",
                                "fileName": "input." + fmt}


def test_sound_in_a_container_that_is_none_of_the_four_keeps_its_own_name(perso, sound, folder):
    # The subtitles tool is handed a file by its path, under its own name.
    talk = folder / "talk.ogg"
    talk.write_bytes(b"OggS")
    sound.result = None    # what audio_format says of any file but the job's input
    _client()._upload_media(str(talk), 999)
    token, _blob, register = perso.sent
    assert token["params"] == {"fileName": "talk.ogg"}
    assert register["url"] == API + "/file/api/upload/audio" and register["json"]["fileName"] == "talk.ogg"


# ── The project ────────────────────────────────────────────────────────────

MAKES = [
    ("dub", lambda c, path, work: c.dub_video(path, os.path.join(work, "dubbed.wav"), "ko", "en"), "/translate"),
    ("separate", lambda c, path, work: c.separate(path, work), "/audio-separation"),
    ("transcribe", lambda c, path, work: c.transcribe(path), "/stt"),
]


@pytest.mark.parametrize("_name,make,tail", MAKES, ids=[m[0] for m in MAKES])
def test_the_project_made_of_an_audio_file_is_not_a_video(perso, sound, folder, _name, make, tail):
    make(_client(), sound.path, str(folder))
    [post] = [s for s in perso.sent if s["verb"] == "POST"]
    assert post["url"] == VT + "/projects/spaces/999" + tail
    assert post["json"]["mediaSeq"] == 555 and post["json"]["isVideoProject"] is False
    registered = [s["url"] for s in perso.sent if s["verb"] == "PUT" and s["url"] != BLOB]
    assert registered == [API + "/file/api/upload/audio"]


# ── The finished dubbing ───────────────────────────────────────────────────

def test_an_audio_dubbing_comes_home_as_the_voice_with_its_background(perso, sound, folder):
    out = folder / "dubbed.wav"
    assert _client().download_dub(888, str(out), audio=True) == str(out)
    assert _wire(perso.sent) == [
        "GET " + VT + "/projects/888/spaces/999/download-info",
        "GET " + VT + '/projects/888/spaces/999/download ?{"target": "voiceWithBackgroundAudio"}',
        "GET " + MEDIA + "/perso-storage/dubbed_en.mp3",
    ]
    # The storage link never sees the key.
    assert "XP-API-KEY" not in perso.sent[-1]["headers"]
    # What came was not a WAV, so it is made one: the job's result is dubbed.wav.
    assert out.read_bytes() == b"WAV OF FROM dubbed_en.mp3"
    assert len(sound.converted) == 1
    assert sorted(os.listdir(folder)) == ["dubbed.wav", "input.mp4"]


def test_a_download_that_is_already_a_wav_is_kept_as_it_came(perso, sound, folder):
    sound.result = "wav"
    out = folder / "dubbed.wav"
    _client().download_dub(888, str(out), audio=True)
    assert out.read_bytes() == b"FROM dubbed_en.mp3" and sound.converted == []
    assert sorted(os.listdir(folder)) == ["dubbed.wav", "input.mp4"]


def test_the_link_under_another_name_is_found_the_way_the_plugin_finds_it(perso, sound, folder):
    perso.links["voiceWithBackgroundAudio"] = {"audioFile": {"mixedDownloadLink": "/perso-storage/mix.mp3"}}
    out = folder / "dubbed.wav"
    _client().download_dub(888, str(out), audio=True)
    assert out.read_bytes() == b"WAV OF FROM mix.mp3"


def test_an_answer_with_no_link_says_so_and_writes_nothing(perso, sound, folder):
    perso.links["voiceWithBackgroundAudio"] = {"audioFile": {}}
    with pytest.raises(RuntimeError, match="no download link"):
        _client().download_dub(888, str(folder / "dubbed.wav"), audio=True)
    assert sorted(os.listdir(folder)) == ["input.mp4"]


@pytest.mark.parametrize("info,ready", [
    ({"hasTranslatedVoice": False, "hasTranslateAudio": False}, False),
    ({"hasTranslatedVoice": True, "hasTranslateAudio": False}, True),
    ({"hasTranslatedVoice": False, "hasTranslateAudio": True}, True),
    ({}, True),
    # An audio project has no video to be ready: that flag is not the gate.
    ({"hasTranslatedVideo": False, "hasTranslatedVoice": True}, True),
])
def test_the_audio_is_not_asked_for_until_perso_says_it_is_there(perso, sound, folder, info, ready):
    """The plugin's gate: not ready only when both of the flags say so."""
    perso.info = info
    out = folder / "dubbed.wav"
    if ready:
        _client().download_dub(888, str(out), audio=True)
        assert out.exists()
        return
    with pytest.raises(RuntimeError, match="the audio is not ready to download"):
        _client().download_dub(888, str(out), audio=True)
    assert [s["url"].rsplit("/", 1)[-1] for s in perso.sent] == ["download-info"]
    assert not out.exists()


def test_a_download_that_cannot_be_made_a_wav_leaves_the_result_there_whole(perso, sound, folder, monkeypatch):
    """After edits the result is fetched again, over the one on disk."""
    out = folder / "dubbed.wav"
    out.write_bytes(b"the dubbing as it was")

    def broken(src, dest):
        with open(dest, "wb") as f:
            f.write(b"half")
        raise RuntimeError("could not convert")

    monkeypatch.setattr(perso_materialize, "_ffmpeg_to_wav", broken)
    with pytest.raises(RuntimeError, match="could not convert"):
        _client().download_dub(888, str(out), audio=True)
    assert out.read_bytes() == b"the dubbing as it was"
    assert sorted(os.listdir(folder)) == ["dubbed.wav", "input.mp4"]


def test_an_audio_dubbing_from_the_upload_to_the_file(perso, sound, folder):
    sound.source = "flac"
    out = folder / "dubbed.wav"
    screen = []

    def log(msg):
        screen.append(msg)

    log.trace = lambda msg, level="INFO": None
    assert _client().dub_video(sound.path, str(out), "ko", "en", num_speakers=2, log=log,
                               title="Talk") == str(out)
    assert _wire(perso.sent) == [
        "GET " + API + '/file/api/upload/sas-token ?{"fileName": "input.flac"}',
        "PUT " + BLOB + " <10 bytes>",
        "PUT " + API + '/file/api/upload/audio {"spaceSeq": 999, "fileUrl": "https://blob.example.com/x",'
                       ' "fileName": "input.flac"}',
        "POST " + VT + '/projects/spaces/999/translate {"mediaSeq": 555, "isVideoProject": false,'
                       ' "sourceLanguageCode": "ko", "targetLanguages": [{"languageCode": "en",'
                       ' "ttsModel": "LINNET_4"}], "numberOfSpeakers": 2, "preferredSpeedType": "GREEN",'
                       ' "title": "Talk"}',
        "GET " + VT + "/projects/888/space/999/progress",
        "GET " + VT + "/projects/888/spaces/999/download-info",
        "GET " + VT + '/projects/888/spaces/999/download ?{"target": "voiceWithBackgroundAudio"}',
        "GET " + MEDIA + "/perso-storage/dubbed_en.mp3",
    ]
    assert out.read_bytes() == b"WAV OF FROM dubbed_en.mp3"
    # The three lines the running screen reads its progress from
    # (app/stages.py, ui/src/dubApi.mjs) are a video's, word for word.
    assert screen == ["   Uploading the video to Perso…", "   Perso is dubbing… this takes a few minutes.",
                      "   Downloading the finished video…"]
    # Lip-sync is a thing of pictures: nothing asked of Perso names it.
    assert "lip" not in json.dumps(_wire(perso.sent)).lower()


def test_an_audio_job_sent_to_perso_ends_as_dubbed_wav(perso, sound, folder, monkeypatch):
    """The job's own path (app/dub_launch.py): its record says audio, its
    result is named dubbed.wav, and that file is the sound Perso made."""
    monkeypatch.setenv("PERSO_API_KEY", "dummy-key")
    monkeypatch.setenv("PERSO_SPACE_SEQ", "999")
    jid = state.job_store.create()
    job = {"id": jid, "work_dir": str(folder), "dub_mode": "perso", "media": "audio",
           "language_code": "en", "source_lang": "ko", "project": "Talk"}
    result = dub_launch.work_for(job, cancel_check=lambda: False, on_notice=lambda n: None)(lambda m: None)
    assert result["out_path"] == str(folder / "dubbed.wav")
    assert (folder / "dubbed.wav").read_bytes() == b"WAV OF FROM dubbed_en.mp3"
    assert not (folder / "dubbed.mp4").exists()
    assert state.job_store.get(jid)["perso_project_seq"] == 888


# ── A video goes as it always went ─────────────────────────────────────────
# Every request of each of the three calls, as it was before audio was taken:
# the names, the addresses, the bodies with their fields in order.

VIDEO_UPLOAD = [
    "GET " + API + '/file/api/upload/sas-token ?{"fileName": "input.mp4"}',
    "PUT " + BLOB + " <10 bytes>",
    "PUT " + API + '/file/api/upload/video {"spaceSeq": 999, "fileUrl": "https://blob.example.com/x",'
                   ' "fileName": "input.mp4"}',
]


def _headers_as_before(perso, client):
    for s in perso.sent:
        if s["url"].startswith(API):
            assert s["headers"] == client._headers
        elif s["url"] == BLOB:
            assert s["headers"] == {"x-ms-blob-type": "BlockBlob", "Content-Type": "application/octet-stream"}
        else:
            assert s["headers"] == {"User-Agent": pcm.USER_AGENT, "X-Perso-Client-Host": pcm.CLIENT_HOST}


def test_a_video_dubbing_sends_what_it_always_sent(perso, folder, monkeypatch):
    monkeypatch.setattr(perso_materialize, "_ffmpeg_to_wav", lambda *a: pytest.fail("a video is not converted"))
    monkeypatch.setattr(media, "audio_format", lambda path: pytest.fail("a video's format is not asked"))
    out = folder / "dubbed.mp4"
    client = _client()
    client.dub_video(str(folder / "input.mp4"), str(out), "ko", "en", num_speakers=2, title="Paris",
                     target_tag="en-GB")
    assert _wire(perso.sent) == VIDEO_UPLOAD + [
        "POST " + VT + '/projects/spaces/999/translate {"mediaSeq": 555, "isVideoProject": true,'
                       ' "sourceLanguageCode": "ko", "targetLanguages": [{"languageCode": "en",'
                       ' "ttsModel": "LINNET_4", "languageTag": "en-GB"}], "numberOfSpeakers": 2,'
                       ' "preferredSpeedType": "GREEN", "title": "Paris"}',
        "GET " + VT + "/projects/888/space/999/progress",
        "GET " + VT + "/projects/888/spaces/999/download-info",
        "GET " + VT + '/projects/888/spaces/999/download ?{"target": "dubbingVideo"}',
        "GET " + MEDIA + "/perso-storage/dubbed_en.mp4",
    ]
    _headers_as_before(perso, client)
    # The file is the bytes Perso served, under the name it was asked to have.
    assert out.read_bytes() == b"FROM dubbed_en.mp4"
    assert sorted(os.listdir(folder)) == ["dubbed.mp4", "input.mp4"]


def test_a_video_separation_sends_what_it_always_sent(perso, folder):
    client = _client()
    client.separate(str(folder / "input.mp4"), str(folder), title="Paris")
    assert _wire(perso.sent) == VIDEO_UPLOAD + [
        "POST " + VT + '/projects/spaces/999/audio-separation {"mediaSeq": 555, "isVideoProject": true,'
                       ' "title": "Paris"}',
        "GET " + VT + "/projects/888/space/999/progress",
        "GET " + VT + "/projects/888/spaces/999",
        "GET " + MEDIA + "/perso-storage/voice.wav",
        "GET " + MEDIA + "/perso-storage/bed.wav",
    ]
    _headers_as_before(perso, client)


def test_a_video_transcription_sends_what_it_always_sent(perso, folder):
    client = _client()
    assert client.transcribe(str(folder / "input.mp4")) == SCRIPT
    assert _wire(perso.sent) == VIDEO_UPLOAD + [
        "POST " + VT + '/projects/spaces/999/stt {"mediaSeq": 555, "isVideoProject": true}',
        "GET " + VT + "/projects/888/space/999/progress",
        "GET " + VT + '/projects/888/spaces/999/download ?{"target": "scriptTimestamps"}',
        "GET " + MEDIA + "/perso-storage/script.json",
    ]
    _headers_as_before(perso, client)


def test_a_finished_video_is_fetched_the_way_it_always_was(perso, folder):
    """What brings the result home again after edits (app/perso_edit.py)."""
    out = folder / "dubbed.mp4.perso-new"
    _client().download_dub(888, str(out), 999)
    assert _wire(perso.sent) == [
        "GET " + VT + "/projects/888/spaces/999/download-info",
        "GET " + VT + '/projects/888/spaces/999/download ?{"target": "dubbingVideo"}',
        "GET " + MEDIA + "/perso-storage/dubbed_en.mp4",
    ]
    assert out.read_bytes() == b"FROM dubbed_en.mp4"
