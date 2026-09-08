"""One place that decides where the app's own diagnostics go.

Until now the app had no log of its own: a handful of prints went to stderr,
which the Electron shell swallows, and everything else was silent. A user
reporting "it just failed" left nothing behind to read. Every module now logs
under the "persodub" logger, and this file is what gives that logger somewhere
to write -- a rolling persodub.log next to the per-job logs, plus stderr for
whoever is running the app from a terminal.

The per-job logs (app/jobs.py) are untouched by this. They are the user's
progress report, written for the screen; this is the developer's log, written
for a bug report. They share a folder (PERSODUB_LOG_DIR) so there is one place
to ask for when something goes wrong, and nothing else.
"""
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

from app.config import PERSODUB_LOG_DIR

# The one logger everything in app/ hangs off: a module logs to
# "persodub.<module>", which propagates up to here for its handlers.
LOGGER_NAME = "persodub"
LOG_FILE_NAME = "persodub.log"
# ~2 MB a file, three kept. A dub writes tens of lines, so this is months of
# use -- big enough to hold the run before the one that broke, small enough to
# attach to an issue.
MAX_BYTES = 2 * 1024 * 1024
BACKUP_COUNT = 3
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


class _ClientWentAway(logging.Filter):
    """Drops asyncio's report of a client that hung up mid-response.

    On Windows the proactor loop logs "Exception in callback
    _ProactorBasePipeTransport._call_connection_lost" with a
    ConnectionResetError traceback every time the page closes a request early
    (a video seek, a reload). Nothing went wrong on our side; three of these
    sat in backend.log after one afternoon (2026-09-08)."""

    def filter(self, record: logging.LogRecord) -> bool:
        text = record.getMessage()
        if record.exc_info and record.exc_info[1] is not None:
            text += " " + type(record.exc_info[1]).__name__
        return not ("_call_connection_lost" in text or "ConnectionResetError" in text)


def configure_logging() -> logging.Logger:
    """Give the "persodub" logger its handlers. Safe to call twice.

    Idempotent because the app is started in more than one way (uvicorn, the
    desktop shell, a test that enters the lifespan) and a second pass that
    added a second pair of handlers would double every line.

    A log directory that cannot be made is not a reason to refuse to start:
    the console handler is enough to keep the app usable, so the file handler
    is skipped with one warning instead.
    """
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.DEBUG if os.environ.get("PERSODUB_DEBUG") == "1" else logging.INFO)
    if logger.handlers:
        return logger
    asyncio_log = logging.getLogger("asyncio")
    if not any(isinstance(f, _ClientWentAway) for f in asyncio_log.filters):
        asyncio_log.addFilter(_ClientWentAway())

    formatter = logging.Formatter(LOG_FORMAT)
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(formatter)
    logger.addHandler(console)

    try:
        os.makedirs(PERSODUB_LOG_DIR, exist_ok=True)
        file_handler = RotatingFileHandler(
            os.path.join(PERSODUB_LOG_DIR, LOG_FILE_NAME),
            maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except OSError as e:
        logger.warning("No app log file: %s could not be opened (%s)",
                       PERSODUB_LOG_DIR, type(e).__name__)
    return logger
