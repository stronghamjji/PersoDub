#!/usr/bin/env python3
"""PersoDub's regression run: the core user flows, driven through a running
app's HTTP API, each one timed and checked with numbers.

    python tests/e2e/regress.py --base http://127.0.0.1:52252 \\
        --clip speech-10s.mp4 --subs-clip subtitles-10s.mp4 --out runs/today \\
        [--translator hunyuan] [--perso]

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
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
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
    fields, then `upload` = (field, file name, path) when there is a file."""
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in form.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    if upload:
        field, filename, path = upload
        with open(path, "rb") as f:
            body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; '
                     f'filename="{filename}"\r\nContent-Type: video/mp4\r\n\r\n').encode() + f.read() + b"\r\n"
    return body + f"--{boundary}--\r\n".encode(), "multipart/form-data; boundary=" + boundary


def fetch(path, dest, timeout=600):
    """GET a file the app hands out, into dest: (status, the bytes written or
    the refusal's words)."""
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
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


def start_dub(ctx, dub_mode, project):
    """POST /api/dub/start with the form the New project dialog builds
    (ui/src/dubApi.mjs buildDubFormData) for the held clip: English to Korean,
    Fast. Transcription and separation are named outright, because a blank
    means the saved default, which may be Perso and would spend credits on a
    run that is meant to stay on this computer; a Perso dubbing ignores both
    (the cloud does every stage). The translator is --translator, sent the
    way the dialog's Translation dropdown sends a choice; without it the
    field stays blank and the saved one translates. Its evidence names which."""
    form = {"download_id": held(ctx, ctx["args"].clip), "language": "Korean", "language_code": "ko",
            "source_language_code": "en", "n_takes": "1", "stt_engine": "local", "sep_engine": "local",
            "dub_mode": dub_mode, "project": project}
    if ctx["args"].translator:
        form["translate_engine"] = ctx["args"].translator
    return started(ctx, *api("POST", "/api/dub/start", form=form, timeout=600))


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
    """Erase subtitles in the band the app guesses, and the eraser's own look
    at the finished video finding no writing left (job.check)."""
    did = held(ctx, ctx["args"].subs_clip)
    status, found = api("POST", "/api/erase/suggest", form={"download_id": did}, timeout=600)
    if status != 200:
        raise Fail(f"suggest: HTTP {status} {detail(found)}")
    if not found.get("found"):
        raise Fail(f"suggest found no subtitles (it offers the bottom band {found.get('area')})")
    form = {"download_id": did, "area": json.dumps(found["area"]), "project": "e2e-erase"}
    jid = started(ctx, *api("POST", "/api/erase", form=form, timeout=600))
    job, queued = wait_for(jid, "erase")
    status, record = api("GET", f"/api/erase/{jid}")
    if status != 200 or not record.get("done"):
        raise Fail(f"erased.mp4 is not there (HTTP {status}, done={record.get('done')})")
    check = record.get("check") or {}
    if check.get("frames_with_text") != 0:
        raise Fail(f"frames_with_text {check.get('frames_with_text')} of {check.get('frames_checked')} checked")
    return (f"area {found['area']} of {found['width']}x{found['height']}; {ran(job, queued)}; erased.mp4 there; "
            f"frames_with_text 0 of {check.get('frames_checked')} checked, {check.get('repainted')} repainted")


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
    return f"{len(rows)} rows: " + ", ".join(said) + "; the desktop shell's save to Downloads not run"


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


STEPS = (("1. Engines and settings answer", step_answers),
         ("2. Local dub, English to Korean", step_local_dub),
         ("3. Separate audio", step_separate),
         ("4. Erase subtitles", step_erase),
         ("5. Export the dub", step_export),
         ("6. Perso dub", step_perso),
         ("7. Settings round trip", step_settings))


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
