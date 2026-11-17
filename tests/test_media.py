"""ffmpeg helper layer (app/media.py) -- argv shape and output parsing.

No ffmpeg/ffprobe is ever launched here: subprocess.run is stubbed, so these
tests pin down exactly what the app ASKS ffmpeg to do (the flags are the
behavior -- an accidental "-c:v copy" on the trim path would silently move a
cut to the nearest keyframe) and how it reads the answers back.
"""
import subprocess

import pytest

from app import media


class _Done:
    """Stand-in for subprocess.CompletedProcess."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _record(monkeypatch, result, on_run=None):
    """Stub app.media's subprocess.run; returns the list it appends argv to."""
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        if on_run is not None:
            on_run(argv)
        return result if not callable(result) else result(argv)

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


# --- stream_duration / video_duration ---------------------------------------

def test_stream_duration_parses_ffprobe_output(monkeypatch):
    calls = _record(monkeypatch, _Done(stdout="12.345\n"))
    assert media.stream_duration("/v/in.mp4", "v:0") == pytest.approx(12.345)
    argv = calls[0][0]
    assert argv[0] == "ffprobe"
    assert argv[argv.index("-select_streams") + 1] == "v:0"
    assert argv[-1] == "/v/in.mp4"
    assert calls[0][1]["capture_output"] is True
    assert calls[0][1]["text"] is True


def test_stream_duration_strips_ffmpeg_7_trailing_comma(monkeypatch):
    # ffmpeg 7.x writes "12.345," for -of csv=p=0; float() would raise on that.
    _record(monkeypatch, _Done(stdout="12.345,\n"))
    assert media.stream_duration("/v/in.mp4", "a:0") == pytest.approx(12.345)


def test_stream_duration_uses_only_the_first_line(monkeypatch):
    _record(monkeypatch, _Done(stdout="3.0,\n9.0,\n"))
    assert media.stream_duration("/v/in.mp4", "v:0") == pytest.approx(3.0)


def test_video_duration_asks_for_the_first_video_stream(monkeypatch):
    calls = _record(monkeypatch, _Done(stdout="7.5,\n"))
    assert media.video_duration("/v/in.mp4") == pytest.approx(7.5)
    argv = calls[0][0]
    assert argv[argv.index("-select_streams") + 1] == "v:0"


# --- mux --------------------------------------------------------------------

def test_mux_copies_the_video_and_pads_the_audio(monkeypatch):
    calls = _record(monkeypatch, _Done())
    r = media.mux("/v/in.mp4", "/v/dub.wav", "/v/out.mp4", 12.3456)
    assert r.returncode == 0
    argv = calls[0][0]
    assert argv[0] == "ffmpeg"
    # video untouched, audio re-encoded
    assert argv[argv.index("-c:v") + 1] == "copy"
    assert argv[argv.index("-c:a") + 1] == "aac"
    # audio silence-padded and cut to the video's exact length (3 decimals)
    assert argv[argv.index("-af") + 1] == "apad"
    assert argv[argv.index("-t") + 1] == "12.346"
    assert argv[-1] == "/v/out.mp4"
    assert argv.index("/v/in.mp4") < argv.index("/v/dub.wav")


# --- ensure_video_length ----------------------------------------------------

def test_ensure_video_length_does_nothing_when_lengths_match(monkeypatch):
    monkeypatch.setattr(media, "video_duration", lambda p: 10.0)
    monkeypatch.setattr(media, "mux", lambda *a: pytest.fail("must not re-mux"))
    media.ensure_video_length("/v/in.mp4", "/v/out.mp4", lambda m: None)


def test_ensure_video_length_tolerates_a_20ms_difference(monkeypatch):
    durations = {"/v/in.mp4": 10.0, "/v/out.mp4": 9.985}
    monkeypatch.setattr(media, "video_duration", lambda p: durations[p])
    monkeypatch.setattr(media, "mux", lambda *a: pytest.fail("must not re-mux"))
    media.ensure_video_length("/v/in.mp4", "/v/out.mp4", lambda m: None)


def test_ensure_video_length_rebuilds_from_the_original_when_short(monkeypatch, tmp_path):
    out = tmp_path / "out.mp4"
    out.write_bytes(b"short")
    durations = {"/v/in.mp4": 10.0, str(out): 9.5}
    monkeypatch.setattr(media, "video_duration", lambda p: durations[p])

    muxed = []

    def fake_mux(video, audio, target, dur):
        muxed.append((video, audio, target, dur))
        open(target, "wb").write(b"rebuilt")
        return _Done()

    monkeypatch.setattr(media, "mux", fake_mux)
    media.ensure_video_length("/v/in.mp4", str(out), lambda m: None)

    # The ORIGINAL video track is the source, the short export only the audio,
    # and the target length is the original's.
    assert muxed == [("/v/in.mp4", str(out), str(out) + ".fix.mp4", 10.0)]
    assert out.read_bytes() == b"rebuilt"          # the fix replaced the export
    assert not (tmp_path / "out.mp4.fix.mp4").exists()


def test_ensure_video_length_keeps_the_export_when_the_rebuild_fails(monkeypatch, tmp_path):
    out = tmp_path / "out.mp4"
    out.write_bytes(b"short")
    durations = {"/v/in.mp4": 10.0, str(out): 9.5}
    monkeypatch.setattr(media, "video_duration", lambda p: durations[p])
    monkeypatch.setattr(media, "mux", lambda *a: _Done(returncode=1, stderr="boom"))
    logged = []
    media.ensure_video_length("/v/in.mp4", str(out), logged.append)
    assert out.read_bytes() == b"short"
    assert any("Warning" in m for m in logged)


def test_ensure_video_length_never_raises_when_probing_fails(monkeypatch):
    def boom(p):
        raise RuntimeError("no ffprobe")

    monkeypatch.setattr(media, "video_duration", boom)
    logged = []
    media.ensure_video_length("/v/in.mp4", "/v/out.mp4", logged.append)   # must not raise
    assert any("Warning" in m for m in logged)


# --- cut_video --------------------------------------------------------------

def test_cut_video_re_encodes_between_the_asked_seconds(monkeypatch, tmp_path):
    src = tmp_path / "input.mp4"
    src.write_bytes(b"original")
    calls = _record(monkeypatch, _Done(), on_run=lambda argv: open(argv[-1], "wb").write(b"cut"))

    media.cut_video(str(src), 1.5, 4.25)

    argv = calls[0][0]
    assert argv[0] == "ffmpeg"
    assert argv[argv.index("-ss") + 1] == "1.500"
    assert argv[argv.index("-to") + 1] == "4.250"
    # -ss/-to come BEFORE -i, and the cut is re-encoded (a copy-cut would land
    # on the nearest keyframe, seconds away from what the user asked for).
    assert argv.index("-ss") < argv.index("-i")
    assert argv[argv.index("-c:v") + 1] == "libx264"
    assert argv[-1] == str(src) + ".cut.mp4"
    # the cut file took the original's place, and no .cut.mp4 was left behind
    assert src.read_bytes() == b"cut"
    assert not (tmp_path / "input.mp4.cut.mp4").exists()


def test_cut_video_runs_on_cut_after_the_file_is_replaced(monkeypatch, tmp_path):
    src = tmp_path / "input.mp4"
    src.write_bytes(b"original")
    _record(monkeypatch, _Done(), on_run=lambda argv: open(argv[-1], "wb").write(b"cut"))

    seen = []
    media.cut_video(str(src), 0.0, 1.0, on_cut=lambda: seen.append(src.read_bytes()))
    # on_cut must not be able to observe the pre-cut file: recording the cut a
    # statement later leaves a window where a crash re-cuts the same seconds.
    assert seen == [b"cut"]


def test_cut_video_raises_with_only_ffmpegs_last_line_and_no_folder_names(monkeypatch, tmp_path):
    src = tmp_path / "input.mp4"
    src.write_bytes(b"original")
    stderr = ("Input #0, mov,mp4, from '/Users/someone/Movies/input.mp4':\n"
              "/Users/someone/Movies/input.mp4: Invalid data found\n")
    _record(monkeypatch, _Done(returncode=1, stderr=stderr))

    with pytest.raises(RuntimeError) as e:
        media.cut_video(str(src), 0.0, 1.0)
    msg = str(e.value)
    assert msg.startswith("Could not trim the video: ")
    assert "input.mp4: Invalid data found" in msg
    assert "/Users/someone" not in msg          # no folder names on screen
    assert "Input #0" not in msg                # only ffmpeg's last line
    assert src.read_bytes() == b"original"      # the source is untouched


def test_cut_video_removes_a_half_written_temp_file_when_ffmpeg_fails(monkeypatch, tmp_path):
    src = tmp_path / "input.mp4"
    src.write_bytes(b"original")
    # ffmpeg died with its output already open -> a partial .cut.mp4 on disk
    _record(monkeypatch, _Done(returncode=1, stderr="No space left on device"),
            on_run=lambda argv: open(argv[-1], "wb").write(b"half"))

    with pytest.raises(RuntimeError):
        media.cut_video(str(src), 0.0, 1.0)
    assert not (tmp_path / "input.mp4.cut.mp4").exists()


# --- the same cuts on a file that is sound only ------------------------------

def _joined(argv):
    return " ".join(argv)


def test_a_trim_of_an_audio_file_encodes_no_picture(monkeypatch, tmp_path):
    """An audio project's input.mp4 holds a song: there is no picture for
    libx264, and an album cover must not become one."""
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    src = tmp_path / "input.mp4"
    src.write_bytes(b"original")
    calls = _record(monkeypatch, _Done(), on_run=lambda argv: open(argv[-1], "wb").write(b"cut"))
    seen = []

    media.cut_video(str(src), 1.5, 4.25, on_cut=lambda: seen.append(src.read_bytes()))

    assert len(calls) == 1
    argv = calls[0][0]
    assert argv[0] == "ffmpeg" and argv[argv.index("-i") + 1] == str(src)
    assert "libx264" not in argv and "[0:v]" not in _joined(argv)
    graph = argv[argv.index("-filter_complex") + 1]
    assert graph == "[0:a]atrim=start=1.500:end=4.250,asetpts=PTS-STARTPTS[a0];[a0]concat=n=1:v=0:a=1[a]"
    # Only the sound is kept, and written so that nothing of it is lost,
    # whatever the file was: FLAC, told by the scratch file's name.
    assert argv[argv.index("-map") + 1] == "[a]" and argv.count("-map") == 1
    assert argv[argv.index("-c:a") + 1] == "flac" and argv[-1] == str(src) + ".cut.flac"
    # The cut took the original's place under its own name, and on_cut ran after.
    assert src.read_bytes() == b"cut" and seen == [b"cut"]
    assert not (tmp_path / "input.mp4.cut.flac").exists()


def test_kept_parts_of_an_audio_file_are_joined_without_a_picture(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    src = tmp_path / "input.mp4"
    src.write_bytes(b"original")
    calls = _record(monkeypatch, _Done(), on_run=lambda argv: open(argv[-1], "wb").write(b"joined"))
    seen = []

    media.cut_ranges(str(src), [[0, 1.5], [3, 4.25]], on_cut=lambda: seen.append(True))

    assert len(calls) == 1     # the sound track is not asked about: it is all there is
    argv = calls[0][0]
    assert "libx264" not in argv and "[0:v]" not in _joined(argv)
    assert argv[argv.index("-filter_complex") + 1].endswith("[a0][a1]concat=n=2:v=0:a=1[a]")
    assert argv[argv.index("-c:a") + 1] == "flac" and argv[-1] == str(src) + ".cut.flac"
    assert src.read_bytes() == b"joined" and seen == [True]


def test_an_audio_cut_that_fails_leaves_the_file_and_no_scratch(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    src = tmp_path / "input.mp4"
    src.write_bytes(b"original")
    _record(monkeypatch, _Done(returncode=1, stderr=str(src) + ": Invalid data found when processing input\n"),
            on_run=lambda argv: open(argv[-1], "wb").write(b"half"))
    with pytest.raises(RuntimeError) as caught:
        media.cut_video(str(src), 0.0, 1.0)
    assert str(caught.value) == "Could not trim the audio: input.mp4: Invalid data found when processing input"
    assert src.read_bytes() == b"original"
    assert not (tmp_path / "input.mp4.cut.flac").exists()


@pytest.mark.parametrize("fmt,codec,mime", [
    ("mp3", ["-c:a", "libmp3lame", "-b:a", "192k"], "audio/mpeg"),
    ("wav", ["-c:a", "pcm_s16le"], "audio/wav"),
    ("flac", ["-c:a", "flac"], "audio/flac"),
    ("m4a", ["-c:a", "aac", "-b:a", "256k"], "audio/mp4"),
])
def test_sound_is_saved_in_four_formats_each_with_its_type(fmt, codec, mime):
    assert sorted(media.AUDIO_CODECS) == sorted(media.AUDIO_MIME) == ["flac", "m4a", "mp3", "wav"]
    argv = media.audio_command("/v/in.mp4", "/v/out." + fmt, fmt)
    assert argv[-1 - len(codec):-1] == codec and "-vn" in argv
    assert media.AUDIO_MIME[fmt] == mime


# --- build_result -------------------------------------------------------------

def test_an_audio_result_is_the_mix_padded_to_the_sources_length_with_no_mux(monkeypatch):
    monkeypatch.setattr(media, "video_duration", lambda path: 12.5)
    monkeypatch.setattr(media, "mux", lambda *a: pytest.fail("there is no picture to put it on"))
    calls = _record(monkeypatch, _Done())
    r = media.build_result("/v/input.mp4", "/v/mix.wav", "/v/dubbed.wav")
    assert r.returncode == 0 and len(calls) == 1
    argv = calls[0][0]
    # The mix is the only input: the source gives its length and nothing else.
    assert argv[0] == "ffmpeg" and argv.count("-i") == 1 and argv[argv.index("-i") + 1] == "/v/mix.wav"
    assert argv[argv.index("-af") + 1] == "apad" and argv[argv.index("-t") + 1] == "12.500"
    assert argv[-1] == "/v/dubbed.wav"


def test_a_video_result_is_muxed_as_before(monkeypatch):
    monkeypatch.setattr(media, "video_duration", lambda path: 12.5)
    muxed = []
    monkeypatch.setattr(media, "mux", lambda *a: muxed.append(a) or _Done())
    assert media.build_result("/v/input.mp4", "/v/mix.wav", "/v/dubbed.mp4").returncode == 0
    assert muxed == [("/v/input.mp4", "/v/mix.wav", "/v/dubbed.mp4", 12.5)]


def test_a_windows_path_in_ffmpegs_last_line_loses_its_folders():
    msg = media._failure("Could not trim the video",
                         "C:\\Users\\name\\Videos\\a.mp4: Invalid data found when processing input\n")
    assert msg == "Could not trim the video: a.mp4: Invalid data found when processing input"


def test_ffmpegs_own_label_for_the_part_that_spoke_is_not_shown():
    # Windows test 2026-10-10: the Export failure read "mp4 @ 000001f21babe040]
    # Nothing was written ..." -- an address in front of the reason.
    msg = media._failure("ffmpeg could not cut this video",
                         "[out#0/mp4 @ 000001f21babe040] Nothing was written into output file, "
                         "because at least one of its streams received no packets.\n")
    assert msg == ("ffmpeg could not cut this video: Nothing was written into output file, "
                   "because at least one of its streams received no packets.")


def test_words_with_a_slash_are_not_cut_as_paths():
    msg = media._failure("Could not trim the video", "/Users/someone/a.mp4: Input/output error\n")
    assert msg == "Could not trim the video: a.mp4: Input/output error"


def test_a_path_ffmpeg_was_given_is_cut_to_its_name_even_with_spaces(monkeypatch, tmp_path):
    # A real temp path, so on Windows it is written with backslashes. Spaces
    # in folder names are the usual case: "Application Support" on every Mac,
    # a project folder named after its video, a Windows account name.
    folder = tmp_path / "Application Support" / "내 영상"
    folder.mkdir(parents=True)
    src = str(folder / "a b.mp4")
    _record(monkeypatch, _Done(returncode=1, stderr=src + ": Invalid data found when processing input\n"))
    with pytest.raises(RuntimeError) as trim:
        media.cut_video(src, 0.0, 1.0)
    with pytest.raises(RuntimeError) as save:
        media.run_new_file(media.audio_command(src, str(folder / "a b.mp3"), "mp3"), 1,
                           "Could not save the audio")
    assert str(trim.value) == "Could not trim the video: a b.mp4: Invalid data found when processing input"
    assert str(save.value) == "Could not save the audio: a b.mp4: Invalid data found when processing input"


# video_size reads whatever size ffprobe printed, even when ffprobe then exits
# non-zero, and says (0, 0) only when there is no size to read -- the shared
# probe (media.probe_size) must not tighten that for this caller.
@pytest.mark.parametrize("returncode, stdout, expected", [
    (0, "1280,720\n", (1280, 720)),
    (1, "640,360\n", (640, 360)),
    (1, "", (0, 0)),
    (0, "N/A,N/A\n", (0, 0)),
])
def test_video_size_reads_what_ffprobe_printed_whatever_its_exit_code(monkeypatch, returncode, stdout, expected):
    def fake_run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr="")
    monkeypatch.setattr(media.subprocess, "run", fake_run)
    assert media.video_size("clip.mp4") == expected


# --- join_video: a brought-in video and the dubbed sound as one file ----------

@pytest.fixture
def folder(tmp_path):
    """A job's folder with nothing in it yet (tmp_path itself holds the
    workspace tests/conftest.py makes)."""
    path = tmp_path / "talk_ko"
    path.mkdir()
    return path


def _join(monkeypatch, folder, video_ranges, sound_ranges, tempo=1.0, fails=()):
    """join_video on a 12-second video and a 10-second sound, with ffmpeg
    replaced: each run writes its output file, except the runs numbered in
    `fails` (from 0), which exit 1. Returns the argv of every run, and the
    error if it raised."""
    video, sound, out = folder / "join.mp4", folder / "dubbed.wav", folder / "joined.mp4"
    video.write_bytes(b"the user's video")
    sound.write_bytes(b"the dubbed sound")
    monkeypatch.setattr(media, "video_duration", lambda path: 10.0)
    runs = []

    def fake_run(argv, **kwargs):
        runs.append(argv)
        if len(runs) - 1 in fails:
            return _Done(returncode=1, stderr=f"{argv[-1]}: codec not currently supported in container\n")
        with open(argv[-1], "wb") as f:
            f.write(b"run %d" % len(runs))
        return _Done()

    monkeypatch.setattr(subprocess, "run", fake_run)
    error = None
    try:
        media.join_video(str(video), str(sound), str(out), video_ranges, sound_ranges, tempo)
    except RuntimeError as e:
        error = str(e)
    # Whatever happened, the two files it was given are as they were, and
    # nothing but they and the joined file is left in the folder.
    assert video.read_bytes() == b"the user's video" and sound.read_bytes() == b"the dubbed sound"
    assert sorted(p.name for p in folder.iterdir()) in (
        ["dubbed.wav", "join.mp4"], ["dubbed.wav", "join.mp4", "joined.mp4"])
    return runs, error


def _inputs(argv):
    return [argv[i + 1] for i, word in enumerate(argv) if word == "-i"]


def test_a_whole_video_and_a_whole_sound_are_joined_in_one_run_with_the_picture_copied(monkeypatch, folder):
    runs, error = _join(monkeypatch, folder, [[0, 12.0]], [[0, 10.0]])
    assert error is None and len(runs) == 1
    argv = runs[0]
    # The user's file and dubbed.wav themselves, the picture not encoded
    # again, the video's own sound left out, for the video's length.
    assert _inputs(argv) == [str(folder / "join.mp4"), str(folder / "dubbed.wav")]
    assert argv[argv.index("-c:v") + 1] == "copy" and argv[argv.index("-t") + 1] == "12.000"
    assert [argv[i + 1] for i, word in enumerate(argv) if word == "-map"] == ["0:v:0", "1:a:0"]
    # Written under another name and renamed, so a reader never sees half a file.
    assert argv[-1] == str(folder / "joined.mp4") + ".part.mp4"
    assert (folder / "joined.mp4").read_bytes() == b"run 1"


def test_a_video_cut_at_its_tail_only_is_still_copied(monkeypatch, folder):
    runs, error = _join(monkeypatch, folder, [[0, 6.5]], [[0, 10.0]])
    assert error is None and len(runs) == 1
    assert _inputs(runs[0])[0] == str(folder / "join.mp4")
    assert runs[0][runs[0].index("-c:v") + 1] == "copy" and runs[0][runs[0].index("-t") + 1] == "6.500"


@pytest.mark.parametrize("ranges,kept", [([[0, 2], [4, 8]], "6.000"), ([[1, 8]], "7.000")],
                         ids=["middle", "head"])
def test_a_video_cut_at_its_head_or_middle_is_encoded_again_without_its_sound(monkeypatch, folder,
                                                                             ranges, kept):
    runs, error = _join(monkeypatch, folder, ranges, [[0, 10.0]])
    assert error is None and len(runs) == 2
    cut, joined = runs
    # A copy would land each cut on the nearest keyframe.
    assert _inputs(cut) == [str(folder / "join.mp4")] and "libx264" in cut
    graph = cut[cut.index("-filter_complex") + 1]
    assert f"trim=start={ranges[0][0]:.3f}:end={ranges[0][1]:.3f}" in graph and "[0:a]" not in graph
    assert cut.count("-map") == 1
    # The joined file is that picture with the sound, for the kept length.
    assert _inputs(joined) == [cut[-1], str(folder / "dubbed.wav")]
    assert joined[joined.index("-t") + 1] == kept


def test_a_cut_sound_is_written_apart_and_the_dubbed_sound_is_only_read(monkeypatch, folder):
    runs, error = _join(monkeypatch, folder, [[0, 12.0]], [[0, 3], [5, 10]])
    assert error is None and len(runs) == 2
    cut, joined = runs
    assert _inputs(cut) == [str(folder / "dubbed.wav")] and cut[-1].endswith(".wav")
    assert cut[cut.index("-c:a") + 1] == "pcm_s16le"
    assert cut[cut.index("-filter_complex") + 1].endswith("[a0][a1]concat=n=2:v=0:a=1[a]")
    assert _inputs(joined) == [str(folder / "join.mp4"), cut[-1]]


def test_a_sound_that_stops_early_is_cut_even_though_it_starts_at_zero(monkeypatch, folder):
    # dubbed.wav as it is would play on past the cut.
    runs, _ = _join(monkeypatch, folder, [[0, 12.0]], [[0, 5]])
    assert len(runs) == 2 and "atrim=start=0.000:end=5.000" in runs[0][runs[0].index("-filter_complex") + 1]
    # A hair short of the whole is the whole (the rounding the routes allow).
    runs, _ = _join(monkeypatch, folder, [[0, 12.0]], [[0, 9.98]])
    assert len(runs) == 1


@pytest.mark.parametrize("tempo,steps", [(0.5, "atempo=0.5"), (1.5, "atempo=1.5"), (2.0, "atempo=2"),
                                         (3.0, "atempo=2,atempo=1.5")])
def test_the_speed_is_atempo_in_steps_every_ffmpeg_takes(monkeypatch, folder, tempo, steps):
    """atempo keeps the pitch. Older ffmpeg takes 0.5 to 2 in one step and
    newer ones drop samples above 2, so 3x is two steps."""
    runs, error = _join(monkeypatch, folder, [[0, 12.0]], [[0, 10.0]], tempo)
    assert error is None and len(runs) == 2
    graph = runs[0][runs[0].index("-filter_complex") + 1]
    assert graph == f"[0:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[a0];[a0]concat=n=1:v=0:a=1,{steps}[a]"
    assert all(0.5 <= float(step.split("=")[1]) <= 2 for step in steps.split(","))
    assert "asetrate" not in graph and "rubberband" not in graph
    assert _inputs(runs[1])[1] == runs[0][-1]


def test_a_picture_mp4_cannot_hold_as_it_is_is_encoded_and_joined_again(monkeypatch, folder):
    runs, error = _join(monkeypatch, folder, [[0, 6.5]], [[0, 10.0]], fails=(0,))
    assert error is None and len(runs) == 3
    failed, encoded, joined = runs
    assert failed[failed.index("-c:v") + 1] == "copy"
    assert _inputs(encoded) == [str(folder / "join.mp4")] and "libx264" in encoded
    assert "trim=start=0.000:end=6.500" in encoded[encoded.index("-filter_complex") + 1]
    assert _inputs(joined) == [encoded[-1], str(folder / "dubbed.wav")]
    assert (folder / "joined.mp4").read_bytes() == b"run 3"


def test_a_join_that_fails_both_ways_says_why_without_folders_and_leaves_nothing(monkeypatch, folder):
    (folder / "joined.mp4").write_bytes(b"the one built before")
    runs, error = _join(monkeypatch, folder, [[0, 12.0]], [[0, 10.0]], fails=(0, 2))
    assert len(runs) == 3
    assert error == "Could not make the dubbed video: joined.mp4.part.mp4: codec not currently supported in container"
    assert (folder / "joined.mp4").read_bytes() == b"the one built before"


def test_a_picture_already_encoded_again_is_not_encoded_a_second_time(monkeypatch, folder):
    runs, error = _join(monkeypatch, folder, [[1, 8]], [[0, 10.0]], fails=(1,))
    assert len(runs) == 2 and error.startswith("Could not make the dubbed video: ")
    assert not (folder / "joined.mp4").exists()


def test_the_failure_is_said_in_the_words_the_caller_gives(monkeypatch, folder):
    video, sound = folder / "join.mp4", folder / "dubbed.wav"
    monkeypatch.setattr(media, "video_duration", lambda path: 10.0)
    _record(monkeypatch, _Done(returncode=1, stderr="boom\n"))
    with pytest.raises(RuntimeError) as caught:
        media.join_video(str(video), str(sound), str(folder / "joined.mp4"), [[1, 8]], [[0, 10.0]],
                         what="더빙 영상을 만들지 못했어요")
    assert str(caught.value) == "더빙 영상을 만들지 못했어요: boom"


# --- a file something still has open (Windows) ---------------------------------

def test_a_file_held_for_a_moment_is_waited_for(monkeypatch):
    monkeypatch.setattr(media, "HOLD_STEP", 0)
    asks = []

    def act(*paths):
        asks.append(paths)
        if len(asks) <= 3:
            raise PermissionError(13, "in use")
        return "done"

    assert media.when_free(act, "new", "old") == "done"
    assert asks == [("new", "old")] * 4


def test_a_file_still_held_after_about_two_seconds_is_given_up_on(monkeypatch):
    assert 1.5 <= media.HOLD_TRIES * media.HOLD_STEP <= 3
    monkeypatch.setattr(media, "HOLD_STEP", 0)
    asks = []

    def act(path):
        asks.append(path)
        raise PermissionError(13, "in use")

    with pytest.raises(PermissionError):
        media.when_free(act, "old")
    assert len(asks) == media.HOLD_TRIES + 1


def test_only_a_held_file_is_waited_for(monkeypatch):
    monkeypatch.setattr(media, "HOLD_STEP", 0)
    asks = []

    def act(path):
        asks.append(path)
        raise FileNotFoundError(2, "gone")

    with pytest.raises(FileNotFoundError):
        media.when_free(act, "old")
    assert asks == ["old"]


def test_a_joined_file_still_being_read_is_replaced_once_it_is_let_go(monkeypatch, folder, hold):
    (folder / "joined.mp4").write_bytes(b"the one built before")
    refused = hold("joined.mp4", times=3)
    runs, error = _join(monkeypatch, folder, [[0, 12.0]], [[0, 10.0]])
    assert error is None and refused == ["replace"] * 3
    assert (folder / "joined.mp4").read_bytes() == b"run 1"


def test_a_joined_file_that_stays_held_is_left_whole_with_no_scratch_beside_it(monkeypatch, folder, hold):
    (folder / "joined.mp4").write_bytes(b"the one built before")
    refused = hold("joined.mp4")
    with pytest.raises(PermissionError):
        _join(monkeypatch, folder, [[2, 8]], [[0, 5.0]], tempo=2.0)
    assert refused == ["replace"] * (media.HOLD_TRIES + 1)
    assert (folder / "joined.mp4").read_bytes() == b"the one built before"
    assert sorted(p.name for p in folder.iterdir()) == ["dubbed.wav", "join.mp4", "joined.mp4"]
