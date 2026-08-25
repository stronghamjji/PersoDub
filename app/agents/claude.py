"""Claude Code's stream-json dialect -> our five events.

Recorded shapes (2026-08-24, `claude -p --output-format stream-json --verbose`):

    {"type":"system","subtype":"init","model":...}
    {"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
    {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
    {"type":"stream_event","event":{"delta":{"text":...}}}   (--include-partial-messages)
    {"type":"result","result":...}

translate() is a pure function so it can be tested against recorded lines
without a CLI installed -- see tests/test_agents_claude.py.
"""
from typing import List

# What each handle is called on screen. The agent reaches our script tools
# through MCP, which prefixes them with the server name.
TOOL_LABELS = {
    "get_script": "Reading the script",
    "edit_script_line": "Rewriting a line",
    "check_fit": "Checking the timing",
    "export_script": "Exporting the script",
    "get_job_status": "Checking progress",
    "remake_voices": "Remaking every voice",
    "remake_line_voice": "Remaking this line",
}

MCP_PREFIX = "mcp__persodub__"


def _tool_name(raw: str) -> str:
    return raw[len(MCP_PREFIX):] if raw.startswith(MCP_PREFIX) else raw


def translate(event: dict) -> List[dict]:
    """One line of Claude Code's output -> zero or more of our events.

    Never raises on an unfamiliar line: a new event type from a CLI update
    should leave the panel working, not blank it.
    """
    if not isinstance(event, dict):
        return []
    kind = event.get("type")

    if kind == "system" and event.get("subtype") == "init":
        return [{"kind": "start", "model": event.get("model")}]

    if kind == "assistant":
        # Only tool calls. The text in a finished assistant block repeats what
        # the partial deltas already streamed -- measured 2026-08-24, the answer
        # showed up three times. The `result` line is the fallback when a run
        # produces no deltas at all.
        out = []
        for block in (event.get("message") or {}).get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                name = _tool_name(block.get("name") or "")
                out.append({
                    "kind": "progress",
                    "tool": name,
                    "label": TOOL_LABELS.get(name, f"Running {name}"),
                })
        return out

    # A tool result is bookkeeping between the agent and its tools. Showing it
    # would put raw JSON in front of the user.
    if kind == "user":
        return []

    if kind == "stream_event":
        delta = (event.get("event") or {}).get("delta") or {}
        if delta.get("text"):
            return [{"kind": "text", "text": delta["text"]}]
        return []

    if kind == "result":
        text = event.get("result")
        if not isinstance(text, str):
            text = ""
        if event.get("is_error"):
            return [{"kind": "error", "message": text or "The assistant stopped before finishing."}]
        return [{"kind": "done", "text": text}]

    return []


# Built-ins to shut off. Measured 2026-08-24: --allowedTools on its own does NOT
# hide the rest -- the CLI still listed Read, Bash, Write and WebSearch when
# asked what it could do. A denylist is the blunt half of the fence and it can
# fall behind a CLI update, so the real guarantee stays the narrow tool surface
# in app/mcp_server.py: what is not there cannot be reached.
DENIED_TOOLS = [
    "Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch",
    "Agent", "Task", "Skill", "Workflow", "ToolSearch", "SendMessage",
    "Glob", "Grep", "CronCreate", "CronDelete", "CronList", "RemoteTrigger",
    "PushNotification", "Monitor", "ScheduleWakeup", "EnterWorktree",
    "ExitWorktree", "ListAgents", "TaskOutput", "TaskStop", "DesignSync",
    "ReportFindings", "ListMcpResourcesTool", "ReadMcpResourceTool",
    "ReadMcpResourceDirTool",
]

SYSTEM_PROMPT = (
    "You are PersoDub's script assistant. You help the user fix the dubbing "
    "script -- the lines a synthetic voice will read -- and nothing else. "
    "Every line has a fixed slot of time; a line too long to be spoken inside "
    "it has fits=false. Use only the persodub tools. Never change timings. "
    "When the user asks for the dub to be remade, call remake_voices yourself; "
    "do not tell them to press a button. Answer in the user's language, briefly."
)


# Offered in the panel's model picker. Aliases, not version numbers: an alias
# keeps pointing at the current model of that size, so this list does not go
# stale the way "claude-opus-4-5" would. (2026-08-24: this is what let the model
# picker happen at all -- the morning's decision was to leave models out
# precisely because a hardcoded list rots.)
MODELS = ["fable", "opus", "sonnet", "haiku"]


def command(prompt: str, mcp_config: str, resume: bool, model: str = "") -> List[str]:
    """The command line to run for one message.

    --strict-mcp-config matters as much as the deny list: without it the user's
    own MCP servers come along, so the assistant would reach tools this app
    never offered it.
    """
    tools = ",".join(MCP_PREFIX + name for name in TOOL_LABELS)
    args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--mcp-config", mcp_config,
        "--strict-mcp-config",
        "--allowedTools", tools,
        "--disallowedTools", ",".join(DENIED_TOOLS),
        "--system-prompt", SYSTEM_PROMPT,
    ]
    if model in MODELS:
        args += ["--model", model]
    if resume:
        args.append("-c")
    return args
