"""The last stage of a local dub (app/pipeline.py _stage_finish), pinned as it is.

It puts the dubbed audio onto the video, checks the length, and only then
throws away the losing voice takes. The order is the point: the takes are
kept until the finished file has passed the length check, so a failure before
that leaves them for a reassembly. ffmpeg itself never runs here -- the three
media helpers and cleanup_takes are replaced with recorders, at the names
app/pipeline.py documents as its seams.
"""
from types import SimpleNamespace

import pytest

from app import pipeline

BUILDING = "6/6 Building the finished file…"
KEEPING = "   keeping the per-line audio so single lines can be redone"


@pytest.fixture
def finish(monkeypatch, tmp_path):
    """The stage with recorders in place of ffmpeg and cleanup_takes.

    finish.run(mux_returncode=0, mux_stderr="", length_check_error=None) calls
    it; finish.timeline gets every log line ("log: ...") and every call, in
    the order they happened. A `True` in a recorded call means the stage
    handed that helper its own log."""
    f = SimpleNamespace(timeline=[], video=str(tmp_path / "input.mp4"),
                        audio=str(tmp_path / "qwen_dub_48k.wav"), out=str(tmp_path / "dubbed.mp4"),
                        work=str(tmp_path))
    answer = {}

    def video_duration(path):
        f.timeline.append(("_video_duration", path))
        return 12.5

    def mux(video, audio, out, dur):
        f.timeline.append(("_mux", video, audio, out, dur))
        return SimpleNamespace(returncode=answer["returncode"], stderr=answer["stderr"])

    def ensure_video_length(original, out, log):
        f.timeline.append(("ensure_video_length", original, out, log is answer["log"]))
        if answer["length_check_error"]:
            raise answer["length_check_error"]

    def cleanup_takes(work_dir, log):
        f.timeline.append(("cleanup_takes", work_dir, log is answer["log"]))

    monkeypatch.setattr(pipeline, "_video_duration", video_duration)
    monkeypatch.setattr(pipeline, "_mux", mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", ensure_video_length)
    monkeypatch.setattr(pipeline, "cleanup_takes", cleanup_takes)

    def run(mux_returncode=0, mux_stderr="", length_check_error=None):
        def log(line):
            f.timeline.append("log: " + line)
        answer.update(returncode=mux_returncode, stderr=mux_stderr,
                      length_check_error=length_check_error, log=log)
        return pipeline._stage_finish(f.video, f.audio, f.out, f.work, log)

    f.run = run
    return f


def test_a_finished_dub_is_muxed_then_length_checked_then_its_takes_are_dropped(finish):
    f = finish
    assert f.run() is None
    assert f.timeline == [
        "log: " + BUILDING,
        ("_video_duration", f.video),
        # The audio is padded to the VIDEO's length, measured just before.
        ("_mux", f.video, f.audio, f.out, 12.5),
        ("ensure_video_length", f.video, f.out, True),
        ("cleanup_takes", f.work, True),
        "log: " + KEEPING,
    ]


# ffmpeg's stderr for a failed mux: only its last line is the reason. The
# lines before it name the files, folders and all (ffmpeg 7).
NAMED_STDERR = ("Error opening output file /Users/someone/Library/Application Support/PersoDub/"
                "workspace/2026-10-10/My Video_ko/dubbed.mp4.\n"
                "Error opening output files: No space left on device\n")


@pytest.mark.parametrize("stderr,error", [
    pytest.param(NAMED_STDERR, "Could not build the finished video: Error opening output files: "
                               "No space left on device", id="only-the-last-line"),
    pytest.param("Conversion failed!", "Could not build the finished video: Conversion failed!",
                 id="short-stderr-whole"),
    pytest.param("", "Could not build the finished video.", id="no-stderr"),
])
def test_a_mux_that_fails_ends_the_job_with_these_words(finish, stderr, error):
    f = finish
    with pytest.raises(RuntimeError) as caught:
        f.run(mux_returncode=1, mux_stderr=stderr)
    # A RuntimeError's text is what the done screen shows word for word
    # (app/jobs.py USER_FACING_ERRORS), so this is what the user reads.
    assert type(caught.value) is RuntimeError
    assert str(caught.value) == error
    # Nothing after the mux ran: no length check, and the takes are kept.
    assert f.timeline == [
        "log: " + BUILDING,
        ("_video_duration", f.video),
        ("_mux", f.video, f.audio, f.out, 12.5),
    ]


def test_a_mux_failure_names_the_file_but_not_its_folders(finish, tmp_path):
    # ffmpeg 6 and older end on the path itself, and a real job folder has
    # spaces in it: "Application Support" on every Mac, and the video's title.
    f = finish
    f.out = str(tmp_path / "Application Support" / "My Video_ko" / "dubbed.mp4")
    with pytest.raises(RuntimeError) as caught:
        f.run(mux_returncode=1, mux_stderr=f.out + ": Permission denied\n")
    assert str(caught.value) == "Could not build the finished video: dubbed.mp4: Permission denied"


def test_a_length_check_that_fails_keeps_the_takes(finish):
    f = finish
    boom = OSError("could not replace dubbed.mp4")
    with pytest.raises(OSError) as caught:
        f.run(length_check_error=boom)
    assert caught.value is boom            # passed on as it came, not reworded
    assert f.timeline == [
        "log: " + BUILDING,
        ("_video_duration", f.video),
        ("_mux", f.video, f.audio, f.out, 12.5),
        ("ensure_video_length", f.video, f.out, True),
    ]


# --- an audio project: the result is dubbed.wav, and there is no picture ------

@pytest.fixture
def audio_finish(finish, monkeypatch, tmp_path):
    """The same stage for a job whose result is dubbed.wav. The mux and the
    video length check stay recorders, so a call to either shows in the
    timeline; media.build_result is one too, answering audio_finish.built."""
    f = finish
    f.out = str(tmp_path / "dubbed.wav")
    f.built = SimpleNamespace(returncode=0, stderr="")

    def build_result(source, mix, out):
        f.timeline.append(("build_result", source, mix, out))
        return f.built

    monkeypatch.setattr(pipeline.media, "build_result", build_result)
    return f


def test_an_audio_project_is_built_without_a_mux_then_its_takes_are_dropped(audio_finish):
    f = audio_finish
    assert f.run() is None
    assert f.timeline == [
        "log: " + BUILDING,
        ("build_result", f.video, f.audio, f.out),
        ("cleanup_takes", f.work, True),
        "log: " + KEEPING,
    ]


def test_an_audio_build_that_fails_ends_the_job_with_these_words_and_keeps_the_takes(audio_finish):
    f = audio_finish
    f.built = SimpleNamespace(returncode=1, stderr=f.out + ": Permission denied\n")
    with pytest.raises(RuntimeError) as caught:
        f.run()
    assert type(caught.value) is RuntimeError
    assert str(caught.value) == "Could not build the finished audio: dubbed.wav: Permission denied"
    assert f.timeline == ["log: " + BUILDING, ("build_result", f.video, f.audio, f.out)]
