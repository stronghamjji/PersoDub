# -*- coding: utf-8 -*-
"""Codex's `exec --json` dialect -> our five events.

Recorded shapes (2026-08-26, codex-cli 0.149.0, `codex exec --json`):

    {"type":"thread.started","thread_id":...}
    {"type":"turn.started"}
    {"type":"item.started","item":{"type":"mcp_tool_call","tool":...,"status":...}}
    {"type":"item.completed","item":{"type":"agent_message","text":...}}
    {"type":"turn.completed","usage":{...}}

Two things separate this CLI from Claude Code. It streams nothing partial, so a
finished agent_message is the answer rather than a repeat of it; and it will not
let an MCP tool call through headless unless a reviewer is named -- see
command() below.

translate() is a pure function so it can be tested against recorded lines
without a CLI installed -- see tests/test_agents_codex.py.
"""
import json
from typing import List

# The chat panel's own vocabulary, shared with the other backends: which CLI is
# behind the strip must not change what a step is called on screen.
from app.agents.claude import SYSTEM_PROMPT, TOOL_LABELS


def translate(event: dict) -> List[dict]:
    """One line of Codex's JSONL -> zero or more of our events.

    Never raises on an unfamiliar line: a new event type from a CLI update
    should leave the panel working, not blank it.
    """
    if not isinstance(event, dict):
        return []
    kind = event.get("type")

    if kind == "thread.started":
        # Codex names the thread, never the model. The key is passed on anyway
        # so the panel starts saying so by itself the day the CLI reports it.
        return [{"kind": "start", "model": event.get("model")}]

    if kind in ("item.started", "item.completed"):
        item = event.get("item")
        if not isinstance(item, dict):
            return []
        return _item(kind, item)

    if kind == "turn.completed":
        # The text has already gone out as agent_message events.
        return [{"kind": "done", "text": ""}]

    if kind == "turn.failed":
        message = ((event.get("error") or {}).get("message")
                   or "The assistant stopped before finishing.")
        return [{"kind": "error", "message": message}]

    return []


def _item(kind: str, item: dict) -> List[dict]:
    """The half of the stream that is about one thing the agent did."""
    what = item.get("type")

    if what == "mcp_tool_call":
        if kind == "item.started":
            name = item.get("tool") or ""
            return [{"kind": "progress", "tool": name,
                     "label": TOOL_LABELS.get(name, "Running %s" % name)}]
        error = item.get("error") or {}
        if error.get("message"):
            return [{"kind": "error", "message": "%s failed: %s"
                     % (item.get("tool") or "the tool", error["message"])}]
        # A finished call is bookkeeping between the agent and its tools.
        return []

    if what == "command_execution":
        # Codex keeps a shell that no setting takes away, so the honest thing is
        # to show that it went off to run something rather than hide it.
        if kind == "item.started":
            return [{"kind": "progress", "tool": "shell",
                     "label": "Running a command"}]
        return []

    if what == "agent_message" and kind == "item.completed":
        text = item.get("text")
        if not isinstance(text, str) or not text:
            return []
        # Codex answers in whole messages, often a preamble and then the answer.
        # The newline is what keeps the two from reading as one sentence.
        return [{"kind": "text", "text": text + "\n"}]

    return []


# Codex names its models by version ("gpt-5.5"), and a list of those in the
# picker would go stale with the next release. Empty means the picker offers the
# CLI itself and Codex answers with whatever the user set it up to use.
MODELS: List[str] = []


def _toml(value) -> str:
    """A Python value as the TOML literal `codex -c key=value` expects.

    JSON and TOML agree on strings, numbers and arrays. They do not agree on
    tables: TOML writes `{ a = "b" }` where JSON writes `{"a": "b"}`, and Codex
    answers the JSON form with `expected a map` -- which is what it did the
    first time the panel ran a real turn (2026-08-26).
    """
    if isinstance(value, dict):
        return "{ %s }" % ", ".join(
            "%s = %s" % (json.dumps(k, ensure_ascii=False), _toml(v))
            for k, v in value.items())
    return json.dumps(value, ensure_ascii=False)


def command(prompt: str, mcp_config: str, resume: bool, model: str = "") -> List[str]:
    """The command line to run for one message.

    Codex has no --mcp-config, so the server written by base.write_mcp_config is
    read back here and handed over as -c overrides. --ignore-user-config is the
    other half of that fence: without it the user's own MCP servers come along
    and the assistant reaches tools this app never offered it.
    """
    with open(mcp_config, encoding="utf-8") as f:
        server = json.load(f)["mcpServers"]["persodub"]

    settings = [
        # Headless Codex refuses every MCP tool call unless a reviewer is named:
        # the approval prompt goes to a terminal that is not there, and the call
        # is cancelled (measured 2026-08-26; openai/codex#24135). These three
        # are what make the script tools reachable at all.
        'approvals_reviewer="auto_review"',
        'approval_policy="on-request"',
        'sandbox_mode="workspace-write"',
        # The user's skills and the web are not this assistant's business. Left
        # on, the first run went off and read a skill file off the disk.
        "skills.include_instructions=false",
        "tools.web_search=false",
        "mcp_servers.persodub.command=%s" % _toml(server["command"]),
        "mcp_servers.persodub.args=%s" % _toml(server["args"]),
        "mcp_servers.persodub.env=%s" % _toml(server["env"]),
    ]

    if resume:
        # --last is filtered by working directory, and ours is the app's own
        # agent folder -- so this cannot pick up the user's own Codex session.
        args = ["exec", "resume", "--last", "--json"]
    else:
        args = ["exec", "--json"]
    args += [
        # The agent folder is not a git checkout, and the run must not stop for
        # that or for anything the user wrote into an execpolicy file.
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
    ]
    for setting in settings:
        args += ["-c", setting]
    if model:
        args += ["-m", model]
    # Codex has no --system-prompt, so the standing instructions ride in front
    # of the question.
    args.append(SYSTEM_PROMPT + "\n\n" + prompt)
    return args
