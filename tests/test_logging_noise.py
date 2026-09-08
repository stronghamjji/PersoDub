"""asyncio's client-disconnect report stays out of the log (2026-09-08)."""
import logging

from app import logging_setup


class _Catch(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


def test_client_disconnect_noise_is_dropped_and_real_asyncio_errors_kept():
    logging_setup.configure_logging()
    log = logging.getLogger("asyncio")
    catch = _Catch()
    log.addHandler(catch)
    try:
        log.error("Exception in callback _ProactorBasePipeTransport._call_connection_lost(None)")
        try:
            raise ConnectionResetError(10054, "connection reset")
        except ConnectionResetError:
            log.error("Fatal error on transport", exc_info=True)
        log.error("Task exception was never retrieved")
    finally:
        log.removeHandler(catch)
    assert [r.getMessage() for r in catch.records] == ["Task exception was never retrieved"]


def test_the_filter_is_added_once():
    logging_setup.configure_logging()
    logging_setup.configure_logging()
    n = sum(isinstance(f, logging_setup._ClientWentAway) for f in logging.getLogger("asyncio").filters)
    assert n == 1
