"""What a file is to the app (app/media.py media_kind and audio_format), and
the length of one that has no picture.

ffprobe is replaced with its own answers, written out, so these run where
there is no ffprobe; the last tests ask the real one about tiny files made
with ffmpeg.
"""
import json
import subprocess

import pytest

from app import media
from tests.marks import needs_ffmpeg

# The real probe, kept before tests/conftest.py's every_file_is_a_video
# replaces it for each test.
media_kind = media.media_kind

MP4 = "mov,mp4,m4a,3gp,3g2,mj2"
PICTURE = {"codec_type": "video", "disposition": {"attached_pic": 0}}
SOUND = {"codec_type": "audio", "disposition": {"attached_pic": 0}}
COVER = {"codec_type": "video", "disposition": {"attached_pic": 1}}


def _ffprobe_says(monkeypatch, streams=None, format_name=None, stdout=None):
    """ffprobe answering with these streams (or this text). Returns its calls."""
    calls = []
    if stdout is None:
        stdout = json.dumps({"streams": streams or [],
                             **({"format": {"format_name": format_name}} if format_name else {})})

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_a_file_with_a_picture_is_a_video(monkeypatch):
    calls = _ffprobe_says(monkeypatch, [PICTURE, SOUND])
    assert media_kind("/v/in.mp4") == "video"
    assert calls[0][0] == "ffprobe" and calls[0][-1] == "/v/in.mp4"
    # A video with no sound is still a video.
    _ffprobe_says(monkeypatch, [PICTURE])
    assert media_kind("/v/in.mp4") == "video"


def test_a_file_with_sound_only_is_audio(monkeypatch):
    _ffprobe_says(monkeypatch, [SOUND])
    assert media_kind("/v/in.wav") == "audio"


def test_an_mp3_with_an_album_cover_is_audio(monkeypatch):
    # The cover is a video stream to ffprobe; it does not make the song a video.
    _ffprobe_says(monkeypatch, [SOUND, COVER])
    assert media_kind("/v/song.mp3") == "audio"


@pytest.mark.parametrize("stdout", ['{"streams": []}', "{}", "", "not json"],
                         ids=["no-streams", "nothing-read", "no-answer", "not-json"])
def test_a_file_ffprobe_finds_nothing_in_is_neither(monkeypatch, stdout):
    _ffprobe_says(monkeypatch, stdout=stdout)
    assert media_kind("/v/junk.mp4") is None


def test_a_cover_alone_is_neither(monkeypatch):
    _ffprobe_says(monkeypatch, [COVER])
    assert media_kind("/v/cover.mp3") is None


@pytest.mark.parametrize("format_name,fmt", [
    ("wav", "wav"), ("flac", "flac"), ("mp3", "mp3"), (MP4, "m4a"), ("ogg", None), (None, None)])
def test_the_audio_format_is_one_of_the_four_or_none(monkeypatch, format_name, fmt):
    _ffprobe_says(monkeypatch, [SOUND], format_name)
    assert media.audio_format("/v/in") == fmt
    if fmt:
        assert fmt in media.AUDIO_CODECS and media.AUDIO_MIME[fmt].startswith("audio/")


# --- the length of a file with no picture -----------------------------------

def test_the_length_of_a_file_with_no_picture_is_its_own(monkeypatch):
    """ffprobe answers nothing for the first video stream of an audio file,
    which used to raise; every length reader in the app goes through here."""
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="" if "-select_streams" in argv else "2.037551\n",
                                           stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert media.video_duration("/v/in.mp3") == pytest.approx(2.037551)
    assert calls[0][calls[0].index("-select_streams") + 1] == "v:0"
    assert calls[1][calls[1].index("-show_entries") + 1] == "format=duration"


def test_a_file_with_no_length_at_all_still_raises(monkeypatch):
    # The callers tell an unreadable file by this (app/api/captions.py).
    monkeypatch.setattr(subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 1, stdout="", stderr="bad"))
    with pytest.raises((IndexError, ValueError)):
        media.video_duration("/v/junk.mp4")


# --- the real thing ----------------------------------------------------------

def _ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True, capture_output=True)


@pytest.fixture
def real_files(monkeypatch, tmp_path):
    """A two-second tone as wav, flac, mp3 and m4a, an mp3 with a cover, a
    video, and a file of made-up bytes: name -> path."""
    monkeypatch.undo()   # the real probe, not the stand-in
    p = {name: str(tmp_path / name) for name in
         ("a.wav", "a.flac", "a.mp3", "a.m4a", "a.ogg", "cover.png", "cover.mp3", "v.mp4", "junk.mp4")}
    _ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", p["a.wav"])
    for name in ("a.flac", "a.mp3", "a.m4a", "a.ogg"):
        _ffmpeg("-i", p["a.wav"], p[name])
    _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", p["cover.png"])
    _ffmpeg("-i", p["a.mp3"], "-i", p["cover.png"], "-map", "0:a", "-map", "1:v", "-c:a", "copy",
            "-c:v", "mjpeg", "-disposition:v", "attached_pic", p["cover.mp3"])
    _ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", p["v.mp4"])
    with open(p["junk.mp4"], "wb") as f:
        f.write(b"made-up bytes")
    return p


@needs_ffmpeg
def test_real_files_are_told_apart(real_files):
    p = real_files
    assert media.media_kind(p["v.mp4"]) == "video"
    assert [media.media_kind(p[n]) for n in ("a.wav", "a.flac", "a.mp3", "a.m4a", "cover.mp3")] == ["audio"] * 5
    assert media.media_kind(p["junk.mp4"]) is None
    assert [media.audio_format(p[n]) for n in ("a.wav", "a.flac", "a.mp3", "a.m4a", "cover.mp3", "a.ogg")] == [
        "wav", "flac", "mp3", "m4a", "mp3", None]
    for name in ("a.wav", "a.flac", "a.mp3", "a.m4a", "cover.mp3", "v.mp4"):
        assert media.video_duration(p[name]) == pytest.approx(2.0, abs=0.1), name


@needs_ffmpeg
@pytest.mark.parametrize("name", ["a.wav", "a.mp3", "cover.mp3", "a.m4a"])
def test_a_real_audio_file_is_cut_in_place_and_stays_audio(real_files, tmp_path, name):
    """The job's copy keeps the name input.mp4 whatever it holds, and a cut
    writes it again: as sound only, never the cover as a picture."""
    src = str(tmp_path / "input.mp4")
    with open(real_files[name], "rb") as a, open(src, "wb") as b:
        b.write(a.read())
    media.cut_video(src, 0.5, 1.5)
    assert media.media_kind(src) == "audio" and media.audio_format(src) == "flac"
    assert media.video_duration(src) == pytest.approx(1.0, abs=0.05)
    with open(real_files[name], "rb") as a, open(src, "wb") as b:
        b.write(a.read())
    recorded = []
    media.cut_ranges(src, [[0.0, 0.5], [1.0, 1.75]], on_cut=lambda: recorded.append(True))
    assert media.media_kind(src) == "audio" and recorded == [True]
    assert media.video_duration(src) == pytest.approx(1.25, abs=0.05)
    assert not [n for n in sorted(p.name for p in tmp_path.iterdir()) if ".cut." in n]


@needs_ffmpeg
@pytest.mark.parametrize("fmt", ["mp3", "wav", "flac", "m4a"])
def test_a_real_audio_file_is_saved_in_each_of_the_four(real_files, tmp_path, fmt):
    out = str(tmp_path / ("out." + fmt))
    media.run_new_file(media.audio_command(real_files["cover.mp3"], out, fmt), 2, "Could not save the audio")
    assert media.media_kind(out) == "audio" and media.audio_format(out) == fmt


@needs_ffmpeg
@pytest.mark.parametrize("mix_seconds", [1.0, 3.0], ids=["mix-shorter", "mix-longer"])
def test_a_real_audio_result_is_the_mix_at_the_sources_length(real_files, tmp_path, mix_seconds):
    mix = str(tmp_path / "mix.wav")
    _ffmpeg("-f", "lavfi", "-i", f"sine=frequency=220:duration={mix_seconds}", mix)
    out = str(tmp_path / "dubbed.wav")
    r = media.build_result(real_files["a.mp3"], mix, out)
    assert r.returncode == 0, r.stderr
    assert media.audio_format(out) == "wav"
    assert media.video_duration(out) == pytest.approx(media.video_duration(real_files["a.mp3"]), abs=0.02)
