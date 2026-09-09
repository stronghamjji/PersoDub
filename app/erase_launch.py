"""One builder for the work a subtitle-erase job runs.

The dub's builder is app/dub_launch.py; this is its much smaller twin, and it
exists for the same reason: the boot re-arm has nothing but job.json to go on,
so a job's record has to be the whole description of its work. An erase is one
stage -- there is no download, no trim left to make (the routes cut before the
job starts) and no engine choice -- so the whole of it is one call.

Its own file rather than a branch inside dub_launch.py: the two share nothing
but the shape (a record in, work(log) out), and that shape is what lets
app/api/dub.py's rearm_queued_jobs start either kind without knowing which.

Domain only, like dub_launch: nothing here knows about FastAPI or a request,
and run_erase comes in as an argument so the tests can hand it a stand-in.
"""
import os

from app import eraser


def work_for(job, *, cancel_check):
    """The work one erase job runs, built from its record and its folder.

    Returns work(log) -- what JobStore.start wants. The video is input.mp4 in
    the job's folder and the result is erased.mp4 beside it, the same way a dub
    keeps input.mp4 and dubbed.mp4. `area` is the band the user picked, or
    "whole" for the whole frame (slower, but it catches writing anywhere).

    The erase itself is reached through the module, not imported by name --
    that is the seam the tests replace, the way dub_launch takes run_dub as an
    argument.
    """
    work = job["work_dir"]
    input_path = os.path.join(work, "input.mp4")
    out_path = os.path.join(work, "erased.mp4")
    area = job.get("area")
    band = None if not area or area == "whole" else tuple(area)

    def work_now(log):
        eraser.run_erase(input_path, out_path, band, log=log, cancel_check=cancel_check)
        # Same shape a dub's result has: out_path is how every reader --
        # Projects, the delete route, the agent -- finds a job's folder.
        return {"out_path": out_path}

    return work_now
