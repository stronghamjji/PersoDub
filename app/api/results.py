"""Everything a finished job hands back, and the subtitles that go on it:
the /api/dub/result downloads (dub, original, srt, subtitled, preview), the
per-job subtitle style, and the standalone /api/subtitles routes the Dub Agent
uses on any video file.

One module because they are one job: the burn helpers below (_norm_preset,
_write_burn_ass, _filter_path) draw the subtitles for the standalone burn, the
subtitled export and the Export dialog's preview alike.

Lifted out of app/main.py unchanged (2026-09-06). The four names it shares
with other routers come from the module that owns each: the job store from
app/state.py, the Perso client from app.perso_client, the key check from
app.engines_status, and work_dir_of from app/api/_shared.py. Those first three
are imported as MODULES and read at call time -- the tests fake them by
setting attributes on the module object, which every importer sees because
there is only ever one module object.
"""
import json
import math
import os
import re
import subprocess
import sys
from typing import Optional

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import engines_status, perso_client, state
from app.api._shared import free_path, work_dir_of
from app.perso_client import (
    PersoCreditExhaustedError,
    PersoInvalidKeyError,
    PersoUnavailableError,
    perso_to_cues,
)
from app.pipeline import _video_duration
from app.stt_local import transcribe_local
from app.subtitle_ass import PRESETS as SUBTITLE_PRESETS
from app.subtitle_ass import build_ass
from app.text.srt import build_srt

router = APIRouter()


# ---------------------------------------------------------------------------
# Subtitles out of a plain video file, through Perso STT. These two routes are
# the agent's extract_subtitles tool: /estimate names the price (nothing is
# spent), /extract does the paid work. The .srt lands next to the video and an
# existing file is never written over.
# ---------------------------------------------------------------------------

class SubtitleExtractRequest(BaseModel):
    video_path: str
    # "perso" (paid, better quality) or "local" (free Whisper on this machine).
    engine: str = "perso"


def _subtitle_video(video_path: str, engine: str) -> str:
    """The checks both routes share, ending in the file's real path."""
    if engine not in ("perso", "local"):
        raise HTTPException(status_code=422, detail=f"Unknown engine: {engine}")
    if engine == "perso" and not engines_status.perso_available():
        raise HTTPException(status_code=422,
                            detail="Perso is not set up. Add the API key in Settings first.")
    path = os.path.expanduser(video_path)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"No such video: {video_path}")
    return path


@router.get("/api/subtitles/estimate")
def subtitles_estimate(video_path: str, engine: str = "perso"):
    """What extracting this video's subtitles would cost, before spending it.

    Perso: about 1 credit per 5 seconds of video -- measured 2026-08-31,
    2 credits for a 10s clip. Local Whisper is free, so its estimate is 0.
    The balance is best-effort: a workspace that will not answer must not
    block the question.
    """
    path = _subtitle_video(video_path, engine)
    try:
        seconds = _video_duration(path)
    except Exception:
        raise HTTPException(status_code=422,
                            detail="That file does not look like a video.")
    if engine == "local":
        return {"seconds": seconds, "credits_estimate": 0, "credits_balance": None}
    balance = None
    try:
        ws = perso_client.PersoClient().describe_workspace()
        balance = ws.get("credits") if ws else None
    except Exception:
        pass
    return {"seconds": seconds,
            "credits_estimate": math.ceil(seconds / 5.0),
            "credits_balance": balance}


@router.post("/api/subtitles/extract")
def subtitles_extract(body: SubtitleExtractRequest):
    """Transcribe one video on Perso and write the result beside it as .srt.

    THIS SPENDS PERSO CREDITS. The confirmation lives in the agent tool (the
    same needs_confirmation pattern as change_speaker); by the time this route
    is called the user has already said yes.
    """
    path = _subtitle_video(body.video_path, body.engine)
    try:
        if body.engine == "local":
            cues = transcribe_local(path)
            if not cues:
                raise RuntimeError("Whisper heard no speech in this video.")
        else:
            cues = perso_to_cues(perso_client.PersoClient().transcribe(path))
            if not cues:
                raise RuntimeError("Perso heard no speech in this video.")
    except (PersoCreditExhaustedError, PersoInvalidKeyError, PersoUnavailableError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503,
                            detail=f"Could not transcribe this video ({str(e)[:120]}).")
    out = free_path(os.path.splitext(path)[0], ".srt")
    with open(out, "w", encoding="utf-8") as f:
        f.write(build_srt(cues))
    return {"srt_path": out, "lines": len(cues)}


class SubtitleBurnRequest(BaseModel):
    video_path: str
    srt_path: str = ""
    preset: str = "clean"
    pos: Optional[float] = None
    size: Optional[float] = None


# The font must hold Korean: each platform's own gothic, with Noto for the
# Linux server case. The presets themselves are the official plugin's ten,
# ported in app/subtitle_ass.py.
_BURN_FONT = ("Apple SD Gothic Neo" if sys.platform == "darwin"
              else "Malgun Gothic" if sys.platform == "win32"
              else "Noto Sans CJK KR")
# The first three styles shipped under our own names for a day (2026-09-01);
# anything stored or asked for under those keeps working.
_PRESET_ALIASES = {"variety": "neon-yellow", "box": "sticker"}


def _norm_preset(preset: str) -> str:
    preset = _PRESET_ALIASES.get(preset, preset)
    if preset not in SUBTITLE_PRESETS:
        raise HTTPException(status_code=422,
                            detail="preset must be one of: %s"
                                   % ", ".join(sorted(SUBTITLE_PRESETS)))
    return preset


def _video_dims(path: str):
    """The video's width and height, for drawing subtitles in its own
    coordinates. check_output on purpose: tests fake subprocess.run for the
    burn itself, and this probe must not be caught in that net. Unreadable
    file: a plain 1080p canvas -- fractions keep everything proportional."""
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
            text=True, timeout=30)
        w, h = (int(x) for x in out.strip().split(",")[:2])
        if w > 0 and h > 0:
            return w, h
    except Exception:
        pass
    return 1920, 1080


def _srt_cues(path: str):
    """The srt as [{start, end, text}], in block order."""
    with open(path, encoding="utf-8-sig") as f:
        blocks = f.read().split("\n\n")
    cues = []
    for block in blocks:
        m = _SRT_TIMING.search(block)
        if not m:
            continue
        h1, m1, s1, ms1, h2, m2, s2, ms2 = (int(g) for g in m.groups())
        text = block[m.end():].strip()
        cues.append({"start": h1 * 3600 + m1 * 60 + s1 + ms1 / 1000.0,
                     "end": h2 * 3600 + m2 * 60 + s2 + ms2 / 1000.0,
                     "text": text})
    return cues


def _write_burn_ass(srt: str, preset: str, pos, size, work: str, video: str,
                    box_width=None, line_widths=None) -> str:
    """The styled .ass beside the job, rebuilt for every burn (cheap)."""
    w, h = _video_dims(video)
    ass = build_ass(_srt_cues(srt), preset, width=w, height=h,
                    pos=pos, size=size, font=_BURN_FONT,
                    box_width=box_width, line_widths=line_widths)
    out = os.path.join(work, "subtitle_render.ass")
    with open(out, "w", encoding="utf-8") as f:
        f.write(ass)
    return out


def _filter_path(path: str) -> str:
    """A file path as ffmpeg's filter parser wants it.

    Inside -vf, backslash starts an escape, colon ends the argument and an
    apostrophe ends the quoted run -- all three appear in real paths (Windows
    drives, "it's.srt")."""
    return path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _check_pos_size(pos: Optional[float], size: Optional[float]) -> None:
    if pos is not None and not 0 <= pos <= 100:
        raise HTTPException(status_code=422, detail="pos must be between 0 and 100")
    if size is not None and not 50 <= size <= 300:
        raise HTTPException(status_code=422, detail="size must be between 50 and 300")


def _pos_size_suffix(pos: Optional[float], size: Optional[float]) -> str:
    """The cache-name tail: every position and size is its own file."""
    return (("" if pos is None else "-p%d" % round(pos))
            + ("" if size is None else "-s%d" % round(size)))


@router.post("/api/subtitles/burn")
def subtitles_burn(body: SubtitleBurnRequest):
    """Lay an .srt onto a video as a new file beside the original.

    The srt defaults to the video's own name next to it -- exactly where
    /api/subtitles/extract leaves one. Rendering text onto frames forces a
    re-encode (same x264 settings as the clip route); the audio is untouched
    and copied through.
    """
    preset = _norm_preset(body.preset)
    path = os.path.expanduser(body.video_path)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"No such video: {body.video_path}")
    base, ext = os.path.splitext(path)
    srt = os.path.expanduser(body.srt_path) if body.srt_path else base + ".srt"
    if not os.path.isfile(srt):
        raise HTTPException(status_code=404,
                            detail="No subtitle file to lay on. Extract subtitles "
                                   "first, or name an .srt file.")
    out = free_path("%s-sub-%s" % (base, preset), ext or ".mp4")
    _check_pos_size(body.pos, body.size)
    work = os.path.dirname(path)
    ass = _write_burn_ass(srt, preset, body.pos, body.size, work, path)
    vf = "ass=filename='%s'" % _filter_path(ass)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-i", path, "-vf", vf,
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "copy",
           "-movflags", "+faststart", out]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0:
        raise HTTPException(status_code=503,
                            detail="ffmpeg could not subtitle this video (%s)."
                                   % (run.stderr or "no detail")[-120:].strip())
    return {"out_path": out, "preset": preset}


def _target_code(job: dict) -> str:
    return job.get("language_code") or "out"


@router.get("/api/dub/result/{jid}")
def dub_result(jid: str):
    """Return the finished dubbed file."""
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if j["status"] != "done":
        raise HTTPException(status_code=409, detail="Job not finished yet")
    out = (j.get("result") or {}).get("out_path")
    if not out or not os.path.exists(out):
        raise HTTPException(status_code=404, detail="Result file not found")
    return FileResponse(out, media_type="video/mp4",
                        filename=f"dub_{_target_code(j)}.mp4")


@router.get("/api/dub/result/{jid}/original")
def dub_result_original(jid: str, download: int = 0):
    """Return this job's source video.

    Served for every job, running or finished: the running screen plays it
    blurred behind the progress card, and the finished screen puts it beside
    the dub. Read from the job's own workspace folder, which exists from the
    moment the job starts -- long before there is any result to look next to.

    ?download=1 (the "Download original" button) stays link-only: a file the
    user uploaded is already on their machine, so offering it back is noise;
    a video pulled from a link is the only original they cannot otherwise get.
    """
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if download and not j.get("from_link"):
        raise HTTPException(status_code=404,
                            detail="This job started from a file you already have")
    work_dir = work_dir_of(j)
    original = os.path.join(work_dir, "input.mp4") if work_dir else ""
    if not original or not os.path.exists(original):
        raise HTTPException(status_code=404, detail="Original file not found")
    return FileResponse(original, media_type="video/mp4", filename="org.mp4")


@router.api_route("/api/dub/result/{jid}/srt", methods=["GET", "HEAD"])
def dub_result_srt(jid: str, download: int = 0):
    """Return the translated subtitles used for the dub, as plain text.

    HEAD as well as GET: the Export dialog only needs to know whether this job
    has subtitles at all, and asking with GET downloaded the whole file to throw
    it away. FastAPI does not add HEAD to a GET route by itself.

    run_dub()'s result dict doesn't carry the srt path, but it
    always writes/copies it into the same job workspace folder as out_path, under
    one of two fixed names: "translated.srt" (auto-translated) or "sub.srt" (the
    caller's own pre-translated subtitles, see app/api/dub.py's dub_start). Looked up by
    filename here rather than changing run_dub's return shape.
    """
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if j["status"] != "done":
        raise HTTPException(status_code=409, detail="Job not finished yet")
    out = (j.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=404, detail="Result file not found")
    work_dir = os.path.dirname(out)
    # edited.srt first: once the user has fixed lines, THAT is the script the
    # remade voices speak, and the one every export should carry (2026-09-01).
    for name in ("edited.srt", "translated.srt", "sub.srt"):
        candidate = os.path.join(work_dir, name)
        if os.path.exists(candidate):
            with open(candidate, encoding="utf-8-sig") as f:
                text = f.read()
            headers = None
            if download:
                headers = {"Content-Disposition":
                           f'attachment; filename="dub_{_target_code(j)}.srt"'}
            return Response(content=text,
                            media_type="text/plain; charset=utf-8",
                            headers=headers)
    raise HTTPException(status_code=404, detail="Subtitle file not found")


def _subtitled_sources(jid: str):
    """The finished video and the script to lay on it, or the HTTPException
    that says why not. Shared by the subtitled export and its preview."""
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    if j["status"] != "done":
        raise HTTPException(status_code=409, detail="Job not finished yet")
    out = (j.get("result") or {}).get("out_path")
    if not out or not os.path.exists(out):
        raise HTTPException(status_code=404, detail="Result file not found")
    work = os.path.dirname(out)
    for name in ("edited.srt", "translated.srt", "sub.srt"):
        srt = os.path.join(work, name)
        if os.path.exists(srt):
            return j, out, srt, work
    raise HTTPException(status_code=404, detail="Subtitle file not found")


def _stale(built: str, *sources: str) -> bool:
    """The built file is missing, or something it was built from is newer."""
    if not os.path.exists(built):
        return True
    made = os.path.getmtime(built)
    return any(os.path.getmtime(src) > made for src in sources)


@router.get("/api/dub/result/{jid}/subtitled")
def dub_result_subtitled(jid: str, preset: Optional[str] = None, download: int = 0,
                         pos: Optional[float] = None, size: Optional[float] = None):
    """The dubbed video with its subtitles laid on, built on first ask.

    Lives in the job's own folder as subtitled-<preset>.mp4 and is served from
    there afterwards; a remade video or an edited script makes it stale and it
    is built again. The edited script wins over the original -- it is what the
    remade voices actually say.
    """
    j, out, srt, work, preset, pos, size, sources, stored = _resolved_burn_inputs(
        jid, preset, pos, size)
    built = os.path.join(work, "subtitled-%s%s.mp4" % (preset, _pos_size_suffix(pos, size)))
    if _stale(built, *sources):
        ass = _write_burn_ass(srt, preset, pos, size, work, out,
                              stored["boxWidth"], stored["widths"])
        run = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", out, "-vf", "ass=filename='%s'" % _filter_path(ass),
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-pix_fmt", "yuv420p", "-c:a", "copy",
             "-movflags", "+faststart", built],
            capture_output=True, text=True)
        if run.returncode != 0:
            raise HTTPException(status_code=503,
                                detail="ffmpeg could not subtitle this video (%s)."
                                       % (run.stderr or "no detail")[-120:].strip())
    filename = "dub_%s-sub-%s.mp4" % (_target_code(j), preset)
    headers = ({"Content-Disposition": 'attachment; filename="%s"' % filename}
               if download else None)
    return FileResponse(built, media_type="video/mp4", headers=headers)


_SUBTITLE_STYLE_DEFAULTS = {"enabled": True, "preset": "clean",
                            "pos": None, "size": None, "cues": {},
                            "boxWidth": None, "widths": {}}


def _subtitle_style_file(jid: str) -> str:
    j = state.job_store.get(jid)
    if j is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {jid}")
    out = (j.get("result") or {}).get("out_path")
    if not out:
        raise HTTPException(status_code=404, detail="Result file not found")
    return os.path.join(os.path.dirname(out), "subtitle_style.json")


def _load_subtitle_style(work: str) -> dict:
    try:
        with open(os.path.join(work, "subtitle_style.json"), encoding="utf-8") as f:
            return {**_SUBTITLE_STYLE_DEFAULTS, **json.load(f)}
    except (OSError, ValueError):
        return dict(_SUBTITLE_STYLE_DEFAULTS)


@router.get("/api/dub/jobs/{jid}/subtitle_style")
def subtitle_style_get(jid: str):
    """How this job's subtitles should look -- one truth shared by the player
    overlay, the timeline's subtitle lane and the Export dialog."""
    return _load_subtitle_style(os.path.dirname(_subtitle_style_file(jid)))


@router.put("/api/dub/jobs/{jid}/subtitle_style")
def subtitle_style_put(jid: str, body: dict):
    path = _subtitle_style_file(jid)
    merged = {**_SUBTITLE_STYLE_DEFAULTS,
              **{k: v for k, v in (body or {}).items() if k in _SUBTITLE_STYLE_DEFAULTS}}
    merged["preset"] = _norm_preset(merged["preset"])
    _check_pos_size(merged["pos"], merged["size"])
    if merged["boxWidth"] is not None and not 10 <= merged["boxWidth"] <= 100:
        raise HTTPException(status_code=422, detail="boxWidth must be between 10 and 100")
    if not isinstance(merged["widths"], dict):
        raise HTTPException(status_code=422, detail="widths must be an object")
    for k, w in merged["widths"].items():
        try:
            w = float(w)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"width {k} must be a number")
        if not 10 <= w <= 100:
            raise HTTPException(status_code=422, detail=f"width {k} must be between 10 and 100")
    if not isinstance(merged["cues"], dict):
        raise HTTPException(status_code=422, detail="cues must be an object")
    for k, cue in merged["cues"].items():
        try:
            start, end = float(cue["start"]), float(cue["end"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"cue {k} needs start and end")
        if not 0 <= start < end:
            raise HTTPException(status_code=422, detail=f"cue {k} must start before it ends")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False)
    return merged


_SRT_TIMING = re.compile(
    r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")


def _fmt_srt_time(sec: float) -> str:
    ms = round(sec * 1000)
    return "%02d:%02d:%02d,%03d" % (ms // 3600000, ms // 60000 % 60,
                                    ms // 1000 % 60, ms % 1000)


def _retimed_srt(srt: str, cues: dict, work: str) -> str:
    """The srt with the user's own timings on the lines they stretched or
    trimmed on the timeline (keyed 1-based, in block order). Written beside
    the original, which stays the record of what the dub said."""
    with open(srt, encoding="utf-8-sig") as f:
        blocks = f.read().split("\n\n")
    n = 0
    for i, block in enumerate(blocks):
        if not _SRT_TIMING.search(block):
            continue
        n += 1
        cue = cues.get(str(n))
        if cue:
            blocks[i] = _SRT_TIMING.sub(
                "%s --> %s" % (_fmt_srt_time(float(cue["start"])),
                               _fmt_srt_time(float(cue["end"]))), block, count=1)
    out = os.path.join(work, "subtitle_timed.srt")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n\n".join(blocks))
    return out


def _resolved_burn_inputs(jid, preset, pos, size):
    """Query params when given, the stored settings where not -- plus the srt
    (retimed if lines were), and every file the built result depends on."""
    _check_pos_size(pos, size)
    j, out, srt, work = _subtitled_sources(jid)
    stored = _load_subtitle_style(work)
    preset = _norm_preset(preset or stored["preset"])
    pos = stored["pos"] if pos is None else pos
    size = stored["size"] if size is None else size
    _check_pos_size(pos, size)
    style_file = os.path.join(work, "subtitle_style.json")
    sources = [out, srt] + ([style_file] if os.path.exists(style_file) else [])
    if stored["cues"]:
        srt = _retimed_srt(srt, stored["cues"], work)
    return j, out, srt, work, preset, pos, size, sources, stored


def _first_srt_second(srt: str) -> float:
    """When the first line appears, so the preview frame has words on it."""
    with open(srt, encoding="utf-8-sig") as f:
        m = re.search(r"(\d+):(\d+):(\d+)[,.](\d+)", f.read())
    if not m:
        return 0.0
    h, mnt, sec, ms = (int(g) for g in m.groups())
    return h * 3600 + mnt * 60 + sec + ms / 1000.0


@router.get("/api/dub/result/{jid}/subtitle_preview")
def dub_result_subtitle_preview(jid: str, preset: Optional[str] = None,
                                pos: Optional[float] = None,
                                size: Optional[float] = None):
    """One frame of the subtitled video, for the Export dialog's style cards.

    Seeked into the first subtitle line; -copyts keeps the original clock so
    the subtitles filter still knows a line is on screen at that moment.
    """
    j, out, srt, work, preset, pos, size, sources, stored = _resolved_burn_inputs(
        jid, preset, pos, size)
    built = os.path.join(work, "subtitle-preview-%s%s.jpg" % (preset, _pos_size_suffix(pos, size)))
    if _stale(built, *sources):
        at = _first_srt_second(srt) + 0.5
        ass = _write_burn_ass(srt, preset, pos, size, work, out,
                              stored["boxWidth"], stored["widths"])
        run = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-ss", "%.3f" % at, "-copyts", "-i", out,
             "-vf", "ass=filename='%s',scale=480:-2" % _filter_path(ass),
             "-frames:v", "1", "-q:v", "5", built],
            capture_output=True, text=True)
        if run.returncode != 0:
            raise HTTPException(status_code=503,
                                detail="ffmpeg could not draw the preview (%s)."
                                       % (run.stderr or "no detail")[-120:].strip())
    return FileResponse(built, media_type="image/jpeg")
