"""A video brought into a finished audio project, and the dubbed video made
of the two.

The user dubs sound alone and gets the dubbed sound (dubbed.wav). Here they
bring in the video it belongs on: the video is kept beside the result, each
of the two can be cut on the timeline and the sound sped up, and the joined
file is built when it is asked for. The project stays an audio project.
Nothing is added to the job's record, because its settings go into its log
and from there into a failure report, which must not carry a file name. Four
files in the job's folder say everything instead, the way subtitle_style.json
says how the subtitles look (app/api/results.py):

  join.mp4     the user's video, byte for byte, under a fixed name
  join.json    that video's own name, the kept parts of each lane, the speed
  joined.mp4   the built file (never dubbed.mp4: a folder with no job.json is
               told audio from video by that name, app/jobs.py)
  joined.json  what joined.mp4 was built from

The cuts and the speed exist in the joined file only: dubbed.wav, the script
and every other download stay whole, and dubbed.wav is only ever read.

Plain `def` routes, so an upload and an ffmpeg run happen on FastAPI's worker
threads and never hold up the event loop.
"""
import contextlib
import hashlib
import json
import os
import shutil
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import media, media_preview, state
from app.api._launch import check_space
from app.api._shared import check_ranges_fit, parse_ranges, require_video, work_dir_of
from app.api.results import _target_code
from app.i18n import t
from app.jobs import JobStatus

router = APIRouter()

VIDEO, CUTS, BUILT, RECIPE = "join.mp4", "join.json", "joined.mp4", "joined.json"
# The speeds the dubbed sound can play at in the joined video: fixed steps,
# no free value (owner's decision).
TEMPOS = (0.5, 1.0, 1.5, 2.0, 3.0)


def _in_use() -> HTTPException:
    """What is answered when Windows will not replace or delete a file that
    is still open (the page playing it, a download reading it), even after
    media.when_free has waited: nothing was changed, and asking again works."""
    return HTTPException(status_code=409, detail=t("The video is still in use. Try again in a moment."))


def _job(jid: str) -> dict:
    job = state.job_store.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail=t("Unknown job: {jid}", jid=jid))
    return job


def _sound(job: dict) -> str:
    """The dubbed sound a video is joined with: the result of a finished
    audio project, on this computer. Anything else is told why not."""
    if job.get("media") != "audio":
        raise HTTPException(status_code=409, detail=t("Only for audio projects."))
    if job["status"] != JobStatus.DONE:
        raise HTTPException(status_code=409, detail=t("Job not finished yet"))
    out = (job.get("result") or {}).get("out_path")
    if not out or not os.path.exists(out):
        raise HTTPException(status_code=409, detail=t("Result file not found"))
    return out


def _read(path: str) -> Optional[dict]:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(path: str, data: dict) -> None:
    media_preview._write_atomic(path, json.dumps(data, ensure_ascii=False).encode("utf-8"))


def _forget(work: str, *names: str) -> None:
    """Remove these files of the folder, those that are there. One that
    cannot be removed yet (Windows, while something still reads it) is left,
    so the video itself is never removed this way: with join.json it is what
    says a video is in (join_video_remove)."""
    for name in names:
        with contextlib.suppress(OSError):
            os.remove(os.path.join(work, name))


def _cuts(work: str) -> Optional[dict]:
    """join.json as it was saved, or None when no video is in."""
    if not work or not os.path.exists(os.path.join(work, VIDEO)):
        return None
    return _read(os.path.join(work, CUTS))


def _recipe(work: str, sound: str, cuts: dict) -> dict:
    """Everything a joined file built now would be built from: each lane's
    kept parts, the speed, and when the two files were last written. A built
    file is fresh only while this equals the recipe kept beside it, so it is
    made again after a cut, another speed, a remade line (dubbed.wav is
    written again) and another video."""
    return {"video": cuts["video"], "audio": cuts["audio"], "tempo": cuts["tempo"],
            "video_written": os.stat(os.path.join(work, VIDEO)).st_mtime_ns,
            "sound_written": os.stat(sound).st_mtime_ns}


def _answer(work: str, sound: str, cuts: dict) -> dict:
    """What the page is told about a project with a video in. `stamp` is
    different after every change to what the joined file would be, for the
    address the page asks for it at."""
    recipe = json.dumps(_recipe(work, sound, cuts), sort_keys=True)
    return {"video": {"name": cuts["name"],
                      "seconds": round(media_preview._duration(os.path.join(work, VIDEO)), 3)},
            "audio_seconds": round(media_preview._duration(sound), 3),
            "ranges": {"video": cuts["video"], "audio": cuts["audio"]},
            "tempo": cuts["tempo"],
            "stamp": hashlib.md5(recipe.encode("utf-8")).hexdigest()[:12]}


@router.get("/api/dub/jobs/{jid}/join")
def join_get(jid: str):
    """The video brought into this project and how it is joined, or
    {"video": null} for a project with none, whatever kind it is: the page
    asks this of every project it opens."""
    job = _job(jid)
    work = work_dir_of(job)
    cuts = _cuts(work)
    if cuts is None:
        return {"video": None}
    return _answer(work, _sound(job), cuts)


@router.post("/api/dub/jobs/{jid}/join/video")
def join_video_bring(jid: str, video: UploadFile = File(...)):
    """Bring a video into a finished audio project, or another in its place.

    The file is written under a scratch name and asked what it is there: one
    with no picture is refused with 422 and not kept, and a video already in
    stays as it was, with its cuts. So it does when the new file cannot take
    its place (Windows, while the old one is still open somewhere), which is
    answered with 409 once the wait is over. A video that is taken starts
    whole and at normal speed, and a joined file built from the one before
    is removed.
    """
    job = _job(jid)
    sound = _sound(job)
    work = work_dir_of(job)
    check_space(work)
    dest = os.path.join(work, VIDEO)
    part = dest + ".part"
    try:
        with open(part, "wb") as f:
            shutil.copyfileobj(video.file, f)
        require_video(part)
        seconds = round(media_preview._duration(part), 3)
        if seconds <= 0:
            raise HTTPException(status_code=422, detail=t("That file does not look like a video."))
        try:
            media.when_free(os.replace, part, dest)
        except PermissionError:
            raise _in_use()
    finally:
        if os.path.exists(part):
            os.remove(part)
    _forget(work, RECIPE, BUILT)
    cuts = {"name": os.path.basename(video.filename or ""),
            "video": [[0.0, seconds]],
            "audio": [[0.0, round(media_preview._duration(sound), 3)]],
            "tempo": 1.0}
    _write(os.path.join(work, CUTS), cuts)
    return _answer(work, sound, cuts)


@router.delete("/api/dub/jobs/{jid}/join/video")
def join_video_remove(jid: str):
    """Take the video out again: its four files go, and the pictures the
    timeline drew of it (app/media_preview.py). Nothing else is touched.

    The video itself goes first. While it cannot (Windows, still open
    somewhere) nothing is removed and the answer is 409: join.json gone
    with join.mp4 still there would say no video is in, over one that is."""
    work = work_dir_of(_job(jid))
    if work:
        try:
            media.when_free(os.remove, os.path.join(work, VIDEO))
        except FileNotFoundError:
            pass
        except PermissionError:
            raise _in_use()
        _forget(work, CUTS, RECIPE, BUILT, VIDEO + ".filmstrip.jpg", VIDEO + ".waveform.json")
    return {"video": None}


@router.get("/api/dub/jobs/{jid}/join/video")
def join_video_get(jid: str):
    """The brought-in video, for the page's player (in pieces when asked)."""
    work = work_dir_of(_job(jid))
    if _cuts(work) is None:
        raise HTTPException(status_code=404, detail=t("That video is not on disk."))
    return FileResponse(os.path.join(work, VIDEO), media_type="video/mp4")


class JoinSave(BaseModel):
    # The timeline's kept parts of each lane, [[start, end], ...] in seconds
    # of that lane's own file. Checked by parse_ranges, not here, so a list
    # that makes no sense is answered with the sentence every cut gets.
    video: Any = None
    audio: Any = None
    tempo: Any = None       # one of TEMPOS


@router.put("/api/dub/jobs/{jid}/join")
def join_put(jid: str, body: JoinSave):
    """Save the kept parts of either lane and the speed; what is not sent
    stays as it was. Each lane's parts must end inside its own file: the
    brought-in video, and dubbed.wav. Nothing is saved unless all of it is
    right, and nothing is written when nothing changed."""
    job = _job(jid)
    sound = _sound(job)
    work = work_dir_of(job)
    cuts = _cuts(work)
    if cuts is None:
        raise HTTPException(status_code=409, detail=t("Bring in a video first."))
    new = dict(cuts)
    for lane, path in (("video", os.path.join(work, VIDEO)), ("audio", sound)):
        sent = getattr(body, lane)
        if sent is not None:
            new[lane] = parse_ranges(json.dumps(sent))
            check_ranges_fit(new[lane], path)
    if body.tempo is not None:
        # True equals 1 in Python and is not a speed.
        if isinstance(body.tempo, bool) or body.tempo not in TEMPOS:
            raise HTTPException(status_code=422, detail=t("The audio speed must be 0.5, 1, 1.5, 2 or 3."))
        new["tempo"] = float(body.tempo)
    if new != cuts:
        _write(os.path.join(work, CUTS), new)
    return _answer(work, sound, new)


@router.get("/api/dub/result/{jid}/joined")
def dub_result_joined(jid: str, download: int = 0):
    """The brought-in video with the dubbed sound, built on first ask and
    again whenever what it is built from has changed (_recipe).

    One build at a time for a project: a second ask waits and is served the
    same file. The recipe is read before the build starts, so a save that
    arrives while ffmpeg runs leaves a file that is already old, and the
    next ask builds it again. So does a new file that cannot take the old
    one's place (Windows, while a download still reads it): 409, and the old
    one stays whole.
    """
    job = _job(jid)
    sound = _sound(job)
    work = work_dir_of(job)
    built = os.path.join(work, BUILT)
    with media_preview._lock_for(built):
        cuts = _cuts(work)
        if cuts is None:
            raise HTTPException(status_code=409, detail=t("Bring in a video first."))
        recipe = _recipe(work, sound, cuts)
        if not os.path.exists(built) or _read(os.path.join(work, RECIPE)) != recipe:
            check_space(work)
            # A build that fails must not leave the old file looking as if
            # it had been built from a recipe saved before it.
            _forget(work, RECIPE)
            try:
                media.join_video(os.path.join(work, VIDEO), sound, built, recipe["video"], recipe["audio"],
                                 recipe["tempo"], what=t("Could not make the dubbed video"))
            except RuntimeError as e:
                raise HTTPException(status_code=503, detail=str(e))
            except PermissionError:
                raise _in_use()
            _write(os.path.join(work, RECIPE), recipe)
    headers = ({"Content-Disposition": 'attachment; filename="dub_%s.mp4"' % _target_code(job)}
               if download else None)
    return FileResponse(built, media_type="video/mp4", headers=headers)
