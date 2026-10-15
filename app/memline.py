"""One line of memory figures for a job's log.

"Mem[Host total 24576M avail 11376M | backend 310M | engine 8200M |
ollama-runtime 1200M]", in MiB: the computer's memory and how much of it is
still available, this process, and the two pack processes the desktop shell
started, found by the pids it writes into runtime.json (app/runtime.py pid).
Each of the three counts with every process it started: the memory is often
in a child -- the backend's Demucs and Whisper workers, Ollama's model runner,
the real engine under the uvicorn launcher on Windows. app/jobs.py writes the
line beside every step's START and DONE, so a job that runs out of memory
leaves the figures that led up to it.

psutil is imported only when a line is asked for, and nothing here may fail or
slow a job: a process that cannot be measured is left out of the line, and
without psutil there is no line at all.
"""
import contextlib
from typing import Optional

from app import runtime

_MIB = 1024 * 1024

# Each pack as the shell names it, and the runtime.json pid key it is under.
_PACKS = (("engine", "tts"), ("ollama-runtime", "ollama"))


def _tree_mib(proc) -> int:
    """A process and all its descendants, resident memory summed, in MiB."""
    rss = proc.memory_info().rss
    for child in proc.children(recursive=True):
        with contextlib.suppress(Exception):   # one that ended mid-walk
            rss += child.memory_info().rss
    return round(rss / _MIB)


def mem_line() -> Optional[str]:
    """The line, or None when psutil or the computer's figures cannot be had."""
    try:
        import psutil

        host = psutil.virtual_memory()
        parts = [f"Host total {round(host.total / _MIB)}M avail {round(host.available / _MIB)}M",
                 f"backend {_tree_mib(psutil.Process())}M"]
    except Exception:
        return None
    for label, pack in _PACKS:
        # Not started, gone, or not ours to read: that part is left out.
        with contextlib.suppress(Exception):
            pid = runtime.pid(pack)
            if pid:
                parts.append(f"{label} {_tree_mib(psutil.Process(pid))}M")
    return "Mem[%s]" % " | ".join(parts)
