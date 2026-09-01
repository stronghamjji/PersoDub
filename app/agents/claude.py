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
from typing import List, Optional

# What each handle is called on screen. The agent reaches our script tools
# through MCP, which prefixes them with the server name.
TOOL_LABELS = {
    "get_script": "Reading the script",
    "edit_script_line": "Rewriting a line",
    "check_fit": "Checking the timing",
    "export_script": "Exporting the script",
    "get_job_status": "Checking progress",
    "remake_voices": "Remaking the changed voices",
    "remake_line_voice": "Remaking this line",
    "change_speaker": "Changing the speaker",
    "extract_subtitles": "Extracting subtitles",
    "cut_clip": "Cutting a clip",
    "list_videos": "Looking through a folder",
    "queue_dub": "Queueing a dub",
    "cancel_dub": "Cancelling a dub",
    "burn_subtitles": "Subtitling a video",
}

MCP_PREFIX = "mcp__persodub__"


def _tool_name(raw: str) -> str:
    return raw[len(MCP_PREFIX):] if raw.startswith(MCP_PREFIX) else raw


def line_arg(args) -> Optional[int]:
    """Which script line this tool call names, when it names one.

    Every tool that works on one line takes it as `line` (see app/mcp_server.py).
    The panel puts a run of calls to the same tool in a single chip and lists the
    lines, so twenty rewritten lines read as one step rather than twenty. A tool
    that names no line -- get_script, remake_voices -- simply has none, and this
    is shared with the other backends so the chip says the same thing whichever
    CLI is behind it.
    """
    if not isinstance(args, dict):
        return None
    line = args.get("line")
    # bool is an int in Python, and True is not line 1.
    if isinstance(line, bool) or not isinstance(line, int):
        return None
    return line


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
                step = {
                    "kind": "progress",
                    "tool": name,
                    "label": TOOL_LABELS.get(name, f"Running {name}"),
                }
                line = line_arg(block.get("input"))
                if line is not None:
                    step["line"] = line
                out.append(step)
        return out

    # A tool result is bookkeeping between the agent and its tools, and its
    # content is raw JSON that never goes on screen. What does go on screen is
    # the bare fact that one call has landed: the panel puts a run of calls to
    # the same tool in one chip ("Rewriting lines 1, 3 · 1 of 2") and ticks it
    # when the last of them is back. The block names its call by id and not by
    # tool, so nothing here says WHICH call finished -- the panel is only ever
    # counting the chip it is already showing.
    if kind == "user":
        blocks = (event.get("message") or {}).get("content") or []
        return [{"kind": "progress", "done": True} for b in blocks
                if isinstance(b, dict) and b.get("type") == "tool_result"]

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
    "When the user asks for the voices to be remade, call remake_voices "
    "yourself -- it respeaks only the lines whose words changed and rebuilds "
    "the video in place -- and do not tell them to press a button. "
    "A Perso-dubbed job reads its script from Perso and starts read-only; "
    "the screen's Make-it-editable button fetches it, and from then on its "
    "lines edit and remake normally. change_speaker can give a line a new "
    "voice on Perso's side. extract_subtitles pulls the spoken lines out of "
    "any video file on this computer into an .srt beside it -- the user "
    "names the file (list_videos shows a folder's videos when they name a folder instead). queue_dub starts a whole new dub of a video file -- for several videos, gather the estimates and ask the user once with the total. cancel_dub takes a waiting dub out of the line or stops a running one. burn_subtitles lays an .srt onto a video as a new file, in one of ten looks (clean, bold-punch, sticker, neon-yellow, soft-card, rainbow, broadcast, streaming, lower-bar, neon). cut_clip cuts a stretch of a video file into a new clip "
    "beside it, free and on this machine. Any tool answer with needs_confirmation=true may spend Perso "
    "credits: relay its message to the user as a question, and call the tool "
    "again with confirm=true only after they clearly agree. Answer in "
    "the user's language, briefly. "
    "Your tools are exactly the ones offered to you on THIS turn: the app "
    "updates between turns, and tools appear that did not exist before. If "
    "you said earlier in this conversation that you cannot do something, "
    "check the current tool list before saying it again -- an old refusal "
    "proves nothing about now."
)


# Offered in the panel's model picker. Aliases, not version numbers: an alias
# keeps pointing at the current model of that size, so this list does not go
# stale the way "claude-opus-4-5" would. (2026-08-24: this is what let the model
# picker happen at all -- the morning's decision was to leave models out
# precisely because a hardcoded list rots.)
MODELS = ["fable", "opus", "sonnet", "haiku"]


def stdin_text(prompt: str) -> str:
    """What run() pipes to the CLI's stdin: the question, verbatim.

    The prompt used to ride argv after -p. On Windows the CLI is an npm .cmd
    shim, and cmd.exe cuts a shim's command line at the first newline -- which
    the prompt always has (job context + blank line + question). The question
    AND every flag after it silently vanished: no --output-format left the
    output unreadable ("(empty answer)" in the panel), and no tool fences left
    the assistant running with its default tools. Piped to stdin, the text
    never touches the command line on any platform.
    """
    return prompt


def command(mcp_config: str, resume: bool, model: str = "") -> List[str]:
    """The command line to run for one message. The question itself is not on
    it -- see stdin_text.

    --strict-mcp-config matters as much as the deny list: without it the user's
    own MCP servers come along, so the assistant would reach tools this app
    never offered it.
    """
    tools = ",".join(MCP_PREFIX + name for name in TOOL_LABELS)
    args = [
        "-p",
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
