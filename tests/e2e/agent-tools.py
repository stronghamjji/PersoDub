#!/usr/bin/env python3
"""The Dub Agent's tools, every one of the 23 in app/mcp_server.py, called the
way a terminal AI calls them: over MCP on stdio, against a running app.

    python tests/e2e/agent-tools.py --base http://127.0.0.1:51404 \\
        --clip paris-en-subs-10s.mp4 --srt paris-ko-3cues.srt --out runs/today [--kit <kit folder>]

Each reply of the agent is its own app.mcp_server process, as the CLI starts
one per message (app/api/agent.py), so the confirm gates are met the way the
user meets them: a plan put in one reply, the yes in the next. The tools that
would reach Perso are only asked in a way that cannot spend (a local dub, or
the refusal a local dub gets), download_model is asked about models it never
fetches, and download_video only gets a link it refuses before going online.
Standard library only; it borrows its HTTP and ffprobe helpers from
regress.py beside it. tests/e2e/README.md lists what each step checks.
"""
import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime

import regress
from regress import Fail, Skip, cue_count, run_step, seconds

TOOLS = ("get_script", "edit_script_line", "check_fit", "export_script", "get_job_status", "remake_voices",
         "remake_line_voice", "proofread_dub", "retranslate_lines", "change_speaker", "extract_subtitles",
         "queue_dub", "get_setup", "set_default", "download_model", "list_videos", "cut_clip", "download_video",
         "erase_subtitles", "save_erased", "list_jobs", "cancel_dub", "burn_subtitles")
# What get_script's docstring promises on every line ("reworded" is a Perso dub's only).
LINE_FIELDS = ("line", "start", "end", "slot", "source", "source_line", "text", "estimated", "fits", "over",
               "speaker", "audio_sec", "voice_stale", "untranslated")
LINES = 3              # the fixture's speech makes three lines
LENGTH_TOLERANCE = 0.1   # a burned or erased video keeps the clip's frames
CUT_TOLERANCE = 0.2      # a cut re-encodes, so its ends land on frames
CANCEL_LIMIT = 60
DUB_LIMIT = 400
ERASE_LIMIT = 700
REFUSE_LIMIT = 20
# Someone else's job may be ahead in the one local line; past this ours is stuck.
QUEUE_TIMEOUT = 45 * 60
RUN_TIMEOUT = 20 * 60
ENDED = ("done", "error", "cancelled")
EDIT_MARKER = "에이전트 시험 문장입니다"
# The gate's own words when a confirm comes in the reply that asked.
NOT_ANSWERED = "The user has not answered yet."
# What no tool answer may carry: an e-mail address, a key in one of the shapes
# app/report_mask.py masks (sk-, AIza, ghp_, hf_, a JWT), or a token of 32+
# letters and digits in one run. A hyphen or an underscore ends a token: the
# names people give projects and Perso gives its exports join words with them
# ("..._KOtoKO_TranslatedVideo_1792582688171"), where a key's random run is
# 32+ on its own. Only the kind and the tool are ever reported, never the match.
LEAKS = (("an e-mail address", re.compile(r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")),
         ("a key", re.compile(r"(?<![A-Za-z0-9])(?:sk-|AIza|ghp_|hf_|eyJ[\w-]+\.[\w-]+\.)")),
         ("a 32+ character token", re.compile(r"[A-Za-z0-9]{32,}")))


# ---------------------------------------------------------------------------
# Talking MCP
# ---------------------------------------------------------------------------

class Reply:
    """One reply of the agent: a fresh `python -m app.mcp_server`, initialized,
    whose tool answers are counted and searched for secrets as they come."""

    def __init__(self, ctx):
        self.ctx, self.last_id = ctx, 0
        env = {**os.environ, "PERSODUB_API": regress.BASE, "PYTHONPATH": ctx["repo"]}
        # Its working folder is the run's: the gates' .persodub-asked.json lands there.
        self.log = open(os.path.join(ctx["out"], "mcp-server.log"), "ab")
        self.proc = subprocess.Popen([ctx["python"], "-m", "app.mcp_server"], cwd=ctx["out"], env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "agent-tools.py", "version": "1"}}, 60)
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _read(self):
        for raw in self.proc.stdout:
            self.lines.put(raw)
        self.lines.put(None)

    def send(self, message):
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()

    def request(self, method, params, timeout):
        self.last_id += 1
        self.send({"jsonrpc": "2.0", "id": self.last_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            try:
                raw = self.lines.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                raise Fail(f"{method} {params.get('name', '')} gave no answer in {timeout}s")
            if raw is None:
                raise Fail(f"the MCP server ended during {method} (mcp-server.log has its words)")
            message = json.loads(raw)
            if message.get("id") == self.last_id:
                if "error" in message:
                    raise Fail(f"{method}: JSON-RPC error {message['error']}")
                return message["result"]

    def answer(self, tool, args, timeout):
        """(refused, text, value) for one tools/call."""
        result = self.request("tools/call", {"name": tool, "arguments": args}, timeout)
        text = "\n".join(c.get("text", "") for c in result.get("content") or [] if c.get("type") == "text")
        self.ctx["called"].add(tool)
        self.ctx["answers"] += 1
        # The run's own folder is in the paths the tools hand back; it is ours, not a secret.
        for line in text.replace(self.ctx["out"], "<out>").splitlines():
            self.ctx["leaks"] += [(tool, kind) for kind, pattern in LEAKS if pattern.search(line)]
        if result.get("isError"):
            return True, text, None
        structured = result.get("structuredContent")
        if structured is not None:
            return False, text, structured.get("result", structured)
        try:
            return False, text, json.loads(text)
        except ValueError:
            return False, text, text

    def call(self, tool, timeout=120, **args):
        """The tool's answer, or Fail with its refusal."""
        refused, text, value = self.answer(tool, args, timeout)
        if refused:
            raise Fail(f"{tool} refused: {text[:300]}")
        return value

    def refused(self, tool, timeout=120, **args):
        """The tool's refusal, without the "Error executing tool X: " it is
        handed over in -- or Fail when it did the work instead."""
        refused, text, _ = self.answer(tool, args, timeout)
        if not refused:
            raise Fail(f"{tool} {args} was not refused: {text[:200]}")
        if "Traceback" in text:
            raise Fail(f"{tool} answered with a stack trace")
        return text.split(f"Error executing tool {tool}: ", 1)[-1]

    def close(self):
        self.proc.stdin.close()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def follow(ctx, jid, what, until=ENDED):
    """get_job_status on a job until its status is one of `until`: (the last
    answer, seconds it waited in line, seconds it ran)."""
    agent, joined, began, shown = ctx["agent"], time.monotonic(), None, None
    while True:
        status = agent.call("get_job_status", job_id=jid)
        now = time.monotonic()
        if status["status"] != "queued" and began is None:
            began = now
        if status["status"] in until:
            break
        since, limit = (joined, QUEUE_TIMEOUT) if began is None else (began, RUN_TIMEOUT)
        if now - since > limit:
            agent.call("cancel_dub", job_id=jid)
            raise Fail(f"{what} {jid} still {status['status']} after {limit // 60} min; cancelled it")
        line = ((status.get("logs") or [""])[-1])[:100]
        if (status["status"], line) != shown:
            print(f"    {what} {jid} {status['status']}: {line}", flush=True)
            shown = (status["status"], line)
        time.sleep(2)
    began = now if began is None else began
    return status, began - joined, now - began


def near(label, path, want, tolerance):
    got = seconds(path)
    if abs(got - want) > tolerance:
        raise Fail(f"{label} is {got:.2f}s, not {want:.2f}s ± {tolerance}")
    return f"{label} {got:.2f}s"


def copy_to(ctx, folder, name):
    """A copy of the clip in the run's own folder: the tools that write beside
    a video write there, and a fresh name means nothing is ever in the way."""
    os.makedirs(os.path.join(ctx["out"], folder), exist_ok=True)
    path = os.path.join(ctx["out"], folder, name)
    shutil.copyfile(ctx["args"].clip, path)
    return path


def dub(ctx):
    """The dub this run made and finished, which the script tools work on."""
    if not ctx.get("dub"):
        raise Skip("needs the finished dub of step 5")
    return ctx["dub"]


def line_of(ctx, n):
    return ctx["agent"].call("get_script", job_id=dub(ctx))[n - 1]


def video_of(ctx):
    """The finished dub's video on disk, which a voice remake rebuilds in place."""
    _, job = regress.api("GET", f"/api/dub/jobs/{dub(ctx)}")
    return job["result"]["out_path"]


# ---------------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------------

def step_tools_list(ctx):
    """tools/list names the 23 tools, each with a description."""
    tools = ctx["agent"].request("tools/list", {}, 60)["tools"]
    names = {t["name"] for t in tools}
    short = [t["name"] for t in tools if len(t.get("description") or "") < 40]
    if names != set(TOOLS) or short:
        raise Fail(f"{len(tools)} tools; missing {sorted(set(TOOLS) - names)}, unexpected "
                   f"{sorted(names - set(TOOLS))}, description under 40 characters {short}")
    least = min(len(t["description"]) for t in tools)
    return f"{len(tools)} tools, the 23 expected, every description {least}+ characters"


def step_setup(ctx):
    """get_setup: every stage's default among its choices, and the models with their states."""
    setup = ctx["agent"].call("get_setup")
    defaults, choices = setup["defaults"], setup["choices"]
    wrong = [s for s in choices if defaults.get(s) not in choices[s]]
    states = {m["id"]: m["state"] for m in setup["models"]}
    if set(defaults) != set(choices) or len(defaults) != 6 or wrong or states.get("demucs") != "ready":
        raise Fail(f"defaults {defaults}, choices {sorted(choices)}, outside the choices {wrong}, demucs {states.get('demucs')}")
    ctx["setup"] = setup
    ready = sum(1 for s in states.values() if s == "ready")
    return (f"6 stages, each default among its choices ({', '.join(f'{k}={v}' for k, v in defaults.items())}); "
            f"{len(states)} models, {ready} ready, demucs ready; keys {setup.get('keys')}")


def step_list_videos(ctx):
    """list_videos on the run's input folder lists the clip copy, after the held videos."""
    agent = ctx["agent"]
    listed = agent.call("list_videos", folder=os.path.dirname(ctx["dub_clip"]))
    own = [v for v in listed["videos"] if not v.get("held")]
    held = len(listed["videos"]) - len(own)
    if [v["name"] for v in own] != [os.path.basename(ctx["dub_clip"])] or listed["total"] != len(listed["videos"]):
        raise Fail(f"listed {[v['name'] for v in own]} beside {held} held, total {listed['total']}")
    missing = os.path.join(ctx["out"], "no-such-folder")
    said = agent.refused("list_videos", folder=missing)
    if said != f"No such folder: {missing}":
        raise Fail(f"a missing folder answered {said!r}")
    return f"1 video of its own ({own[0]['size_mb']} MB) after {held} held; a missing folder: \"No such folder: ...\""


def step_list_jobs(ctx):
    """list_jobs lists every job the app has; active_only only the live ones."""
    agent = ctx["agent"]
    every = agent.call("list_jobs", active_only=False)
    live = agent.call("list_jobs")
    _, body = regress.api("GET", "/api/dub/jobs")
    known = body.get("jobs", body) if isinstance(body, dict) else body
    keys = {"id", "kind", "title", "status", "language_code", "project_id"}
    if (len(every) != len(known) or any(set(j) != keys for j in every)
            or any(j["status"] not in ("queued", "running", "cancelling") for j in live)):
        raise Fail(f"{len(every)} listed of {len(known)}; live ones {[(j['id'], j['status']) for j in live]}")
    done = [j for j in every if j["kind"] == "dub" and j["status"] == "done" and j["title"].startswith("e2e-")]
    if not done:
        raise Fail("no finished e2e- dub on the app")
    ctx["newest_e2e"] = done[0]
    return (f"{len(every)} jobs, as many as GET /api/dub/jobs has, each with its 6 fields; {len(live)} live; "
            f"newest done e2e- dub {done[0]['id']} ({done[0]['title']})")


def step_job_status(ctx):
    """get_job_status on the newest finished e2e- dub, and a clean refusal for an id that is not there."""
    agent = ctx["agent"]
    if not ctx.get("newest_e2e"):
        raise Skip("needs list_jobs' newest e2e- dub")
    jid = ctx["newest_e2e"]["id"]
    status = agent.call("get_job_status", job_id=jid)
    if status["status"] != "done" or status["error"] is not None or not 0 < len(status["logs"]) <= 20:
        raise Fail(f"{jid}: status {status['status']}, error {status['error']}, {len(status['logs'])} log lines")
    said = agent.refused("get_job_status", job_id="e2e-no-such-job")
    if said != "no such job: e2e-no-such-job":
        raise Fail(f"a bad id answered {said!r}")
    return f"{jid} done, error none, last {len(status['logs'])} log lines; bad id: \"{said}\", no stack trace"


def queue_args(ctx):
    """English to Korean on this computer, every stage named local so no saved
    default can send one through Perso."""
    args = {"video_path": ctx["dub_clip"], "target_language": "ko", "dub_mode": "local",
            "source_language": "en", "stt": "local", "separation": "local", "voice": "qwen3"}
    if ctx["args"].translator:
        args["translator"] = ctx["args"].translator
    return args


def step_cancel(ctx):
    """queue_dub asks first and refuses a yes in the same reply; the next
    reply's yes starts it; cancel_dub stops it once it runs, within 60 s."""
    with Reply(ctx) as first:
        plan = first.call("queue_dub", **queue_args(ctx), timeout=120)
        name = os.path.basename(ctx["dub_clip"])
        if not plan.get("needs_confirmation") or name not in plan["message"] or "Korean" not in plan["message"] \
                or abs(plan["seconds"] - 10.0) > LENGTH_TOLERANCE:
            raise Fail(f"the plan: {plan}")
        said = first.refused("queue_dub", **queue_args(ctx), confirm=True)
        if not said.startswith(NOT_ANSWERED):
            raise Fail(f"a yes in the asking reply answered {said!r}")
    with Reply(ctx) as second:
        started = second.call("queue_dub", **queue_args(ctx), confirm=True, timeout=600)
    jid = ctx["job"] = started["job_id"]
    status, queued, _ = follow(ctx, jid, "dub to cancel", until=("running",) + ENDED)
    if status["status"] != "running":
        raise Fail(f"{jid} ended {status['status']} before it could be cancelled")
    percent = status.get("percent")
    asked = time.monotonic()
    ctx["agent"].call("cancel_dub", job_id=jid)
    status, _, _ = follow(ctx, jid, "cancelling")
    took = time.monotonic() - asked
    if status["status"] != "cancelled" or took > CANCEL_LIMIT:
        raise Fail(f"{jid} {status['status']} {took:.0f}s after cancel_dub")
    again = ctx["agent"].refused("cancel_dub", job_id=jid)
    return (f"plan: \"{plan['message'][:70]}...\" {plan['seconds']}s; a yes in the same reply refused; "
            f"next reply started {jid}; running after {queued:.0f}s in line (at {percent}%), "
            f"cancelled {took:.0f}s after cancel_dub; again: \"{again}\"")


def step_dub(ctx):
    """queue_dub with the yes in the user's own message (nothing asked in this
    reply) starts at once, runs to done within 400 s once out of line, and
    list_jobs lists it done under the clip's name."""
    with Reply(ctx) as reply:
        started = reply.call("queue_dub", **queue_args(ctx), confirm=True, timeout=600)
    jid = ctx["job"] = started["job_id"]
    status, queued, ran = follow(ctx, jid, "dub")
    if status["status"] != "done":
        raise Fail(f"{jid} ended {status['status']}: {status['error']}")
    title = os.path.splitext(os.path.basename(ctx["dub_clip"]))[0]
    listed = [j for j in ctx["agent"].call("list_jobs", active_only=False) if j["id"] == jid]
    if not listed or listed[0]["status"] != "done" or listed[0]["title"] != title:
        raise Fail(f"list_jobs has {listed} for {jid}")
    ctx["dub"] = jid
    if ran > DUB_LIMIT:
        raise Fail(f"{jid} ran {ran:.0f}s, more than {DUB_LIMIT}s")
    return f"{jid} done, ran {ran:.0f}s after {queued:.0f}s in line (limit {DUB_LIMIT}s); list_jobs: done, title {title}"


def step_get_script(ctx):
    """get_script: three lines, each with every field its docstring names."""
    lines = ctx["agent"].call("get_script", job_id=dub(ctx))
    lacking = {ln.get("line"): [f for f in LINE_FIELDS if f not in ln] for ln in lines}
    lacking = {k: v for k, v in lacking.items() if v}
    if len(lines) != LINES or lacking or [ln["line"] for ln in lines] != [1, 2, 3]:
        raise Fail(f"{len(lines)} lines; fields missing {lacking}")
    ctx["script"] = lines
    voiced = sum(1 for ln in lines if isinstance(ln["audio_sec"], (int, float)) and ln["audio_sec"] > 0)
    return (f"{LINES} lines, each with all {len(LINE_FIELDS)} fields; {voiced} voiced "
            f"({', '.join(str(ln['audio_sec']) for ln in lines)} s); fits {[ln['fits'] for ln in lines]}")


def step_check_fit(ctx):
    """check_fit per line agrees with get_script; without a line it lists
    exactly the lines that do not fit; line 4 is refused."""
    agent, jid = ctx["agent"], dub(ctx)
    script = ctx.get("script") or agent.call("get_script", job_id=jid)
    each = [agent.call("check_fit", job_id=jid, line=n) for n in range(1, LINES + 1)]
    if any(len(one) != 1 or one[0]["fits"] != ln["fits"] or not isinstance(one[0]["fits"], bool)
           for one, ln in zip(each, script)):
        raise Fail(f"per line {[[x.get('fits') for x in one] for one in each]}, get_script {[ln['fits'] for ln in script]}")
    misfits = agent.call("check_fit", job_id=jid)
    if [ln["line"] for ln in misfits] != [ln["line"] for ln in script if not ln["fits"]]:
        raise Fail(f"without a line: {[ln['line'] for ln in misfits]}")
    said = agent.refused("check_fit", job_id=jid, line=4)
    if said != "there is no line 4 -- this script runs from line 1 to 3":
        raise Fail(f"line 4 answered {said!r}")
    return (f"lines 1-3 fits {[one[0]['fits'] for one in each]} as get_script; {len(misfits)} listed as not fitting; "
            f"line 4: \"{said}\"")


def step_edit(ctx):
    """edit_script_line: line 2 rewritten and read back. The original goes back
    after retranslate_lines, which starts from these words."""
    agent, jid = ctx["agent"], dub(ctx)
    original = line_of(ctx, 2)["text"]
    ctx["line2"] = original
    edited = agent.call("edit_script_line", job_id=jid, line=2, text=EDIT_MARKER)
    back = line_of(ctx, 2)
    if edited.get("text") != EDIT_MARKER or back["text"] != EDIT_MARKER or back["voice_stale"] is not True:
        raise Fail(f"answered {edited.get('text')!r}, reads back {back['text']!r}, voice_stale {back['voice_stale']}")
    said = agent.refused("edit_script_line", job_id=jid, line=9, text=EDIT_MARKER)
    # The reason names the line in either language ("there is no line 9", "9번 줄은 없어요").
    if "9" not in said:
        raise Fail(f"line 9 refused without its reason: {said[:200]}")
    return (f"line 2 \"{original}\" -> \"{EDIT_MARKER}\", read back, voice_stale true, fits {edited.get('fits')}; "
            f"line 9 refused: \"{said[:80]}\"")


def step_retranslate(ctx):
    """retranslate_lines on line 2 replaces the edited words with a translation;
    then edit_script_line puts the original back, read back the same."""
    agent, jid = ctx["agent"], dub(ctx)
    if "line2" not in ctx:
        raise Skip("needs the edit step")
    try:
        changed = agent.call("retranslate_lines", job_id=jid, lines=[2], timeout=900)["changed"]
        if len(changed) != 1 or changed[0]["line"] != 2 or changed[0]["was"] != EDIT_MARKER \
                or not changed[0]["text"].strip() or changed[0]["text"] == EDIT_MARKER:
            raise Fail(f"changed {changed}")
    finally:
        agent.call("edit_script_line", job_id=jid, line=2, text=ctx["line2"])
    back = line_of(ctx, 2)
    if back["text"] != ctx["line2"]:
        raise Fail(f"line 2 reads {back['text']!r} after putting back {ctx['line2']!r}")
    _, job = regress.api("GET", f"/api/dub/jobs/{jid}")
    return (f"line 2 \"{EDIT_MARKER}\" -> \"{changed[0]['text']}\" ({job.get('translator')}); "
            f"original put back and read back, voice_stale {back['voice_stale']}")


def step_line_voice(ctx):
    """remake_line_voice on line 1 makes its voice again and rebuilds the video."""
    agent, jid = ctx["agent"], dub(ctx)
    video = video_of(ctx)
    before = os.path.getmtime(video)
    done = agent.call("remake_line_voice", job_id=jid, line=1, timeout=900)
    line = line_of(ctx, 1)
    after = os.path.getmtime(video)
    if done != {"line": 1, "ok": True} or after <= before or not (line["audio_sec"] or 0) > 0:
        raise Fail(f"answered {done}; video {after - before:+.1f}s newer; line 1 audio_sec {line['audio_sec']}")
    return f"{done}; the dub's video rewritten ({after - before:.0f}s newer); line 1 audio_sec {line['audio_sec']}"


def step_perso_only(ctx):
    """change_speaker and proofread_dub are Perso's: on this local dub each
    refuses at once with its sentence, asking nothing about credits."""
    agent, jid = ctx["agent"], dub(ctx)
    speaker = agent.refused("change_speaker", job_id=jid, line=1)
    speaker_yes = agent.refused("change_speaker", job_id=jid, line=1, confirm=True)
    proofread = agent.refused("proofread_dub", job_id=jid)
    want_speaker = ("Changing a line's speaker works on Perso dubbing only. "
                    "This job was dubbed on this computer.")
    want_proofread = "All at once works on Perso dubbing only. This job was dubbed on this computer."
    if speaker != want_speaker or speaker_yes != want_speaker or proofread != want_proofread:
        raise Fail(f"change_speaker {speaker!r} / with confirm {speaker_yes!r}; proofread_dub {proofread!r}")
    return f"change_speaker (with and without confirm): \"{speaker}\"; proofread_dub: \"{proofread}\""


def step_voices(ctx):
    """remake_voices: the changed lines only (none left), then every line,
    asked in one reply and said yes to in the next."""
    jid = dub(ctx)
    stale = ctx["agent"].call("remake_voices", job_id=jid, timeout=900)
    if len(stale["remade"]) + stale["skipped"] != LINES:
        raise Fail(f"changed lines only: {stale}")
    video = video_of(ctx)
    before = os.path.getmtime(video)
    with Reply(ctx) as asking:
        plan = asking.call("remake_voices", job_id=jid, every_line=True)
        if not plan.get("needs_confirmation") or f"all {LINES} lines" not in plan["message"]:
            raise Fail(f"the plan: {plan}")
        said = asking.refused("remake_voices", job_id=jid, every_line=True, confirm=True)
        if not said.startswith(NOT_ANSWERED):
            raise Fail(f"a yes in the asking reply answered {said!r}")
    with Reply(ctx) as yes:
        every = yes.call("remake_voices", job_id=jid, every_line=True, confirm=True, timeout=1200)
    if every != {"remade": [1, 2, 3], "skipped": 0} or os.path.getmtime(video) <= before:
        raise Fail(f"every line: {every}; video rewritten {os.path.getmtime(video) > before}")
    length = near("the rebuilt video", video, ctx["clip_sec"], LENGTH_TOLERANCE)
    return (f"changed only: {stale}; every line asked (\"all {LINES} lines\"), same-reply yes refused, "
            f"next reply: {every}; {length}")


def step_export(ctx):
    """export_script writes the script as .srt inside the job's folder, and
    refuses a path outside it. It has no other format."""
    agent, jid = ctx["agent"], dub(ctx)
    name = os.path.splitext(os.path.basename(ctx["dub_clip"]))[0] + "-script.srt"
    path = agent.call("export_script", job_id=jid, out_path=name)
    work = os.path.dirname(video_of(ctx))
    if os.path.dirname(path) != work or cue_count(path) != LINES:
        raise Fail(f"wrote {path} ({cue_count(path) if os.path.exists(path) else 'missing'} cues), job folder {work}")
    ctx["exported"] = path
    outside = os.path.join(os.path.dirname(work), "outside.srt")
    said = agent.refused("export_script", job_id=jid, out_path="../outside.srt")
    if os.path.exists(outside):
        raise Fail(f"\"../outside.srt\" was written: {outside}")
    # The refusal carries its reason to the agent (a Refusal since 2026-10-28;
    # before, mcp >= 2.2 handed over a bare "Error executing tool export_script").
    if "only be written inside its own job folder" not in said:
        raise Fail(f"\"../outside.srt\" refused without its reason: {said[:200]}")
    return f"{os.path.basename(path)} in the job folder, {LINES} cues; \"../outside.srt\" refused with its reason, nothing written"


def step_burn(ctx):
    """burn_subtitles on a copy of the dub's video, in two looks: each new
    video as long as the clip (10.0 s ± 0.1)."""
    dub(ctx)
    os.makedirs(os.path.join(ctx["out"], "burn"), exist_ok=True)
    video = os.path.join(ctx["out"], "burn", "dub.mp4")
    shutil.copyfile(video_of(ctx), video)
    said = []
    for preset, srt in (("clean", ctx["args"].srt), ("sticker", ctx.get("exported") or ctx["args"].srt)):
        made = ctx["agent"].call("burn_subtitles", video_path=video, srt_path=srt, preset=preset, timeout=900)
        if made.get("preset") != preset or os.path.dirname(made["out_path"]) != os.path.dirname(video):
            raise Fail(f"{preset}: {made}")
        said.append(near(f"{preset} ({os.path.basename(srt)})", made["out_path"], ctx["clip_sec"], LENGTH_TOLERANCE))
    return ", ".join(said) + f"; input {ctx['clip_sec']:.2f}s"


def step_extract(ctx):
    """extract_subtitles asks for the engine when none is named, and on this
    computer writes the clip's three spoken lines beside it."""
    agent = ctx["agent"]
    clip = copy_to(ctx, "extract", "clip.mp4")
    said = agent.refused("extract_subtitles", video_path=clip)
    if not said.startswith("Ask the user which engine to use first"):
        raise Fail(f"no engine answered {said!r}")
    made = agent.call("extract_subtitles", video_path=clip, engine="local", timeout=900)
    srt = made["srt_path"]
    if made["lines"] != LINES or os.path.dirname(srt) != os.path.dirname(clip) or cue_count(srt) != LINES:
        raise Fail(f"{made}; the file has {cue_count(srt) if os.path.exists(srt) else 'no'} cues")
    return f"no engine: \"{said[:40]}...\"; local: {os.path.basename(srt)} beside the clip, {LINES} cues"


def step_cut(ctx):
    """cut_clip 2-7.5 s of the clip: a new file of 5.5 s ± 0.2; a start past the end is refused."""
    agent = ctx["agent"]
    clip = copy_to(ctx, "cut", "clip.mp4")
    made = agent.call("cut_clip", video_path=clip, start="2", end="0:07.5")
    if made["seconds"] != 5.5 or os.path.dirname(made["clip_path"]) != os.path.dirname(clip):
        raise Fail(f"answered {made}")
    length = near(os.path.basename(made["clip_path"]), made["clip_path"], 5.5, CUT_TOLERANCE)
    said = agent.refused("cut_clip", video_path=clip, start="0:20", end="0:25")
    return f"{length} (asked 2-7.5 s), answer {made['seconds']}s; 20-25 s of a 10 s clip refused: \"{said}\""


def step_erase(ctx):
    """erase_subtitles asks first, refuses a yes in the same reply, and the next
    reply's yes queues it; it finishes within 700 s out of line, the eraser's
    own look finds no writing left, and its video is as long as the clip."""
    clip = ctx["erase_clip"]
    with Reply(ctx) as asking:
        plan = asking.call("erase_subtitles", video_path=clip)
        if not plan.get("needs_confirmation") or os.path.basename(clip) not in plan["message"]:
            raise Fail(f"the plan: {plan}")
        said = asking.refused("erase_subtitles", video_path=clip, confirm=True)
        if not said.startswith(NOT_ANSWERED):
            raise Fail(f"a yes in the asking reply answered {said!r}")
    with Reply(ctx) as yes:
        started = yes.call("erase_subtitles", video_path=clip, confirm=True, timeout=900)
    jid = ctx["job"] = started["job_id"]
    status, queued, ran = follow(ctx, jid, "erase")
    check = status.get("check") or {}
    if status["status"] != "done" or status.get("done") is not True or check.get("frames_with_text") != 0:
        raise Fail(f"{jid} {status['status']}, done {status.get('done')}, check {check}")
    ctx["erased"] = jid
    length = near("result_path", status["result_path"], ctx["clip_sec"], LENGTH_TOLERANCE)
    if ran > ERASE_LIMIT:
        raise Fail(f"{jid} ran {ran:.0f}s, more than {ERASE_LIMIT}s")
    return (f"asked, same-reply yes refused; {jid} area_used \"{started['area_used']}\", ran {ran:.0f}s after "
            f"{queued:.0f}s in line (limit {ERASE_LIMIT}s); frames_with_text 0 of {check.get('frames_checked')}; {length}")


def step_save_erased(ctx):
    """save_erased puts the cleaned video into the folder named, as long as the clip."""
    if not ctx.get("erased"):
        raise Skip("needs the finished erase")
    folder = os.path.join(ctx["out"], "saved")
    saved = ctx["agent"].call("save_erased", job_id=ctx["erased"], dir=folder)
    if os.path.dirname(saved["path"]) != folder or not os.path.isfile(saved["path"]):
        raise Fail(f"answered {saved}")
    return near(os.path.basename(saved["path"]), saved["path"], ctx["clip_sec"], LENGTH_TOLERANCE) + " in the folder named"


def step_set_default(ctx):
    """set_default: voice_quality to its other choice, read back, and back;
    a paid choice (stt perso) only asks, and changes nothing."""
    agent = ctx["agent"]
    stage = "voice_quality"
    setup = agent.call("get_setup")
    before = setup["defaults"][stage]
    other = next(c for c in setup["choices"][stage] if c != before)
    try:
        agent.call("set_default", stage=stage, choice=other)
        flipped = agent.call("get_setup")["defaults"][stage]
    finally:
        agent.call("set_default", stage=stage, choice=before)
    back = agent.call("get_setup")["defaults"]
    if flipped != other or back[stage] != before:
        raise Fail(f"{stage} {before} -> read {flipped} -> read {back[stage]}")
    plan = agent.call("set_default", stage="stt", choice="perso")
    stt = agent.call("get_setup")["defaults"]["stt"]
    if not plan.get("needs_confirmation") or stt != setup["defaults"]["stt"]:
        raise Fail(f"stt perso answered {plan}, stt now {stt}")
    return f"{stage} {before} -> {other} -> {before}, each read back; stt perso: needs_confirmation, stt stays {stt}"


def models_on_disk(ctx):
    """(files, bytes) under the kit's models folder, or None without --kit."""
    if not ctx["args"].kit:
        return None
    files = size = 0
    for root, _, names in os.walk(os.path.join(ctx["args"].kit, "models")):
        for name in names:
            files += 1
            size += os.path.getsize(os.path.join(root, name))
    return files, size


def step_download_model(ctx):
    """download_model fetches nothing: Demucs answers that it is downloaded,
    in under 5 s; a model this computer does not have yet answers with the
    button and stays not downloaded."""
    agent = ctx["agent"]
    missing = [m["id"] for m in agent.call("get_setup")["models"] if m["state"] == "not_downloaded"]
    if not missing:
        raise Skip("every model is already downloaded here, so the download button cannot be checked")
    other = missing[0]
    before = models_on_disk(ctx)
    began = time.monotonic()
    ready = agent.call("download_model", model_id="demucs")
    took = time.monotonic() - began
    offer = agent.call("download_model", model_id=other)
    said = agent.refused("download_model", model_id="e2e-no-such-model")
    time.sleep(3)
    state = {m["id"]: m["state"] for m in agent.call("get_setup")["models"]}[other]
    after = models_on_disk(ctx)
    if (ready != {"model": "Demucs", "state": "ready", "message": "Demucs is already downloaded."} or took > 5
            or offer.get("button_shown") is not True or offer.get("state") != "not_downloaded"
            or state != "not_downloaded" or after != before or not said.startswith("No such model: e2e-no-such-model")):
        raise Fail(f"demucs {ready} in {took:.1f}s; {other} {offer}, then {state}; models folder {before} -> {after}")
    disk = "models folder unchanged" + (f" ({after[0]} files, {after[1] / 1e9:.2f} GB)" if after else " (not checked: no --kit)")
    return (f"demucs: \"{ready['message']}\" in {took:.1f}s; {other}: button_shown, {offer['gb']} GB, still "
            f"{state}; {disk}; unknown id refused")


def step_download_video(ctx):
    """download_video refuses a string that is not a web address, within 20 s,
    in the app's own words, before anything goes online."""
    link = "not-a-link"
    began = time.monotonic()
    said = ctx["agent"].refused("download_video", url=link, timeout=REFUSE_LIMIT + 5)
    took = time.monotonic() - began
    _, body = regress.api("POST", "/api/downloads", json_body={"url": link})
    want = body["detail"]["message"]
    if said != want or took > REFUSE_LIMIT:
        raise Fail(f"answered {said!r} in {took:.1f}s; the app says {want!r}")
    return f"\"{said}\" in {took:.1f}s, the app's own sentence"


def step_leaks(ctx):
    """No line of any tool answer carries an e-mail address, an sk- key or a 32+
    character token; and every one of the 23 tools was called."""
    leaks = ctx["leaks"]
    uncalled = sorted(set(TOOLS) - ctx["called"])
    if leaks or uncalled:
        found = sorted({f"{kind} in {tool}" for tool, kind in leaks})
        raise Fail(f"{len(leaks)} lines with {', '.join(found) or 'nothing'}; not called: {uncalled}")
    return f"{ctx['answers']} answers checked, 0 lines leaking; {len(ctx['called'])} of 23 tools called"


STEPS = (("1. tools/list", step_tools_list),
         ("2. get_setup", step_setup),
         ("3. list_videos", step_list_videos),
         # The dubs first, so a freshly installed app has a finished e2e- dub to list.
         ("4. queue_dub, cancel_dub", step_cancel),
         ("5. queue_dub to the end", step_dub),
         ("6. list_jobs", step_list_jobs),
         ("7. get_job_status", step_job_status),
         ("8. get_script", step_get_script),
         ("9. check_fit", step_check_fit),
         ("10. edit_script_line", step_edit),
         ("11. retranslate_lines", step_retranslate),
         ("12. remake_line_voice", step_line_voice),
         ("13. change_speaker, proofread_dub", step_perso_only),
         ("14. remake_voices", step_voices),
         ("15. export_script", step_export),
         ("16. burn_subtitles", step_burn),
         ("17. extract_subtitles", step_extract),
         ("18. cut_clip", step_cut),
         ("19. erase_subtitles", step_erase),
         ("20. save_erased", step_save_erased),
         ("21. set_default", step_set_default),
         ("22. download_model", step_download_model),
         ("23. download_video", step_download_video),
         ("24. No secrets, every tool", step_leaks))


def write_report(ctx, rows, began):
    counts = {r: sum(1 for row in rows if row["result"] == r) for r in ("pass", "skipped", "FAIL")}
    report = {"started": began.isoformat(timespec="seconds"), "base": regress.BASE,
              "clip": os.path.basename(ctx["args"].clip), "seconds": round(time.monotonic() - ctx["t0"], 1),
              "answers_checked": ctx["answers"], "tools_called": sorted(ctx["called"]),
              "counts": counts, "passed": counts["FAIL"] == 0, "steps": rows}
    with open(os.path.join(ctx["out"], "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    md = [f"# PersoDub Dub Agent tools, {report['started']}", "",
          f"App at {regress.BASE}, its tools over MCP from {ctx['repo']}. Clip {report['clip']} "
          f"({ctx['clip_sec']:.2f}s). {counts['pass']} passed, {counts['skipped']} skipped, {counts['FAIL']} failed, "
          f"{report['seconds']}s in all; {ctx['answers']} tool answers.", "",
          "| Step | Result | Seconds | Evidence |", "| --- | --- | ---: | --- |"]
    md += [f"| {row['step']} | {row['result']} | {row['seconds']} | "
           f"{str(row['evidence']).replace('|', '/').replace(chr(10), ' ')} |" for row in rows]
    for row in rows:
        if "logs_tail" in row:
            md += ["", f"## {row['step']}: job {row['job_id']}", "", f"Error: {row.get('error') or 'none recorded'}",
                   "", "```", *row["logs_tail"], "```"]
    with open(os.path.join(ctx["out"], "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")


def main():
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    parser = argparse.ArgumentParser(description="Call the Dub Agent's 23 tools against a running app.")
    parser.add_argument("--base", required=True, help="the running app, e.g. http://127.0.0.1:51404")
    parser.add_argument("--clip", required=True, help="about 10 seconds of English speech with burned-in subtitles")
    parser.add_argument("--srt", required=True, help="a three-cue .srt for that clip")
    parser.add_argument("--out", required=True, help="folder for report.md, report.json and the files made")
    parser.add_argument("--python", help="the Python that runs app.mcp_server (default: <repo>/.venv's, else this one)")
    parser.add_argument("--kit", help="the app's kit folder: its models folder is checked for downloads")
    parser.add_argument("--translator", default="", help="translator for the local dubs (default: the app's saved one)")
    args = parser.parse_args()
    venv = os.path.join(repo, ".venv", "bin", "python")
    regress.BASE, regress.FFPROBE = args.base.rstrip("/"), regress.find_ffprobe()
    if not regress.FFPROBE:
        parser.error("no ffprobe: set PERSODUB_FFPROBE or put ffprobe on PATH")
    sys.stdout.reconfigure(errors="replace")
    out = os.path.abspath(args.out)
    stamp = datetime.now().strftime("%H%M%S")
    ctx = {"args": args, "repo": repo, "out": out, "job": None, "called": set(), "answers": 0, "leaks": [],
           "python": args.python or (venv if os.path.exists(venv) else sys.executable),
           "clip_sec": seconds(args.clip), "t0": time.monotonic()}
    os.makedirs(out, exist_ok=True)
    # Short names: a 32-character run of letters would read as a token to step 24.
    ctx["dub_clip"] = copy_to(ctx, "input", f"e2e-agent-{stamp}.mp4")
    ctx["erase_clip"] = copy_to(ctx, "erase", f"e2e-agent-erase-{stamp}.mp4")
    began = datetime.now().astimezone()
    with Reply(ctx) as agent:
        ctx["agent"] = agent
        rows = [run_step(name, fn, ctx) for name, fn in STEPS]
    write_report(ctx, rows, began)
    print("report:", os.path.join(out, "report.md"))
    return 1 if any(row["result"] == "FAIL" for row in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
