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

    if kind == "error":
        # A transport complaint, not the end of the turn. Recorded 2026-08-26
        # against an empty CODEX_HOME: a failing run printed eleven of these
        # ("Reconnecting... 2/5 (unexpected status 401 ...)") and then said how
        # it really ended with turn.failed. Showing them keeps a turn that dies
        # quietly from reading as "(empty answer)".
        return [_transport_error(event.get("message"))]

    return []


def _transport_error(message) -> dict:
    """One of Codex's connection complaints, as a step rather than a failure.

    Grey, never red: a run that reconnects and then answers perfectly well
    prints several of these, so showing them as errors would put a red line
    under a good answer. The turn's real ending still comes through turn.failed,
    which is red. Trimmed because a chip is one line, and these carry a URL and
    a trace id that say nothing to the person reading them.
    """
    if not isinstance(message, str) or not message:
        message = "The assistant lost its connection."
    if len(message) > 120:
        message = message[:119].rstrip() + "…"
    return {"kind": "progress", "tool": "transport", "label": message}


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
            # ends_turn: the agent usually carries on after a tool refuses it,
            # so this must not be mistaken for the end -- otherwise a turn that
            # then dies loses the exit code and the stderr behind it.
            return [{"kind": "error", "ends_turn": False,
                     "message": "%s failed: %s"
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

    if what == "error":
        # The same transport chatter, wrapped as an item ("Falling back from
        # WebSockets to HTTPS transport."). Only once, on completion.
        if kind == "item.completed":
            return [_transport_error(item.get("message"))]
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
# CLI itself and Codex answers with whatever the user set it up to use -- so
# nothing here passes -m, and there is no half-built model path to trip over.
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

    What --ignore-user-config does NOT cover: it skips ~/.codex/config.toml and
    nothing else. $CODEX_HOME/AGENTS.md -- whatever standing instructions the
    user keeps for their own Codex work -- still rides into every turn, and
    neither project_doc_max_bytes nor project_doc_fallback_filenames suppresses
    it. Pointing CODEX_HOME somewhere private would, but the user's login lives
    there too, so that trade is not ours to make quietly.

    `model` is accepted to match the other drivers and deliberately unused:
    MODELS is empty, so the picker never offers one and Codex answers with
    whatever the user set it up to use.
    """
    with open(mcp_config, encoding="utf-8") as f:
        server = json.load(f)["mcpServers"]["persodub"]

    settings = [
        # Headless Codex refuses every MCP tool call unless a reviewer is named:
        # the approval prompt goes to a terminal that is not there, EOF reads as
        # "no", and the call is cancelled (openai/codex#24135). The CLI says
        # "approval policy is never" whatever the policy actually is -- measured
        # 2026-08-26 with approval_policy="on-request" and NO reviewer, which
        # got that exact refusal and a turn that changed nothing. So it is
        # `approvals_reviewer`, not the policy, that makes the script tools
        # reachable, and it cannot simply be dropped.
        #
        # Read what it permits, not just what it fixes. "on-request" lets the
        # model ASK to run a command with escalated privileges, and
        # "auto_review" hands that request to another model rather than to the
        # user -- nobody here is asked. `codex exec --help` says of its flag
        # form: "Route approval requests through automatic review using the
        # workspace-write sandbox". So read-only is the FLOOR, not the ceiling:
        # an escalation another model approves runs with write access to the
        # working directory, which is the app's own agent folder. It is not a
        # way out to the rest of the disk, and it is the same folder the run
        # could write to before read-only -- but it is a write path, and saying
        # otherwise here would be the comment talking the next person into
        # loosening the setting.
        'approvals_reviewer="auto_review"',
        'approval_policy="on-request"',
        # Read-only: Codex keeps a shell that no setting takes away, so the
        # sandbox is the fence. Verified 2026-08-26 that a real turn still
        # rewrites a script through it -- the MCP server is a separate process
        # talking HTTP to this app, so nothing the assistant needs is a write
        # the sandbox can see. Residual risk, and it is not small: read-only
        # stops writes and stops the shell reaching the network, but Codex can
        # still READ any file this user can read, and the model's own uplink
        # can carry it away. Claude's backend denies Read and Bash outright;
        # this one cannot.
        'sandbox_mode="read-only"',
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
        # Every turn asks to resume (the panel never sends the field, so the
        # request default of True stands); with nothing to resume --last starts
        # a new thread instead of failing, which is what makes the first turn
        # after an install work.
        args = ["exec", "resume", "--last", "--json"]
    else:
        args = ["exec", "--json"]
    args += [
        # The agent folder is not a git checkout, and the run must not stop for
        # that. The user's own .rules execpolicy is deliberately left in place:
        # it is a fence they built, and dropping it bought nothing -- a real
        # turn rewrote a script with the file loaded (2026-08-26).
        "--skip-git-repo-check",
        "--ignore-user-config",
    ]
    for setting in settings:
        args += ["-c", setting]
    # Everything above is a -c override rather than a flag on purpose:
    # --approve-for-me does the same as the two approval settings, but it is an
    # option of `codex exec` alone -- `codex exec resume` does not take it -- so
    # the -c form is the only one that works on both paths.
    #
    # Codex has no --system-prompt, so the standing instructions ride in front
    # of the question.
    args.append(SYSTEM_PROMPT + "\n\n" + prompt)
    return args
