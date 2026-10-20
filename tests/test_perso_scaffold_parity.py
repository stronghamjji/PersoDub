"""The three wrappers around a call to Perso, side by side, pinned as they are.

app/pipeline.py wraps Perso's voice/background separation (_separate_with_perso,
reached through _stage_separate) and Perso's transcription
(_stage_transcribe_perso); app/dub_launch.py wraps the whole cloud dub
(run_cloud_dub). Each does the same things around its one call -- make a
client, say which workspace pays, watch the credits, count what the call cost,
turn a failure into a sentence -- each in its own copy, and the copies differ:

1. A workspace with no name: the two stages log "workspace 7 (#7)", the cloud
   dub "7 (#7)".
2. A client that cannot be made: all three make it inside their `try` (`ws`
   set to None first, as the `finally` reads it) and fail as a failed call
   does: Perso refusing the workspace lookup reads as the four refusals
   below, and any other error goes as 3 says.
3. An error no except clause names: all three reword it (the address cut out)
   and warn in the app log, but the cloud dub passes a RuntimeError through
   as it is: the app's own sentences (app/perso_client.py), already worded
   for the screen.
4. The credits: the same "Perso credits used: N" line, as soon as the call
   returns, on all three -- before transcription reads Perso's answer, so
   an empty one that fails the stage is counted too. The label each hands
   note_credits (in the debug log only) differs.
5. Cancel: the stages give the client the caller's cancel_check, the cloud dub
   the job's own cancel flag.

The same on all three, and pinned here for the same reason: the four Perso
refusals, a cancel passed through as it is, and a failed call that closes its
credit watch.

Each test runs all three on a fake client and looks up each one's answer in a
table beside it, so a refactor that folds them into one helper keeps every
byte the user sees -- or changes it on purpose, one row at a time.
"""
import logging
import os
import re

import httpx
import pytest

from app import dub_launch, languages, media, perso_client, pipeline, state
from app.jobs import JobCancelled, error_text_for_ui
from app.perso_client import (
    PersoCreditExhaustedError,
    PersoInvalidKeyError,
    PersoProjectFailedError,
    PersoUnavailableError,
)

SCAFFOLDS = ["separation", "transcription", "cloud-dub"]

HEADER = {
    "separation": "1/6 Separating background audio via Perso cloud…",
    "transcription": "2/6 Running Perso STT (diarization & timestamps)…",
    "cloud-dub": "1/1 Dubbing in the Perso cloud…",
}
WORKSPACE = "   Perso workspace: Studio (#7)"
OWN_LINE = "   (dub_video's own progress lines)"
SPEECH = [{"text_original": "hello there", "speaker_name": "SPK0", "words": [[{"start": 0.0, "end": 2.0}]]}]


class FakePerso:
    """A Perso client without the network. Workspace "Studio" (#7) holds 100
    credits until the call runs and `after` once it has; `fail` is raised by
    the call instead; `answer` is what transcribe returns."""

    def __init__(self, name="Studio", after=94, fail=None, answer=None):
        self.cancel_check = None
        self.credits_used = 0
        self.space = {"seq": 7, "name": name, "credits": 100}
        self.after = after
        self.fail = fail
        self.answer = SPEECH if answer is None else answer

    def describe_workspace(self):
        return dict(self.space)

    def _call(self):
        if self.fail is not None:
            raise self.fail
        self.space["credits"] = self.after

    def separate(self, video_path, out_dir):
        self._call()
        return {"vocals": os.path.join(out_dir, "perso_vocals.wav"),
                "background": os.path.join(out_dir, "perso_background.wav")}

    def transcribe(self, video_path):
        self._call()
        return self.answer

    def dub_video(self, video_path, out_path, source_code, target_code, log=None, **kw):
        self._call()
        log(OWN_LINE)


class Outcome:
    def __init__(self):
        self.lines, self.notices = [], []
        self.result = self.error = self.jid = None


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    # A watch another test left open would turn every credits line here into
    # "not counted": each test starts with none.
    monkeypatch.setattr(perso_client, "_WATCHES_OPEN", {})
    monkeypatch.setattr(perso_client, "_WATCHES_CLOSED", [])
    monkeypatch.setattr(languages, "_fetch", lambda: None)            # the bundled language list
    monkeypatch.setattr(media, "video_duration", lambda path: 12.0)   # the cloud dub's length probe


@pytest.fixture
def drive(monkeypatch, tmp_path):
    """drive(scaffold, client, cancel_check=None, log=None) -> Outcome; never raises.

    Each is called the way its caller calls it: the two stages with the client
    handed in (run_dub's perso_client; None makes the real one), the cloud dub
    with PersoClient replaced, since it always makes its own. The cloud dub's
    notices are read back off its job record. `log` stands in for a job's log
    (out.lines collects nothing then)."""
    jids = []

    def run(scaffold, client, cancel_check=None, log=None):
        out = Outcome()
        log = log or out.lines.append
        video = str(tmp_path / "in.mp4")
        try:
            if scaffold == "separation":
                out.result = pipeline._stage_separate(video, str(tmp_path), "perso", client, cancel_check,
                                                      out.notices.append, log)
            elif scaffold == "transcription":
                out.result = pipeline._stage_transcribe_perso(video, client, cancel_check,
                                                              out.notices.append, log)
            else:
                if client is not None:
                    monkeypatch.setattr(perso_client, "PersoClient", lambda: client)
                out.jid = state.job_store.create()
                jids.append(out.jid)
                out.result = dub_launch.run_cloud_dub(out.jid, video, str(tmp_path / "dubbed.mp4"),
                                                      "en", "ko", None, log)
        except Exception as e:
            out.error = e
        if out.jid:
            out.notices.extend(state.job_store.get(out.jid)["notices"])
        return out

    yield run
    for jid in jids:
        state.job_store.forget(jid)


def _timed(lines):
    """The separation stage says how long it took; the seconds are not pinned."""
    return [re.sub(r"Separated in \d+ s", "Separated in N s", line) for line in lines]


# ── a call that works ──────────────────────────────────────────────────────

WORKED = {
    "separation": [HEADER["separation"], WORKSPACE, "   Perso credits used: 6",
                   "   Separated in N s with Perso: perso_vocals.wav, perso_background.wav"],
    "transcription": [HEADER["transcription"], WORKSPACE, "   Perso credits used: 6"],
    "cloud-dub": [HEADER["cloud-dub"], WORKSPACE, OWN_LINE, "   Perso credits used: 6"],
}


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_a_paid_call_that_works(drive, tmp_path, scaffold):
    client = FakePerso()
    out = drive(scaffold, client)
    assert out.error is None
    assert _timed(out.lines) == WORKED[scaffold]
    assert out.notices == []
    # Added to the client's running total, which the finished job reports.
    assert client.credits_used == 6
    expected = {
        # (vocals, background, the client the STT stage reuses, the model)
        "separation": (str(tmp_path / "perso_vocals.wav"), str(tmp_path / "perso_background.wav"), client, "Perso"),
        # (the lines, the client the job reads the credits off)
        "transcription": ([{"start": 0.0, "end": 2.0, "text": "hello there", "speaker_id": "SPK0"}], client),
        "cloud-dub": {"job_id": out.jid, "out_path": str(tmp_path / "dubbed.mp4"), "num_segments": 0,
                      "dub_mode": "perso", "perso_credits": 6, "duration": 12.0},
    }[scaffold]
    assert out.result == expected


# ── difference 1: a workspace with no name ─────────────────────────────────

UNNAMED_WORKSPACE = {
    "separation": "   Perso workspace: workspace 7 (#7)",
    "transcription": "   Perso workspace: workspace 7 (#7)",
    "cloud-dub": "   Perso workspace: 7 (#7)",
}


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_a_workspace_with_no_name(drive, scaffold):
    out = drive(scaffold, FakePerso(name=None))
    assert out.error is None
    assert [x for x in out.lines if x.startswith("   Perso workspace:")] == [UNNAMED_WORKSPACE[scaffold]]


# ── difference 2: a client that cannot be made ─────────────────────────────

NO_KEY = "PERSO_API_KEY environment variable is not set"
# The reason last, in parentheses: on screen it is a line of its own under
# the sentence (the job's error_detail), and in one sentence the screen cut
# the sentence at the reason's first colon.
SEP_NO_KEY = ("Perso separation failed. Check Settings, or switch separation back to Local. "
              "Ask Perso if it keeps happening. (Reason: PERSO_API_KEY environment variable is not set)")
STT_NO_KEY = ("Perso STT failed. Check Settings, or switch to Whisper (free, offline). "
              "Ask Perso if it keeps happening. (Reason: PERSO_API_KEY environment variable is not set)")
CLOUD_NO_KEY = ("Perso dubbing failed. Check Settings, or use this computer for dubbing. "
                "Ask Perso if it keeps happening. (Reason: PERSO_API_KEY environment variable is not set)")

# (the job log, what is raised, what the done screen says, the error the raised one replaced)
NO_CLIENT = {
    "separation": ([HEADER["separation"], "   Error: " + SEP_NO_KEY], RuntimeError, SEP_NO_KEY, NO_KEY),
    "transcription": ([HEADER["transcription"], "   Error: " + STT_NO_KEY], RuntimeError, STT_NO_KEY, NO_KEY),
    "cloud-dub": ([HEADER["cloud-dub"], "   Error: " + CLOUD_NO_KEY], RuntimeError, CLOUD_NO_KEY, NO_KEY),
}


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_a_client_that_cannot_be_made(drive, monkeypatch, scaffold):
    # The real PersoClient, with no key anywhere: it refuses before any network call.
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
    lines, raised, screen, replaced = NO_CLIENT[scaffold]
    out = drive(scaffold, None)
    assert out.lines == lines
    assert type(out.error) is raised
    assert error_text_for_ui(out.error) == screen
    assert (str(out.error.__context__) if out.error.__context__ else None) == replaced
    assert out.notices == []


@pytest.fixture
def unpinned_key(monkeypatch):
    """The real PersoClient with a key and no workspace pinned anywhere:
    making it asks Perso which workspace the key belongs to."""
    monkeypatch.delenv("PERSODUB_KIT_DIR", raising=False)
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    monkeypatch.setenv("PERSO_API_KEY", "test-key")


OFFLINE = "[Errno 8] nodename nor servname provided, or not known"
SEP_OFFLINE = ("Perso separation failed. Check Settings, or switch separation back to Local. "
               "Ask Perso if it keeps happening. (Reason: %s)" % OFFLINE)
STT_OFFLINE = ("Perso STT failed. Check Settings, or switch to Whisper (free, offline). "
               "Ask Perso if it keeps happening. (Reason: %s)" % OFFLINE)
CLOUD_OFFLINE = ("Perso dubbing failed. Check Settings, or use this computer for dubbing. "
                 "Ask Perso if it keeps happening. (Reason: %s)" % OFFLINE)

# (the job log, what the done screen says)
MADE_OFFLINE = {
    "separation": ([HEADER["separation"], "   Error: " + SEP_OFFLINE], SEP_OFFLINE),
    "transcription": ([HEADER["transcription"], "   Error: " + STT_OFFLINE], STT_OFFLINE),
    "cloud-dub": ([HEADER["cloud-dub"], "   Error: " + CLOUD_OFFLINE], CLOUD_OFFLINE),
}


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_a_client_made_offline(drive, unpinned_key, monkeypatch, scaffold):
    """Offline, the workspace lookup fails before any credit watch is open,
    and the `finally` that closes the watch must still run."""
    def offline(url, **kw):
        raise httpx.ConnectError(OFFLINE)

    monkeypatch.setattr(perso_client.httpx, "get", offline)
    lines, screen = MADE_OFFLINE[scaffold]
    out = drive(scaffold, None)
    assert out.lines == lines
    assert error_text_for_ui(out.error) == screen
    assert out.notices == []


# ── difference 3: an error no except clause names ──────────────────────────

ADDRESS = "https://api.perso.ai/file/api/upload/video"
HTTPX_SAID = "Client error '400 Bad Request' for url '%s'" % ADDRESS
SEP_SAID = ("Perso separation failed. Check Settings, or switch separation back to Local. "
            "Ask Perso if it keeps happening. (Reason: Client error '400 Bad Request')")
STT_SAID = ("Perso STT failed. Check Settings, or switch to Whisper (free, offline). "
            "Ask Perso if it keeps happening. (Reason: Client error '400 Bad Request')")
CLOUD_SAID = ("Perso dubbing failed. Check Settings, or use this computer for dubbing. "
              "Ask Perso if it keeps happening. (Reason: Client error '400 Bad Request')")


def _http_400():
    """What httpx raises for a refusal Perso gave no reason for: the text ends in the address."""
    request = httpx.Request("POST", ADDRESS)
    return httpx.HTTPStatusError(HTTPX_SAID, request=request, response=httpx.Response(400, request=request))


# (the job log after the workspace line, what is raised, the done screen, the app log's warnings)
UNNAMED_ERROR = {
    "separation": (["   Error: " + SEP_SAID], "reworded, chained to it", SEP_SAID,
                   [("WARNING", "Perso separation failed: " + HTTPX_SAID)]),
    "transcription": (["   Error: " + STT_SAID], "reworded, chained to it", STT_SAID,
                      [("WARNING", "Perso STT failed: " + HTTPX_SAID)]),
    "cloud-dub": (["   Error: " + CLOUD_SAID], "reworded, chained to it", CLOUD_SAID,
                  [("WARNING", "Perso dubbing failed: " + HTTPX_SAID)]),
}


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_an_error_no_except_clause_names(drive, caplog, scaffold):
    more_lines, raised, screen, app_log = UNNAMED_ERROR[scaffold]
    caplog.set_level(logging.WARNING, logger="persodub")
    boom = _http_400()
    out = drive(scaffold, FakePerso(fail=boom))
    assert out.lines == [HEADER[scaffold], WORKSPACE] + more_lines
    how = ("the error itself" if out.error is boom else
           "reworded, chained to it" if type(out.error) is RuntimeError and out.error.__cause__ is boom else
           repr(out.error))
    assert how == raised
    assert error_text_for_ui(out.error) == screen
    # On screen: the sentence, then the reason on a line of its own.
    assert out.error.shown == screen[:screen.index(" (Reason: ")]
    assert out.error.detail == "Reason: Client error '400 Bad Request'"
    assert out.notices == []
    assert [(r.levelname, r.getMessage()) for r in caplog.records
            if r.name.startswith("persodub") and r.levelno >= logging.WARNING] == app_log


def test_the_cloud_dub_passes_the_apps_own_sentences_through(drive, caplog):
    """A RuntimeError from the client is one of the app's own sentences,
    worded for the screen already. Wrapped, it would run past the 140
    characters the failure card shows, so it goes through as it is."""
    caplog.set_level(logging.WARNING, logger="persodub")
    said = RuntimeError("Perso dubbing finished but the video is not ready to download")
    out = drive("cloud-dub", FakePerso(fail=said))
    assert out.error is said
    assert out.lines == [HEADER["cloud-dub"], WORKSPACE]
    assert out.notices == []
    assert [r for r in caplog.records if r.name.startswith("persodub") and r.levelno >= logging.WARNING] == []


# ── difference 4: counting the credits ─────────────────────────────────────

CREDITS_LABEL = {
    "separation": "Perso separation",
    "transcription": "Perso STT",
    "cloud-dub": "the Perso cloud dub",
}


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_a_balance_that_cannot_be_read_costs_only_the_credits_line(drive, caplog, scaffold):
    """The paid result is kept; the line is left out, and the debug log (only
    written with PERSODUB_DEBUG=1) names the call by the label each scaffold
    hands note_credits."""
    caplog.set_level(logging.DEBUG, logger="persodub.perso_client")
    client = FakePerso(after="a lot")
    out = drive(scaffold, client)
    assert out.error is None
    assert [x for x in out.lines if "credits" in x] == []
    assert client.credits_used == 0
    assert [r.getMessage() for r in caplog.records if r.name == "persodub.perso_client"] == [
        "No credits line after %s (ValueError)" % CREDITS_LABEL[scaffold]]


def test_an_empty_transcript_fails_after_the_credits_are_counted(drive):
    """Transcription only: the other two have no such check. Perso bills the
    call whatever it answers, so the credits are logged as soon as it
    returns, before the answer is read, as the other two log theirs
    (test_a_paid_call_that_works)."""
    client = FakePerso(answer=[])
    out = drive("transcription", client)
    said = ("Perso STT failed. Check Settings, or switch to Whisper (free, offline). "
            "Ask Perso if it keeps happening. (Reason: Perso result is empty)")
    assert out.lines == [HEADER["transcription"], WORKSPACE, "   Perso credits used: 6", "   Error: " + said]
    assert type(out.error) is RuntimeError and str(out.error) == said
    assert client.space["credits"] == 94 and client.credits_used == 6   # what Perso billed, counted


# ── difference 5: what the client polls for a cancel ───────────────────────

POLLS = {
    "separation": "the caller's cancel_check",
    "transcription": "the caller's cancel_check",
    "cloud-dub": "the job's cancel flag",
}


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_what_the_client_polls_for_a_cancel(drive, scaffold):
    def callers_check():
        return False

    client = FakePerso()
    out = drive(scaffold, client, cancel_check=callers_check)
    assert out.error is None
    if client.cancel_check is callers_check:
        got = "the caller's cancel_check"
    else:
        before = client.cancel_check()
        state.job_store.request_cancel(out.jid)
        got = "the job's cancel flag" if (before, client.cancel_check()) == (False, True) else repr(client.cancel_check)
    assert got == POLLS[scaffold]


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_the_client_writes_its_transfers_through_the_jobs_trace(drive, scaffold):
    """The same on all three: the upload's and the downloads' lines
    (app/netlog.py) go into the job's file, through the job's log.trace."""
    def log(msg):
        pass

    log.trace = lambda msg, level="INFO": None
    client = FakePerso()
    assert drive(scaffold, client, log=log).error is None
    assert client.trace is log.trace


# ── the same on all three ──────────────────────────────────────────────────

RECHARGE = "https://perso.ai/recharge"
KEY_REFUSED = "Perso rejected the API key. Open Settings and check the key."
PROJECT_FAILED = ("Perso could not finish this job. Try again, or check the project on Perso. "
                  "Perso said: Audio is too short (VT5001) Ask Perso if it keeps happening.")
UNAVAILABLE = ("Perso's server is temporarily unavailable. Wait a few minutes, then run this job again. "
               "Ask Perso if it keeps happening.")
# On screen Perso's own words give way to its code; they stay in the error.
PROJECT_FAILED_SHOWN = ("Perso could not finish this job. Try again, or check the project on Perso. "
                        "Error code VT5001 Ask Perso if it keeps happening.")


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
@pytest.mark.parametrize("make,line,notice", [
    pytest.param(lambda: PersoCreditExhaustedError(link=RECHARGE),
                 "   Error: Perso credits are used up. Recharge to continue. (%s)" % RECHARGE,
                 {"type": "perso_credit_exhausted", "message": "Perso credits are used up. Recharge to continue.",
                  "link": RECHARGE}, id="credits-used-up"),
    pytest.param(lambda: PersoInvalidKeyError("Perso rejected the API key (HTTP 401)"),
                 "   Error: " + KEY_REFUSED, {"type": "perso_invalid_key", "message": KEY_REFUSED}, id="key-refused"),
    pytest.param(lambda: PersoUnavailableError("Perso server error (HTTP 503)"),
                 "   Error: " + UNAVAILABLE, {"type": "perso_unavailable", "message": UNAVAILABLE}, id="perso-down"),
    pytest.param(lambda: PersoProjectFailedError("Dubbing", reason="Audio is too short", code="VT5001"),
                 "   Error: " + PROJECT_FAILED, {"type": "perso_project_failed", "message": PROJECT_FAILED,
                                              "message_shown": PROJECT_FAILED_SHOWN},
                 id="project-failed"),
])
def test_the_four_perso_refusals_read_the_same_everywhere(drive, scaffold, make, line, notice):
    boom = make()
    out = drive(scaffold, FakePerso(fail=boom))
    assert out.lines == [HEADER[scaffold], WORKSPACE, line]
    # message_shown: the same sentence in the user's language, English here.
    assert out.notices == [{"message_shown": notice["message"], **notice}]
    assert type(out.error) is RuntimeError
    assert str(out.error) == notice["message"]
    assert out.error.__cause__ is boom


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
@pytest.mark.parametrize("status,said,kind", [
    (503, UNAVAILABLE, "perso_unavailable"),
    (401, KEY_REFUSED, "perso_invalid_key"),
], ids=["perso-down", "key-refused"])
def test_a_refusal_while_the_client_is_made_reads_the_same(drive, unpinned_key, monkeypatch, scaffold,
                                                          status, said, kind):
    """Making the real client asks Perso which workspace the key belongs to,
    and Perso can refuse that as it refuses a call. It reads the same."""
    monkeypatch.setattr(perso_client.httpx, "get",
                        lambda url, **kw: httpx.Response(status, request=httpx.Request("GET", url)))
    out = drive(scaffold, None)
    assert out.lines == [HEADER[scaffold], "   Error: " + said]
    assert out.notices == [{"type": kind, "message": said, "message_shown": said}]
    assert type(out.error) is RuntimeError and str(out.error) == said


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_a_cancel_passes_through_as_it_is(drive, scaffold):
    stop = JobCancelled("cancelled while waiting for Perso")
    out = drive(scaffold, FakePerso(fail=stop))
    assert out.error is stop
    assert out.lines == [HEADER[scaffold], WORKSPACE]
    assert out.notices == []


@pytest.mark.parametrize("scaffold", SCAFFOLDS)
def test_a_failed_call_still_closes_its_credit_watch(drive, scaffold):
    """Closed in `finally`. Left open, every later Perso call would overlap it
    and log "not counted" instead of what it cost."""
    assert drive(scaffold, FakePerso(fail=_http_400())).error is not None
    assert "   Perso credits used: 6" in drive(scaffold, FakePerso()).lines
