"""One builder for the work a "Separate audio" job runs.

The third twin of app/dub_launch.py and app/erase_launch.py, for the same
reason: the boot re-arm has nothing but job.json to go on, so the record has
to be the whole description of the work. A separation is the dubbing
pipeline's first stage and nothing after it -- the voice and the background
of the kept parts of a video, left in the job's folder as vocals.wav and
background.wav -- so the whole of it is one call into app/pipeline.py, the
same call a dubbing makes, on this computer (Demucs) or through Perso.

It also answers the question a dubbing asks afterwards: are this job's two
files the separation of the very video I am about to dub? (stems_for). When
they are, the dubbing copies them in instead of separating again.

Domain only: nothing here knows about FastAPI or a request.
"""
import os
import shutil
import time

from app import media, pipeline, state
from app.jobs import JobCancelled, JobKind, JobStatus, kind_of

# The two files a separation leaves, by the word each goes out under. The
# same names app/api/results.py hands a dubbing's stems out by.
STEMS = {"voice": "vocals.wav", "background": "background.wav"}


def separate(video_path, work, engine, *, cancel_check, on_notice, log, seconds=None, title=None):
    """Run the pipeline's separation stage. Returns (vocals, background, client, model).

    Its own name on this module because this is the seam the tests replace,
    the way app/erase_launch.py reaches the eraser through its module.
    `title` names the upload on Perso's workspace; the local engine has no use for it.
    """
    return pipeline._stage_separate(
        video_path, work, "perso" if engine == "perso" else None, None,
        cancel_check, on_notice, log, video_duration=seconds, title=title)


def work_for(job, *, cancel_check, on_notice):
    """The work one separation job runs, built from its record and its folder.

    Returns work(log) -- what JobStore.start wants. The video is input.mp4 in
    the job's folder, already cut down to the kept parts by the route that
    started it.
    """
    jid = job["id"]
    work = job["work_dir"]
    video_path = os.path.join(work, "input.mp4")
    engine = job.get("separation")

    def work_now(log):
        try:
            seconds = media.video_duration(video_path)
        except Exception:
            seconds = None
        # When the separating itself began (not when the job joined the line):
        # the screen counts its progress from here.
        state.job_store.update(jid, started=time.time())
        # Through Perso it is named on the workspace as the project is here
        # (owner, 2026-10-22). Only said then: the seam's fakes in tests predate it.
        vocals, background, client, model = separate(
            video_path, work, engine, cancel_check=cancel_check,
            on_notice=on_notice, log=log, seconds=seconds,
            **({"title": job.get("title") or job.get("project")} if engine == "perso" else {}))
        # The same note a dubbing leaves, so a dubbing handed these two files
        # reads them exactly as it reads its own after a Resume.
        pipeline._save_json(work, pipeline.SEPARATED_NAME,
                            pipeline._separation_note(vocals, background, model))
        # The local engine cannot be interrupted half way; a Stop pressed
        # meanwhile still ends the job as stopped.
        if cancel_check():
            raise JobCancelled("Separating was stopped.")
        # out_path is how every reader finds a job's folder; the length, the
        # credits and the model go onto the record the way a dubbing's do.
        return {"out_path": vocals, "duration": seconds, "separation_model": model,
                "perso_credits": getattr(client, "credits_used", None)}

    return work_now


def _same_parts(a, b) -> bool:
    """Two lists of kept parts ([[start, end], ...] or None for all) are the
    same cut, to a hundredth of a second."""
    if not a or not b:
        return not a and not b
    return (len(a) == len(b)
            and all(abs(x[0] - y[0]) < 0.01 and abs(x[1] - y[1]) < 0.01 for x, y in zip(a, b)))


def parts_of(job):
    """The parts of its original a job kept, [[start, end], ...], or None for all."""
    if job.get("ranges"):
        return job["ranges"]
    trim = job.get("trim")
    if trim and trim.get("start") is not None and trim.get("end") is not None:
        return [[trim["start"], trim["end"]]]
    return None


def stems_for(jid, download_id, parts):
    """The (vocals, background) files of separation job `jid` when they are
    the separation of held video `download_id` cut to `parts`; None otherwise.

    Strict on purpose: the same held video and the same kept parts, or the
    job's own video held again whole (`held_again`, stamped by the route that
    reopens a finished separation). Anything else separates again -- a wrong
    voice track under a dubbing is worse than a minute saved.
    """
    job = state.job_store.get(jid or "")
    if not job or kind_of(job) != JobKind.SEPARATE or job.get("status") != JobStatus.DONE or not download_id:
        return None
    same_video = (job.get("download_id") == download_id and _same_parts(parts_of(job), parts))
    whole_again = job.get("held_again") == download_id and not parts
    if not (same_video or whole_again):
        return None
    work = job.get("work_dir") or ""
    paths = [os.path.join(work, name) for name in (STEMS["voice"], STEMS["background"])]
    if not all(os.path.isfile(p) and os.path.getsize(p) > 44 for p in paths):
        return None
    return paths[0], paths[1]


def copy_stems(paths, work) -> None:
    """Put a separation's two files into a dubbing's folder, with the note a
    finished separation stage leaves beside them."""
    for src in paths:
        shutil.copyfile(src, os.path.join(work, os.path.basename(src)))
    # The model travels with the files: the dubbing's record says what made them.
    model = (pipeline._load_json(os.path.dirname(paths[0]), pipeline.SEPARATED_NAME) or {}).get("model")
    pipeline._save_json(work, pipeline.SEPARATED_NAME,
                        pipeline._separation_note(paths[0], paths[1], model))
