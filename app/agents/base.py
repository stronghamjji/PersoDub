# -*- coding: utf-8 -*-
"""Running one CLI agent turn and reading what it says back.

The CLI is spawned, its stdout is read a line at a time as JSON, and each line
is handed to that CLI's translator (app/agents/claude.py and friends). Whatever
the translator returns is what the chat panel shows -- nothing here knows a
vendor's format.

A line that is not JSON is dropped. CLIs and their dependencies do print the odd
banner or warning, and one stray line must not blank the panel mid-answer.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
from typing import Callable, Iterator, List, Optional

# A GUI app does not inherit the login shell's PATH, so `claude` can be on the
# PATH in Terminal and missing here. Look where these installers actually put
# things before giving up.
EXTRA_PATHS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.bun/bin"),
    os.path.expanduser("~/.npm-global/bin"),
]

TIMEOUT_SECONDS = float(os.environ.get("PERSODUB_AGENT_TIMEOUT", "180"))


def find_cli(name: str) -> Optional[str]:
    """Where this CLI lives, or None if it is not installed."""
    found = shutil.which(name)
    if found:
        return found
    for d in EXTRA_PATHS:
        candidate = os.path.join(d, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def write_mcp_config(dir_path: str, api_url: str) -> str:
    """Write the file that tells a CLI where PersoDub's script tools are.

    Written into the app's own folder, never into the user's global CLI config:
    their everyday setup must keep working exactly as it did.
    """
    # Absolute: the CLI runs with its cwd set to this folder, so a relative path
    # would be resolved against it a second time.
    dir_path = os.path.abspath(dir_path)
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, "persodub-mcp.json")
    config = {
        "mcpServers": {
            "persodub": {
                "command": sys.executable,
                "args": ["-m", "app.mcp_server"],
                "env": {
                    "PERSODUB_API": api_url,
                    # -m needs the repo on the path; cwd is not ours to assume.
                    "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.dirname(
                        os.path.abspath(__file__)))),
                },
            }
        }
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return path


def run(binary: str, args: List[str], translate: Callable[[dict], List[dict]],
        cwd: Optional[str] = None) -> Iterator[dict]:
    """Spawn one turn and yield our events as they arrive.

    Yields an error event rather than raising: a failed turn is something the
    panel shows in a bubble, not a crash.
    """
    try:
        proc = subprocess.Popen(
            [binary] + args,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=cwd, text=True, encoding="utf-8", bufsize=1,
        )
    except OSError as e:
        yield {"kind": "error", "message": "도우미를 실행하지 못했습니다: %s" % e}
        return

    timer = threading.Timer(TIMEOUT_SECONDS, proc.kill)
    timer.start()
    saw_done = False
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue  # a banner or a warning, not part of the stream
            for out in translate(event):
                if out.get("kind") in ("done", "error"):
                    saw_done = True
                yield out
    finally:
        timer.cancel()
        proc.stdout.close()
        code = proc.wait()
        stderr = (proc.stderr.read() or "").strip()
        proc.stderr.close()

    if code != 0 and not saw_done:
        yield {"kind": "error",
               "message": "도우미가 %d번 오류로 멈췄습니다. %s" % (code, stderr[:300])}
    elif not saw_done:
        yield {"kind": "done", "text": ""}
