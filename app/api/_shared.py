"""The helpers more than one router needs.

app/api/results.py names an .srt and a subtitled .mp4 with free_path,
app/api/clips.py names a clip with it. The two "where is this job's folder"
answers below are shared the same way: dub.py, results.py and script.py all
ask them. Here rather than in any one router so no router has to import
another.

Both work-dir helpers were app/main.py's until 2026-09-06, read back off it by
the routers' `_main()` seams. Unchanged apart from losing their leading
underscore, now that they are a module's exports rather than one file's
privates.
"""
import os

from fastapi import HTTPException

from app import state


def work_dir_of(job: dict) -> str:
    """Where this job's folder is -- the one answer, in one place.

    work_dir is stamped the moment the folder is made, so it is there even for a
    job that failed before it produced anything. dirname(out_path) is the older
    way of asking the same question, kept as the fallback so a record written
    before work_dir existed (or hand-built in a test) still resolves.

    Not for the script and subtitle routes: those ask out_path directly (see
    script_work_dir), because they say 409 when there is no result at all. In
    the product the two answers are the same folder -- run_dub always writes the
    result inside work_dir -- so what really pins those routes is two tests
    whose fake run writes the result somewhere else (tests/test_dub_api.py,
    fake_run_dub).
    """
    return job.get("work_dir") or os.path.dirname((job.get("result") or {}).get("out_path") or "")


def script_work_dir(jid: str) -> tuple:
    """The job and its folder, or the right HTTP error.

    Shared: redub in app/api/dub.py starts from it, and every route in
    app/api/script.py does too.
    """
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    out = (job.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=409, detail="This job has no finished script yet.")
    return job, os.path.dirname(out)


def free_path(base: str, ext: str) -> str:
    """base+ext, or base-1+ext.. when that name is taken. Never writes over."""
    cand = base + ext
    n = 0
    while os.path.exists(cand):
        n += 1
        cand = "%s-%d%s" % (base, n, ext)
    return cand
