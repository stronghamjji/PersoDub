#!/usr/bin/env python3
"""PersoDub's regression run: the core user flows, driven through a running
app's HTTP API, each one timed and checked with numbers.

    python tests/e2e/regress.py --base http://127.0.0.1:52252 \\
        --clip paris-en-subs-10s.mp4 --subs-clip paris-en-subs-10s.mp4 --out runs/today \\
        [--translator hunyuan] [--perso] [--srt paris-ko-3cues.srt] [--kit <kit>] [--logs <logs>]

Every route is asked in the shape the page asks it (ui/src/dubApi.mjs,
ui/src/exportDialog.mjs), so a change that breaks the page's own requests
fails here before it ships. Not a pytest module -- no test_ prefix, so
`pytest tests/` never collects it: it needs a live app with its models and
minutes of real work, where the suite beside it is pure logic. Standard
library only, so it runs beside any install without installing anything;
ffprobe measures the files the app hands back. tests/e2e/README.md lists
what each step checks.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime

# How far a result's length may be from its input's: a dub keeps the video's
# picture, so more than a second off is a cut or a padded ending.
TOLERANCE = 1.0
# A 10-second clip still running after half an hour is stuck. Its clock starts
# when the job leaves the line: the app runs one local job at a time and
# someone else's may be ahead of ours, which the second limit is for.
RUN_TIMEOUT = 30 * 60
QUEUE_TIMEOUT = 60 * 60
POLL_SECONDS = 5
LOG_TAIL = 20

# What the page reads off GET /api/engines and GET /api/settings.
ENGINE_FIELDS = ("gemma_available", "qwen_available", "hunyuan_available", "gemini_available",
                 "perso_available", "voice_models", "eraser_available", "local_engines", "ram_ok")
SETTINGS_FIELDS = ("gemini_key_set", "perso_key_set", "gemini_api_key", "perso_api_key", "perso_space_seq",
                   "perso_signup_link", "perso_workspace_link", "analytics_off", "reports_off",
                   "ui_language", "workspace", "app_version")
# What the script table's length column and the timeline read off each line
# (ui/src/scriptTable.mjs lineVerdict).
VERDICT_FIELDS = ("line", "slot", "audio_sec", "estimated", "fits")
# The four steps of a dub the usage count times, by the names the job record
# keeps them under (app/jobs.py timed_step, desktop/src/analytics.js STAGE_FIELDS).
TIMED_STAGES = ("separate", "transcribe", "translate", "synthesize")
# The subtitle file the captions step brings with the clip: three lines, all
# inside its first ten seconds.
CUES = ((0.5, 3.0, "The first line"), (3.5, 6.0, "The second line"), (6.5, 9.0, "The third line"))
# The translators the app keeps out of every choice list (app/engines_status.py
# TRANSLATORS offered=False, and app/translate.py's vertex, which has no row).
HIDDEN_TRANSLATORS = ("qwen", "vertex")
# A voice the app speaks on its own must be longer than this to be words.
MIN_SAY_SECONDS = 0.5

BASE = ""            # the app, from --base
FFPROBE = "ffprobe"  # find_ffprobe's answer


class Fail(Exception):
    """A step's check did not hold; the message is the evidence."""


class Skip(Exception):
    """A step that does not apply to this run; the message says why."""


# ---------------------------------------------------------------------------
# Talking to the app
# ---------------------------------------------------------------------------

def api(method, path, json_body=None, form=None, upload=None, timeout=120):
    """One request to the app: (status, body), the body parsed when it is JSON
    and its text when not. An HTTP error is an answer here, not an exception:
    each step judges the status itself."""
    data, headers = None, {}
    if json_body is not None:
        data, headers = json.dumps(json_body).encode(), {"Content-Type": "application/json"}
    elif form is not None:
        data, content_type = multipart(form, upload)
        headers = {"Content-Type": content_type}
    request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def multipart(form, upload=None):
    """A multipart/form-data body, which urllib has no builder for: the form's
    fields, then `upload` = (field, file name, path[, type]) when there is a
    file; a video unless the type says otherwise."""
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in form.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    if upload:
        field, filename, path, kind = (*upload, "video/mp4")[:4]
        with open(path, "rb") as f:
            body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; '
                     f'filename="{filename}"\r\nContent-Type: {kind}\r\n\r\n').encode() + f.read() + b"\r\n"
    return body + f"--{boundary}--\r\n".encode(), "multipart/form-data; boundary=" + boundary


def fetch(path, dest, timeout=600, headers=None):
    """GET a file the app hands out, into dest: (status, the bytes written or
    the refusal's words). A `headers` dict is filled with the answer's headers."""
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
            if headers is not None:
                headers.update(r.headers.items())
            return r.status, f.tell()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300]


def detail(body):
    """A refusal's words, short enough for a table cell."""
    said = body.get("detail", body) if isinstance(body, dict) else body
    # The 409 that asks for downloads is a payload for a dialog: its ids are the news.
    if isinstance(said, dict) and "missing" in said:
        said = "models needed: " + ", ".join(str(m.get("id")) for m in said["missing"])
    return " ".join(str(said).split())[:200]


def find_ffprobe():
    """ffprobe, or None: PERSODUB_FFPROBE when it is set, then the kit's own
    copy, then PATH. The kit's copy is <kit>/bin, the folder the desktop shell
    puts on the app's PATH; it is found from the Python running this script
    when that is the kit's (<kit>/python/... or <kit>/app_venv/...), which is
    how a Windows computer with no ffprobe of its own runs this."""
    if os.environ.get("PERSODUB_FFPROBE"):
        return os.environ["PERSODUB_FFPROBE"]
    exe = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    folder = os.path.dirname(os.path.abspath(sys.executable))
    for _ in range(3):
        folder = os.path.dirname(folder)
        # kit.env beside bin is what says this folder is a kit, not /usr.
        if os.path.isfile(os.path.join(folder, "kit.env")) and os.path.isfile(os.path.join(folder, "bin", exe)):
            return os.path.join(folder, "bin", exe)
    return shutil.which("ffprobe")


def seconds(path):
    """A media file's length in seconds, as ffprobe reads it."""
    run = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=noprint_wrappers=1:nokey=1", path],
                         capture_output=True, text=True)
    if run.returncode != 0:
        raise Fail(f"ffprobe could not read {os.path.basename(path)}: {detail(run.stderr)}")
    return float(run.stdout.strip())


def same_length(label, path, want):
    """The evidence that the file at `path` is as long as the input, or Fail."""
    got = seconds(path)
    if abs(got - want) > TOLERANCE:
        raise Fail(f"{label} is {got:.2f}s, the input {want:.2f}s (allowed {TOLERANCE}s)")
    return f"{label} {got:.2f}s"


def cue_count(path):
    """How many cues an .srt holds: one "-->" each."""
    with open(path, encoding="utf-8-sig") as f:
        return f.read().count("-->")


def srt_time(sec):
    return "%02d:%02d:%02d,%03d" % (sec // 3600, sec % 3600 // 60, sec % 60, round(sec % 1 * 1000))


def cues_file(ctx):
    """The three CUES written out as files/captions.srt; its path."""
    srt = os.path.join(ctx["files"], "captions.srt")
    with open(srt, "w", encoding="utf-8") as f:
        f.write("\n".join(f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n" for n, (a, b, text) in enumerate(CUES, 1)))
    return srt


def srt_texts(path):
    """Each cue's words in an .srt, in order: what follows its time line."""
    with open(path, encoding="utf-8-sig") as f:
        blocks = f.read().replace("\r\n", "\n").strip().split("\n\n")
    return [flat(" ".join(block.split("\n")[2:])) for block in blocks if "-->" in block]


def held(ctx, path):
    """The clip's id in the app's holding area, where the New project screen
    puts a dropped file (POST /api/downloads/upload) before any job uses it.
    Uploaded once per clip; every job after that names it, as the page does."""
    if path not in ctx["held"]:
        name = "e2e-" + os.path.basename(path)
        status, body = api("POST", "/api/downloads/upload", form={"duration_sec": f"{seconds(path):.3f}"},
                           upload=("video", name, path), timeout=600)
        if status != 200:
            raise Fail(f"the app would not hold {name}: HTTP {status} {detail(body)}")
        ctx["held"][path] = body["id"]
    return ctx["held"][path]


def started(ctx, status, body):
    """The job a start answered with, remembered so a failure's report can
    carry its log -- or Fail with the refusal's words."""
    if status != 200:
        raise Fail(f"start refused: HTTP {status} {detail(body)}")
    ctx["job"] = body["job_id"]
    return ctx["job"]


def wait_for(jid, what):
    """Follow a job to its end: (its record, seconds it waited in line).

    Every kind of job is read at GET /api/dub/jobs/{id}: dubs, erases and
    separations share one store. A job that overruns is cancelled, so a stuck
    run of ours does not hold up anybody else's.
    """
    joined = time.monotonic()
    began = None
    shown = None
    while True:
        status, job = api("GET", f"/api/dub/jobs/{jid}")
        if status != 200:
            raise Fail(f"lost track of {what} job {jid}: HTTP {status} {detail(job)}")
        now = time.monotonic()
        if job["status"] in ("done", "error", "cancelled"):
            break
        if job["status"] != "queued" and began is None:
            began = now
        since, limit = (joined, QUEUE_TIMEOUT) if began is None else (began, RUN_TIMEOUT)
        if now - since > limit:
            api("POST", f"/api/dub/jobs/{jid}/cancel")
            raise Fail(f"{what} job {jid} still {job['status']} after {limit // 60} min; cancelled it")
        line = ((job.get("logs") or [""])[-1])[:110]
        if (job["status"], line) != shown:
            print(f"    {what} {jid} {job['status']}: {line}", flush=True)
            shown = (job["status"], line)
        time.sleep(POLL_SECONDS)
    if job["status"] != "done":
        raise Fail(f"{what} job {jid} ended {job['status']}: {detail(job.get('error') or 'no error recorded')}")
    # A job that started and ended between two looks was never seen running:
    # all of its time counts as waiting, which only overstates the wait.
    return job, (now if began is None else began) - joined


def ran(job, queued):
    return f"job {job['id']} ran {job.get('elapsed_seconds')}s after {queued:.0f}s in line"


# ---------------------------------------------------------------------------
# The steps, in the order they run. Each returns its evidence, or raises Fail
# or Skip; run_step times it and writes the row.
# ---------------------------------------------------------------------------

def step_answers(ctx):
    """GET /api/engines and GET /api/settings answer with every field the page reads."""
    status_e, engines = api("GET", "/api/engines")
    status_s, settings = api("GET", "/api/settings")
    if status_e != 200 or status_s != 200:
        raise Fail(f"/api/engines HTTP {status_e}, /api/settings HTTP {status_s} {detail(settings)}")
    missing = [f for f in ENGINE_FIELDS if f not in engines] + [f for f in SETTINGS_FIELDS if f not in settings]
    if missing:
        raise Fail("missing: " + ", ".join(missing))
    # Kept for the Perso and settings steps. It holds the saved keys, so it is
    # never written out: only the flags below reach the report.
    ctx["settings"] = settings
    voice = (engines["local_engines"].get("voice") or {}).get("state")
    return (f"engines: all {len(ENGINE_FIELDS)} fields, eraser_available={engines['eraser_available']}, "
            f"voice engine {voice}, ram_ok={engines['ram_ok']}; settings: all {len(SETTINGS_FIELDS)} fields, "
            f"app {settings['app_version']}, perso_key_set={settings['perso_key_set']}, "
            f"ui_language={settings['ui_language']}")


def start_dub(ctx, dub_mode, project, upload=None, **fields):
    """POST /api/dub/start with the form the New project dialog builds
    (ui/src/dubApi.mjs buildDubFormData) for the held clip: English to Korean,
    Fast. Transcription and separation are named outright, because a blank
    means the saved default, which may be Perso and would spend credits on a
    run that is meant to stay on this computer; a Perso dubbing ignores both
    (the cloud does every stage). The translator is --translator, sent the
    way the dialog's Translation dropdown sends a choice; without it the
    field stays blank and the saved one translates. Its evidence names which.
    `upload` is a file sent with it (the advanced options' subtitle file),
    `fields` more of the dialog's fields (num_speakers)."""
    form = {"download_id": held(ctx, ctx["args"].clip), "language": "Korean", "language_code": "ko",
            "source_language_code": "en", "n_takes": "1", "stt_engine": "local", "sep_engine": "local",
            "dub_mode": dub_mode, "project": project, **fields}
    if ctx["args"].translator:
        form["translate_engine"] = ctx["args"].translator
    return started(ctx, *api("POST", "/api/dub/start", form=form, upload=upload, timeout=600))


def finished_video(ctx, jid, name):
    """The finished dub's video, fetched into files/<name> and measured
    against the clip: the evidence, or Fail."""
    video = os.path.join(ctx["files"], name)
    status, got = fetch(f"/api/dub/result/{jid}", video)
    if status != 200:
        raise Fail(f"GET /api/dub/result/{jid}: HTTP {status} {got}")
    return same_length("dubbed video", video, ctx["clip_sec"])


def flat(text):
    """Text with its runs of spaces and line breaks made one space."""
    return " ".join(str(text or "").split())


def step_local_dub(ctx):
    """A dubbing on this computer to its end: a video as long as the clip, and
    a script whose every line has a voice and what the page judges it by."""
    jid = start_dub(ctx, "local", "e2e-dub")
    job, queued = wait_for(jid, "dub")
    ctx["dub_done"] = jid
    video = os.path.join(ctx["files"], "dub.mp4")
    status, got = fetch(f"/api/dub/result/{jid}", video)
    if status != 200:
        raise Fail(f"GET /api/dub/result: HTTP {status} {got}")
    length = same_length("dubbed video", video, ctx["clip_sec"])
    status, script = api("GET", f"/api/dub/jobs/{jid}/script")
    if status != 200:
        raise Fail(f"GET script: HTTP {status} {detail(script)}")
    lines = script.get("lines") or []
    if not lines:
        raise Fail("the script has no lines")
    # audio_sec is the voice's own length on disk: a line without one is a
    # line the dub left silent.
    unvoiced = [line.get("line") for line in lines
                if not isinstance(line.get("audio_sec"), (int, float)) or any(k not in line for k in VERDICT_FIELDS)]
    if unvoiced or "clipped" not in script:
        raise Fail(f"lines without a voice length or a verdict field: {unvoiced}; "
                   f"clipped list {'there' if 'clipped' in script else 'missing'}")
    fit = sum(1 for line in lines if line["fits"])
    return (f"{ran(job, queued)}, translator {job.get('translator')}; {length}, input {ctx['clip_sec']:.2f}s; "
            f"script {len(lines)} lines, all voiced, {fit} fit their slot, {len(script['clipped'] or [])} cut")


def step_separate(ctx):
    """Separate audio on this computer: a voice and a background, each as long as the clip."""
    form = {"download_id": held(ctx, ctx["args"].clip), "engine": "local", "project": "e2e-separate"}
    jid = started(ctx, *api("POST", "/api/separate", form=form, timeout=600))
    job, queued = wait_for(jid, "separate")
    status, record = api("GET", f"/api/separate/{jid}")
    if status != 200 or not record.get("done"):
        raise Fail(f"its voice and background are not both on disk (HTTP {status}, done={record.get('done')})")
    said = []
    # The links the Export dialog saves the two sounds by, as mp3, its default.
    for which in ("voice", "background"):
        path = os.path.join(ctx["files"], f"separate-{which}.mp3")
        status, got = fetch(f"/api/dub/result/{jid}/stem/{which}?format=mp3", path)
        if status != 200:
            raise Fail(f"{which}: HTTP {status} {got}")
        said.append(same_length(which, path, ctx["clip_sec"]))
    return f"{ran(job, queued)}, {job.get('separation_model')}; " + ", ".join(said)


def step_erase(ctx):
    """Erase subtitles in the band the app guesses, which lies in the bottom
    third of the picture where the fixture's captions are (90 px above the
    bottom edge, 630 of 720); the eraser's own look at the finished video
    finding no writing left (job.check), and that video as long as the clip."""
    did = held(ctx, ctx["args"].subs_clip)
    status, found = api("POST", "/api/erase/suggest", form={"download_id": did}, timeout=600)
    if status != 200:
        raise Fail(f"suggest: HTTP {status} {detail(found)}")
    if not found.get("found"):
        raise Fail(f"suggest found no subtitles (it offers the bottom band {found.get('area')})")
    # The area is [ymin, ymax, xmin, xmax], rows first.
    top, bottom, height = found["area"][0], found["area"][1], found["height"]
    if not (top >= height * 2 / 3 and top <= height - 90 <= bottom <= height):
        raise Fail(f"the band is rows {top}-{bottom} of {height}: not in the bottom third "
                   f"(from {height * 2 / 3:.0f}) around the captions at {height - 90}")
    form = {"download_id": did, "area": json.dumps(found["area"]), "project": "e2e-erase"}
    jid = started(ctx, *api("POST", "/api/erase", form=form, timeout=600))
    job, queued = wait_for(jid, "erase")
    status, record = api("GET", f"/api/erase/{jid}")
    if status != 200 or not record.get("done"):
        raise Fail(f"erased.mp4 is not there (HTTP {status}, done={record.get('done')})")
    check = record.get("check") or {}
    if check.get("frames_with_text") != 0:
        raise Fail(f"frames_with_text {check.get('frames_with_text')} of {check.get('frames_checked')} checked")
    erased = os.path.join(ctx["files"], "erased.mp4")
    status, got = fetch(f"/api/erase/{jid}/video", erased)
    if status != 200:
        raise Fail(f"GET /api/erase/{jid}/video: HTTP {status} {got}")
    length = same_length("erased.mp4", erased, ctx["subs_sec"])
    return (f"area {found['area']} of {found['width']}x{found['height']}, rows {top}-{bottom} in the bottom third "
            f"(from {height * 2 / 3:.0f}) around {height - 90}; {ran(job, queued)}; {length}, input "
            f"{ctx['subs_sec']:.2f}s; frames_with_text 0 of {check.get('frames_checked')} checked, "
            f"{check.get('repainted')} repainted")


def step_export(ctx):
    """Every row the Export dialog offers for the finished dub, asked for the
    way the dialog asks (ui/src/exportDialog.mjs exportRows, ui/src/app.mjs
    exportContext). In the app the browser or the desktop shell then writes
    the file into Downloads; that half is not the backend's and is not run
    here. Original video is a link job's row only, and these clips are files."""
    jid = ctx.get("dub_done")
    if not jid:
        raise Skip("needs step 2's finished dub")
    _, job = api("GET", f"/api/dub/jobs/{jid}")
    target = job.get("language_code") or "out"
    srt_status, _ = api("HEAD", f"/api/dub/result/{jid}/srt")
    _, stems = api("GET", f"/api/dub/result/{jid}/stems")
    if srt_status != 200 or not (stems.get("voice") and stems.get("background")):
        # The page would only leave these rows out; on a local dub that is a fault.
        raise Fail(f"a local dub offers its subtitles and both sounds: srt HTTP {srt_status}, stems {stems}")
    # The subtitled video comes in the look saved on the work screen.
    _, style = api("GET", f"/api/dub/jobs/{jid}/subtitle_style")
    preset = style.get("preset") or "clean"
    look = "".join(f"&{k}={style[k]}" for k in ("pos", "size") if style.get(k) is not None)
    base = f"/api/dub/result/{jid}"
    rows = [("dubbed video", base, f"dub_{target}.mp4"),
            ("subtitled video", f"{base}/subtitled?preset={preset}{look}&download=1", f"dub_{target}-sub-{preset}.mp4"),
            ("dubbed audio", f"{base}/audio?format=mp3&download=1", f"dub_{target}.mp3"),
            ("original voice", f"{base}/stem/voice?format=mp3", f"{job['project']}_voice.mp3"),
            ("background", f"{base}/stem/background?format=mp3", f"{job['project']}_background.mp3"),
            ("subtitles", f"{base}/srt?download=1", f"dub_{target}.srt")]
    said = []
    for label, href, name in rows:
        path = os.path.join(ctx["export"], name)
        status, got = fetch(href, path)
        if status != 200:
            raise Fail(f"{label}: HTTP {status} {got}")
        if name.endswith(".srt"):
            with open(path, encoding="utf-8-sig") as f:
                cues = f.read().count("-->")
            if not cues:
                raise Fail("the subtitles file has no cues")
            said.append(f"{label} {cues} cues")
        else:
            said.append(same_length(label, path, ctx["clip_sec"]))
    said.append(script_sheet(ctx, jid, job))
    return f"{len(rows) + 1} rows: " + ", ".join(said) + "; the desktop shell's save to Downloads not run"


def script_sheet(ctx, jid, job):
    """The Export dialog's script row (exportDialog.mjs, id "script"): a
    workbook whose one sheet has the header and a row per script line, named
    <project>_<SRC>to<TGT>_OriginalTranslatedScript.xlsx by the route itself."""
    _, script = api("GET", f"/api/dub/jobs/{jid}/script")
    lines = len(script.get("lines") or [])
    path = os.path.join(ctx["export"], "script.xlsx")
    headers = {}
    status, got = fetch(f"/api/dub/jobs/{jid}/script.xlsx", path, headers=headers)
    if status != 200:
        raise Fail(f"script (.xlsx): HTTP {status} {got}")
    said = headers.get("content-disposition") or headers.get("Content-Disposition") or ""
    name = urllib.parse.unquote(said.split("''", 1)[1]) if "''" in said else said
    want = (f"{job.get('title') or job['project']}_{(job.get('source_lang') or 'auto').upper()}to"
            f"{(job.get('language_code') or 'out').upper()}_OriginalTranslatedScript.xlsx")
    if name != want:
        raise Fail(f"script (.xlsx) is named {name!r}, not {want!r}")
    try:
        with zipfile.ZipFile(path) as z:
            sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    except (zipfile.BadZipFile, KeyError) as e:
        raise Fail(f"script (.xlsx) is not a workbook with xl/worksheets/sheet1.xml: {e}")
    rows = len(re.findall(r"<row ", sheet))
    if rows != lines + 1 or "speaker_id" not in sheet.split("</row>", 1)[0]:
        raise Fail(f"script (.xlsx) has {rows} rows for {lines} lines and a header")
    os.replace(path, os.path.join(ctx["export"], name))
    return f"script (.xlsx) {rows} rows = header + {lines} lines, named {name}"


def step_perso(ctx):
    """A Perso cloud dubbing of the same clip -- only when asked, because it spends credits."""
    if not ctx["args"].perso:
        raise Skip("--perso not given")
    if not (ctx.get("settings") or {}).get("perso_key_set"):
        raise Skip("no Perso key")
    jid = start_dub(ctx, "perso", "e2e-dub-perso")
    job, queued = wait_for(jid, "perso dub")
    video = os.path.join(ctx["files"], "dub-perso.mp4")
    status, got = fetch(f"/api/dub/result/{jid}", video)
    if status != 200:
        raise Fail(f"GET /api/dub/result: HTTP {status} {got}")
    length = same_length("dubbed video", video, ctx["clip_sec"])
    # A Perso dub's script is read back from Perso itself, so its lines carry
    # no voice length of their own yet: their number is what is checked.
    status, script = api("GET", f"/api/dub/jobs/{jid}/script")
    lines = (script.get("lines") if status == 200 else None) or []
    if not lines:
        raise Fail(f"script: HTTP {status}, no lines {detail(script)}")
    return f"{ran(job, queued)}, {job.get('perso_credits')} credits; {length}; script {len(lines)} lines"


def step_settings(ctx):
    """A setting written, read back, and put back: the interface language,
    turned from "auto" to the language the engine already speaks (or from a
    chosen language to "auto") for the moment it takes to read it. The keys
    and the two privacy switches are left alone: a key changed even briefly
    can fail somebody's dub, and a switch written back as "0" can turn the
    counting on where it was only ever off by the environment."""
    status, now = api("GET", "/api/settings")
    if status != 200:
        raise Fail(f"GET /api/settings: HTTP {status} {detail(now)}")
    before = now["ui_language"]
    # Which language the engine speaks, from a refusal it words in it: asking
    # for a job that cannot exist changes nothing.
    _, probe = api("GET", "/api/dub/jobs/e2e-no-such-job")
    speaking = "en" if detail(probe).startswith("Unknown job") else "ko"
    flipped = speaking if before == "auto" else "auto"

    def write(value):
        status, _ = api("POST", "/api/settings", json_body={"ui_language": value})
        _, back = api("GET", "/api/settings")
        return status, back.get("ui_language") if isinstance(back, dict) else None

    try:
        wrote = write(flipped)
    finally:
        put_back = write(before)
    if wrote != (200, flipped):
        raise Fail(f"wrote ui_language={flipped}: HTTP {wrote[0]}, reads back {wrote[1]}")
    if put_back != (200, before):
        raise Fail(f"could not put ui_language back to {before}: HTTP {put_back[0]}, reads {put_back[1]}")
    return f"ui_language {before} -> {flipped} -> {before}, each read back"


def step_timings(ctx):
    """The finished dub's record carries how long it took, the numbers the
    usage count sends (desktop/src/analytics.js timingSeconds): its whole
    seconds and each of the four timed steps', every one above 0 and the four
    together no longer than the whole."""
    jid = ctx.get("dub_done")
    if not jid:
        raise Skip("needs step 2's finished dub")
    status, job = api("GET", f"/api/dub/jobs/{jid}")
    if status != 200:
        raise Fail(f"GET /api/dub/jobs/{jid}: HTTP {status} {detail(job)}")
    whole, stages = job.get("elapsed_seconds"), job.get("stage_seconds") or {}
    got = {name: stages.get(name) for name in TIMED_STAGES}
    bad = [name for name, n in got.items() if not isinstance(n, int) or n <= 0]
    if not isinstance(whole, int) or whole <= 0 or bad:
        raise Fail(f"elapsed_seconds {whole}, stage_seconds {stages}: not a whole number above 0 for "
                   + ", ".join(bad or ["elapsed_seconds"]))
    if sum(got.values()) > whole + 1:
        raise Fail(f"the four steps add up to {sum(got.values())}s, more than the whole {whole}s")
    return (f"job {jid}: elapsed_seconds {whole}; " + ", ".join(f"{name} {n}s" for name, n in got.items())
            + f" (together {sum(got.values())}s); started_hour {job.get('started_hour')}")


def step_captions(ctx):
    """The Subtitle style tab on its own: the held clip and a subtitle file of
    three lines made a finished project of kind "captions" (POST
    /api/captions/import, as ui/src/dubApi.mjs importCaptions sends it), whose
    two rows the Export dialog offers: the video in the Sticker look, as long
    as the clip, and the .srt with its three cues. A file with no subtitles is
    refused with 422, a video that is not held with 404."""
    srt = cues_file(ctx)
    junk = os.path.join(ctx["files"], "not-subtitles.srt")
    with open(junk, "w", encoding="utf-8") as f:
        f.write("no cues here\n")
    did = held(ctx, ctx["args"].clip)

    def send(download_id, path):
        return api("POST", "/api/captions/import", form={"download_id": download_id},
                   upload=("srt", os.path.basename(path), path, "application/x-subrip"), timeout=600)

    status, body = send(did, srt)
    jid = started(ctx, status, body)
    status, job = api("GET", f"/api/dub/jobs/{jid}")
    if status != 200 or job.get("kind") != "captions" or job.get("status") != "done" or body.get("lines") != len(CUES):
        raise Fail(f"job {jid}: HTTP {status}, kind {job.get('kind')}, {job.get('status')}, "
                   f"{body.get('lines')} lines of {len(CUES)}")
    video = os.path.join(ctx["export"], "video-sub-sticker.mp4")
    status, got = fetch(f"/api/dub/result/{jid}/subtitled?preset=sticker&download=1", video)
    if status != 200:
        raise Fail(f"video with subtitles: HTTP {status} {got}")
    length = same_length("video with subtitles (sticker)", video, ctx["clip_sec"])
    path = os.path.join(ctx["export"], "video.srt")
    status, got = fetch(f"/api/dub/result/{jid}/srt?download=1", path)
    if status != 200:
        raise Fail(f"subtitles: HTTP {status} {got}")
    cues = cue_count(path)
    if cues != len(CUES):
        raise Fail(f"the subtitles file has {cues} cues, not {len(CUES)}")
    bad, _ = send(did, junk)
    missing, _ = send("e2e-no-such-download", srt)
    if (bad, missing) != (422, 404):
        raise Fail(f"a file with no subtitles answered HTTP {bad} (not 422), a video not held HTTP {missing} (not 404)")
    return (f"job {jid} kind captions, done at once, {len(CUES)} lines; {length}, input {ctx['clip_sec']:.2f}s; "
            f"subtitles {cues} cues; no subtitles in the file HTTP 422, video not held HTTP 404")


def step_edition(ctx):
    """Which edition the app answers as: GET /api/setup's default Dubbing
    mode is "local", the open-source edition's (app/setup.py _fallback; the
    production edition's is "perso"), and with --kit, kit.env holds no
    PERSODUB_EDITION=production line."""
    status, setup = api("GET", "/api/setup")
    if status != 200:
        raise Fail(f"GET /api/setup: HTTP {status} {detail(setup)}")
    mode = (setup.get("defaults") or {}).get("dub_mode")
    if mode != "local":
        raise Fail(f"the default Dubbing mode is {mode!r}, not 'local'")
    said = f"defaults.dub_mode local, choices {setup['choices']['dub_mode']}"
    if not ctx["args"].kit:
        return said + "; kit.env not read (no --kit)"
    with open(os.path.join(ctx["args"].kit, "kit.env"), encoding="utf-8") as f:
        editions = [line.strip() for line in f if line.strip().startswith("PERSODUB_EDITION=")]
    production = [line for line in editions if line.split("=", 1)[1].strip() == "production"]
    if production:
        raise Fail(f"kit.env has {len(production)} PERSODUB_EDITION=production line(s)")
    return said + f"; kit.env: 0 production lines, edition lines {editions or 'none'}"


def step_srt_dub(ctx):
    """A dub started with a subtitle file attached (the advanced options'
    "srt", ui/src/dubApi.mjs: pre-translated, used as is): no translation
    runs (stage_seconds.translate 0 or absent), its script's lines are the
    file's cues word for word, and its video is as long as the clip. Speech
    is still transcribed, for the speakers: that stage's time is reported."""
    path = ctx["args"].srt or cues_file(ctx)
    want = srt_texts(path)
    jid = start_dub(ctx, "local", "e2e-dub-srt",
                    upload=("srt", os.path.basename(path), path, "application/x-subrip"))
    job, queued = wait_for(jid, "dub with subtitles")
    stages = job.get("stage_seconds") or {}
    if stages.get("translate"):
        raise Fail(f"translate took {stages['translate']}s with the subtitles given")
    _, script = api("GET", f"/api/dub/jobs/{jid}/script")
    got = [flat(line.get("text")) for line in script.get("lines") or []]
    if got != want:
        raise Fail(f"the script's {len(got)} lines {got} are not the file's {len(want)} cues {want}")
    length = finished_video(ctx, jid, "dub-srt.mp4")
    return (f"{ran(job, queued)}; translate {stages.get('translate', 'absent')}, transcribe "
            f"{stages.get('transcribe', 'absent')}s; script {len(got)} lines = the {len(want)} cues of "
            f"{os.path.basename(path)}; {length}")


def step_redub(ctx):
    """POST /api/dub/jobs/{id}/redub on step 2's finished dub: a new job,
    made on this computer, whose video is as long as the clip."""
    first = ctx.get("dub_done")
    if not first:
        raise Skip("needs step 2's finished dub")
    jid = started(ctx, *api("POST", f"/api/dub/jobs/{first}/redub", timeout=600))
    if jid == first:
        raise Fail(f"redub answered the same job {jid}")
    job, queued = wait_for(jid, "redub")
    if job.get("dub_mode") != "local":
        raise Fail(f"the redub's dub_mode is {job.get('dub_mode')}, not local")
    return f"new job {jid} from {first}, {ran(job, queued)}; {finished_video(ctx, jid, 'redub.mp4')}"


def step_unused_routes(ctx):
    """The six routes no screen calls, each asked once: GET /api/tts/engines,
    POST /api/tts/say (a wav longer than MIN_SAY_SECONDS, in the voice step
    2's dub cloned), POST /api/translate (the translator the app started
    with) and GET .../subtitle_preview (a JPEG) answer 200. The two Perso
    line routes, perso/script/{line}/fit and /reset, need a Perso dub, which
    spends credits: asked of the local dub they must refuse with 409 before
    Perso is reached."""
    jid = ctx.get("dub_done")
    if not jid:
        raise Skip("needs step 2's finished dub")
    _, job = api("GET", f"/api/dub/jobs/{jid}")
    said = []
    status, engines = api("GET", "/api/tts/engines")
    ready = [e["id"] for e in (engines.get("engines") or []) if e.get("available")] if status == 200 else []
    if not ready:
        raise Fail(f"tts/engines: HTTP {status}, no engine available {detail(engines)}")
    said.append(f"tts/engines 200 ({', '.join(ready)})")
    # The voice the dub cloned: its reference clip and the words in it.
    with open(os.path.join(job["work_dir"], "speaker_refs.json"), encoding="utf-8") as f:
        ref = next(iter(json.load(f).values()))
    say = json.dumps({"text": "여기가 파리에서 제일 멋진 전망이에요.", "language": "Korean",
                       "ref_audio": os.path.join(job["work_dir"], ref["ref_wav"]), "ref_text": ref["ref_text"]})
    wav = os.path.join(ctx["files"], "say.wav")
    request = urllib.request.Request(BASE + "/api/tts/say", data=say.encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=600) as r, open(wav, "wb") as f:
            shutil.copyfileobj(r, f)
    except urllib.error.HTTPError as e:
        raise Fail(f"tts/say: HTTP {e.code} {detail(e.read().decode('utf-8', 'replace'))}")
    spoke = seconds(wav)
    if spoke <= MIN_SAY_SECONDS:
        raise Fail(f"tts/say gave {spoke:.2f}s of wav, not more than {MIN_SAY_SECONDS}s")
    said.append(f"tts/say 200, wav {spoke:.2f}s")
    status, out = api("POST", "/api/translate", json_body={"texts": ["This is the best view in all of Paris."],
                                                           "target_lang": "Korean", "source_lang": "en"}, timeout=600)
    words = (out.get("translations") or [""])[0] if status == 200 else ""
    if not flat(words):
        raise Fail(f"translate: HTTP {status} {detail(out)}")
    said.append(f"translate 200, 1 line ({len(words)} characters)")
    frame = os.path.join(ctx["files"], "subtitle-preview.jpg")
    status, got = fetch(f"/api/dub/result/{jid}/subtitle_preview?preset=sticker", frame)
    with open(frame, "rb") as f:
        jpeg = f.read(2) == b"\xff\xd8"
    if status != 200 or not jpeg:
        raise Fail(f"subtitle_preview: HTTP {status} {got}, JPEG {jpeg}")
    said.append(f"subtitle_preview 200, a {got}-byte JPEG")
    fit, fit_said = api("POST", f"/api/dub/jobs/{jid}/perso/script/1/fit", json_body={"text": "안녕하세요"})
    reset, reset_said = api("POST", f"/api/dub/jobs/{jid}/perso/script/1/reset", json_body={"confirm": True})
    if (fit, reset) != (409, 409):
        raise Fail(f"on a local dub perso fit answered HTTP {fit}, reset HTTP {reset} (not 409): "
                   f"{detail(fit_said)} / {detail(reset_said)}")
    said.append("perso fit and reset 409 on a local dub (a 200 needs a Perso dub: credits)")
    return "; ".join(said)


def step_hidden_translators(ctx):
    """The translators the app keeps out of sight, qwen and vertex, are
    offered nowhere: not among GET /api/setup's translator choices (the list
    the Settings screen and the Dub Agent offer) and no *_available field
    of GET /api/engines names vertex."""
    status, setup = api("GET", "/api/setup")
    status_e, engines = api("GET", "/api/engines")
    if status != 200 or status_e != 200:
        raise Fail(f"/api/setup HTTP {status}, /api/engines HTTP {status_e}")
    offered = setup["choices"]["translator"]
    shown = [name for name in HIDDEN_TRANSLATORS if name in offered] + [k for k in engines if "vertex" in k]
    if shown:
        raise Fail(f"offered: {shown}; translator choices {offered}")
    return (f"translator choices {offered}: neither {' nor '.join(HIDDEN_TRANSLATORS)}; /api/engines has no "
            f"vertex field (qwen_available {engines.get('qwen_available')} is read, never offered)")


def dub_log(ctx, jid):
    """Step 2's dub's own log: <logs>/job-<id>.log with --logs (beside
    backend.log, which keeps only each stage's START and DONE), else the
    job record's log, which holds the same lines."""
    if ctx["args"].logs:
        with open(os.path.join(ctx["args"].logs, f"job-{jid}.log"), encoding="utf-8", errors="replace") as f:
            return f.read().splitlines(), f"job-{jid}.log"
    _, job = api("GET", f"/api/dub/jobs/{jid}")
    return job.get("logs") or [], "the job record's log"


def step_leakage(ctx):
    """Step 2's dub checked its voices for the original voice leaking
    through (app/pipeline.py leakage_gate): at least one "leakage gate:"
    line in its log, none saying the check was skipped. The verdict is
    recorded."""
    jid = ctx.get("dub_done")
    if not jid:
        raise Skip("needs step 2's finished dub")
    lines, where = dub_log(ctx, jid)
    gate = [line.strip() for line in lines if "leakage gate:" in line]
    skipped = [line.strip() for line in lines if "leakage gate skipped" in line or "leakage… skipped" in line]
    if not gate or skipped:
        raise Fail(f"{where}: {len(gate)} leakage gate lines, {len(skipped)} skipped: {skipped[:1]}")
    return f"{where}: {len(gate)} leakage gate lines; verdict: {gate[-1].split('leakage gate:', 1)[1].strip()}"


def step_nonverbal(ctx):
    """Step 2's dub looked for laughs and breaths to keep (app/nonverbal.py):
    at least one "nonverbal whitelist:" line in its log, and no "whisper
    veto unavailable" error. Its counts are recorded."""
    jid = ctx.get("dub_done")
    if not jid:
        raise Skip("needs step 2's finished dub")
    lines, where = dub_log(ctx, jid)
    found = [line.strip() for line in lines if "nonverbal whitelist:" in line]
    broken = [line.strip() for line in lines if "whisper veto unavailable" in line]
    if not found or broken:
        raise Fail(f"{where}: {len(found)} nonverbal whitelist lines, {len(broken)} veto errors")
    return f"{where}: {len(found)} nonverbal line(s): {found[-1].split('nonverbal whitelist:', 1)[1].strip()}"


def step_one_speaker(ctx):
    """A dub started with num_speakers 1 (the dialog's Speakers field): its
    record keeps 1 and its finished script names exactly one speaker."""
    jid = start_dub(ctx, "local", "e2e-dub-1speaker", num_speakers="1")
    job, queued = wait_for(jid, "one-speaker dub")
    _, script = api("GET", f"/api/dub/jobs/{jid}/script")
    lines = script.get("lines") or []
    speakers = sorted({line.get("speaker") for line in lines})
    if job.get("num_speakers") != 1 or len(speakers) != 1:
        raise Fail(f"num_speakers {job.get('num_speakers')}, the script's {len(lines)} lines name {speakers}")
    return (f"{ran(job, queued)}; num_speakers 1, {len(lines)} lines all {speakers[0]}; "
            f"{finished_video(ctx, jid, 'dub-1speaker.mp4')}")


STEPS =(("1. Engines and settings answer", step_answers),
         ("2. Local dub, English to Korean", step_local_dub),
         ("3. Separate audio", step_separate),
         ("4. Erase subtitles", step_erase),
         ("5. Export the dub", step_export),
         ("6. Perso dub", step_perso),
         ("7. Settings round trip", step_settings),
         ("8. The dub's step timings", step_timings),
         ("9. Subtitles on their own", step_captions),
         ("10. The edition", step_edition),
         ("11. A dub with its subtitle file", step_srt_dub),
         ("12. Remake the voices (redub)", step_redub),
         ("13. The six routes no screen calls", step_unused_routes),
         ("14. Hidden translators", step_hidden_translators),
         ("15. The leakage check ran", step_leakage),
         ("16. The nonverbal check ran", step_nonverbal),
         ("17. A dub with one speaker", step_one_speaker))


def run_step(name, fn, ctx):
    """One step, timed: its result, its evidence, and for a failure after a
    job was started, that job's error and the end of its log."""
    print(name, flush=True)
    ctx["job"] = None
    began = time.monotonic()
    row = {"step": name}
    try:
        row.update(result="pass", evidence=fn(ctx))
    except Skip as e:
        row.update(result="skipped", evidence=f"skipped: {e}")
    except Exception as e:
        row.update(result="FAIL", evidence=str(e) if isinstance(e, Fail) else f"{type(e).__name__}: {e}")
        if ctx["job"]:
            try:
                _, job = api("GET", f"/api/dub/jobs/{ctx['job']}")
                row.update(error=job.get("error"), logs_tail=(job.get("logs") or [])[-LOG_TAIL:])
            except (OSError, AttributeError):
                pass   # the app is not answering: the evidence already says what failed
    row.update(seconds=round(time.monotonic() - began, 1), job_id=ctx["job"])
    print(f"  {row['result']} in {row['seconds']}s: {row['evidence']}", flush=True)
    return row


def write_report(ctx, rows, began):
    """report.json, and report.md: one table, then each failed job's log tail."""
    args = ctx["args"]
    counts = {r: sum(1 for row in rows if row["result"] == r) for r in ("pass", "skipped", "FAIL")}
    report = {"started": began.isoformat(timespec="seconds"), "base": BASE,
              "app_version": (ctx.get("settings") or {}).get("app_version"),
              "clip": {"file": os.path.basename(args.clip), "seconds": round(ctx["clip_sec"], 2)},
              "subs_clip": {"file": os.path.basename(args.subs_clip), "seconds": round(ctx["subs_sec"], 2)},
              "seconds": round(sum(row["seconds"] for row in rows), 1), "counts": counts,
              "passed": counts["FAIL"] == 0, "steps": rows}
    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    def cell(text):
        return str(text).replace("|", "\\|").replace("\n", " ")

    md = [f"# PersoDub regression run, {report['started']}", "",
          f"App {report['app_version'] or '(version unknown)'} at {BASE}. "
          f"Clip {report['clip']['file']} ({report['clip']['seconds']}s), "
          f"subtitles clip {report['subs_clip']['file']} ({report['subs_clip']['seconds']}s). "
          f"{counts['pass']} passed, {counts['skipped']} skipped, {counts['FAIL']} failed, "
          f"{report['seconds']}s in all.", "",
          "| Step | Result | Seconds | Evidence |", "| --- | --- | ---: | --- |"]
    md += [f"| {row['step']} | {row['result']} | {row['seconds']} | {cell(row['evidence'])} |" for row in rows]
    for row in rows:
        if "logs_tail" in row:
            md += ["", f"## {row['step']}: job {row['job_id']}", "", f"Error: {row.get('error') or 'none recorded'}",
                   "", "```", *row["logs_tail"], "```"]
    with open(os.path.join(args.out, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Run PersoDub's core flows against a running app.")
    parser.add_argument("--base", required=True, help="the running app, e.g. http://127.0.0.1:52252")
    parser.add_argument("--clip", required=True, help="about 10 seconds of English speech")
    parser.add_argument("--subs-clip", required=True, help="about 10 seconds with subtitles burned in")
    parser.add_argument("--out", required=True, help="folder for report.md, report.json and the files fetched")
    parser.add_argument("--perso", action="store_true", help="also dub through Perso (spends credits)")
    parser.add_argument("--translator", help="the dub's translator, any name in app/engines_status.py "
                                             "TRANSLATORS (e.g. hunyuan); default: the saved one")
    parser.add_argument("--srt", help="a subtitle file for step 11's dub, cues in Korean; "
                                      "default: three cues the run writes")
    parser.add_argument("--kit", help="the app's kit folder, whose kit.env step 10 reads")
    parser.add_argument("--logs", help="the app's logs folder, whose job-<id>.log steps 15 and 16 read; "
                                       "default: the job record's log")
    args = parser.parse_args()
    global BASE, FFPROBE
    BASE, FFPROBE = args.base.rstrip("/"), find_ffprobe()
    if not FFPROBE:
        parser.error("no ffprobe: set PERSODUB_FFPROBE, run this with the kit's Python, or put ffprobe on PATH")
    # A job's log may be in Korean; a console or pipe that cannot print it
    # must not end the run.
    sys.stdout.reconfigure(errors="replace")
    try:
        clip_sec, subs_sec = seconds(args.clip), seconds(args.subs_clip)
    except (Fail, OSError) as e:   # OSError: no ffprobe at all
        parser.error(str(e))
    ctx = {"args": args, "held": {}, "files": os.path.join(args.out, "files"),
           "export": os.path.join(args.out, "export"), "clip_sec": clip_sec, "subs_sec": subs_sec}
    os.makedirs(ctx["files"], exist_ok=True)
    os.makedirs(ctx["export"], exist_ok=True)
    began = datetime.now().astimezone()
    rows = [run_step(name, fn, ctx) for name, fn in STEPS]
    write_report(ctx, rows, began)
    print("report:", os.path.join(args.out, "report.md"))
    return 1 if any(row["result"] == "FAIL" for row in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
