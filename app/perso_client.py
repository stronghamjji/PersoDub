"""Perso STT client — speaker diarization + word-level timestamp transcription.

Procedure: (1) issue sas-token -> (2) upload to Azure Blob -> (3) register the file (mediaSeq) ->
(4) create the STT project -> (5) poll progressReason (10s) -> (6) download scriptTimestamps (JSON).

Only the PERSO_API_KEY environment variable is required (ValueError in the
constructor if missing). The workspace id resolves from the key itself when
PERSO_SPACE_SEQ is unset -- see _resolve_space_seq. The key value must never
be exposed in code or logs.
"""
import logging
import os
import re
import sys
import threading
import time
from typing import List, Optional

import httpx

from app import netlog

logger = logging.getLogger("persodub.perso_client")

BASE_URL = "https://api.perso.ai"
# Client identity sent on every Perso API call so Perso can attribute usage to this app.
# Mirrors the official perso-dubbing-plugin, which sends a name/version User-Agent
# (skills/dubbing/lib/client_info.mjs:23) alongside the X-Perso-Client-Host channel on
# every request (http_client.mjs:56).
# The plugin folds no OS into either value; this app reports the platform in its own os=
# field rather than inside the host, so the host stays byte-identical wherever Perso reads
# it -- the header, the User-Agent, or a utm_source -- and mac/Windows stay separable.
APP_NAME = "desktop_app"


def resolve_identity(platform: str, env) -> tuple:
    """(version, client_host, user_agent) for one runtime.

    Pure on purpose: the constants below are computed once at import, but tests can
    exercise every platform by calling this directly -- reloading the module instead
    would hand out fresh exception classes and break `except`.
    """
    # desktop/package.json is the only place the version is written; the shell passes it
    # down. "0.0.0" marks "not launched by the desktop shell" -- the same unknown-version
    # placeholder the plugin falls back to (client_info.mjs:20).
    version = env.get("PERSODUB_APP_VERSION") or "0.0.0"
    # Friendly "mac"/"windows", not sys.platform's raw darwin/win32, so the stats read
    # without a decoder ring. Linux already names itself "linux".
    os_name = {"darwin": "mac", "win32": "windows"}.get(platform, platform)
    return version, APP_NAME, "%s/%s (os=%s)" % (APP_NAME, version, os_name)


APP_VERSION, CLIENT_HOST, USER_AGENT = resolve_identity(sys.platform, os.environ)


def _key_headers(api_key: str) -> dict:
    """Auth + app identity for module-level Perso calls (the ones made before a
    PersoClient exists, e.g. the Settings workspace picker). Same three headers
    as PersoClient._headers, so every Perso API call is attributed to this app."""
    return {"XP-API-KEY": api_key, "User-Agent": USER_AGENT,
            "X-Perso-Client-Host": CLIENT_HOST}

# Host the download links resolve against. Not account-specific: the official
# API docs state file paths resolve against portal-media.perso.ai, and the
# perso-dubbing-plugin hardcodes the same default (api_adapter.mjs MEDIA_BASE).
MEDIA_HOST = os.environ.get("PERSO_MEDIA_HOST", "https://portal-media.perso.ai")

# Perso workspace subscription/recharge portal, shown to the user when credits run out.
# Not account-specific (no space/session data embedded) -- same kind of hardcoded, generic
# portal URL the official perso-dubbing-plugin links out to (its SUBSCRIPTION_URL constant,
# skills/dubbing/lib/messages.mjs:4). This app never processes payment itself; it only
# hands the user this link, same as the plugin's billing.mjs does with its Stripe links.
PERSO_RECHARGE_URL = os.environ.get(
    "PERSO_RECHARGE_URL", "https://perso.ai/en/workspace/space-settings?tab=Subscription"
)

# Where a user with no key goes to get one. The plugin points at the same portal
# (resolve_key.mjs:90 "Get an API key: https://developers.perso.ai/api-keys"); signing up
# happens there too, so this is the app's only path to a new Perso account.
PERSO_SIGNUP_URL = os.environ.get("PERSO_SIGNUP_URL", "https://developers.perso.ai/api-keys")

# UTM tags on the outbound links -- mirrors the API-call identity above, the same scheme the
# official plugin uses (messages.mjs:13 "UTM identity — mirrors the API-call identity"):
# utm_source carries the exact CLIENT_HOST the API headers send, so Perso can line up
# "API usage by this app" with "visits from this app" under one name. utm_content says WHICH
# link was clicked, which is what separates new signups from repeat recharges in the report.
def _with_utm(url: str, content: str) -> str:
    params = (
        f"utm_source={CLIENT_HOST}&utm_medium=desktop-app&utm_campaign={APP_NAME}"
        f"&utm_content={content}&utm_term=v{APP_VERSION}"
    )
    return url + ("&" if "?" in url else "?") + params


# How long a proofread is given to show up in the project's progress before a
# "Completed" is believed (PersoClient.proofread).
PROOFREAD_SETTLE_S = 60

RECHARGE_LINK = _with_utm(PERSO_RECHARGE_URL, "recharge")
SIGNUP_LINK = _with_utm(PERSO_SIGNUP_URL, "signup")


class PersoCreditExhaustedError(RuntimeError):
    """Perso billing credits/quota exhausted.

    Detected the same way the official perso-dubbing-plugin does: uniformly by HTTP
    status 402, not by any internal error code in the response body (see
    perso-dubbing-plugin skills/dubbing/lib/scheduler.mjs:22, `isCreditError = (e) =>
    e instanceof PersoApiError && e.httpStatus === 402`). A dedicated exception (not
    plain RuntimeError) so callers can tell "out of credits" apart from other
    PersoClient failures (auth, network, timeout, other server errors) and react to it
    specifically instead of a generic catch-all.
    """

    def __init__(self, message: str = "Perso credits exhausted", link: str = RECHARGE_LINK):
        super().__init__(message)
        self.link = link


class PersoInvalidKeyError(RuntimeError):
    """Perso rejected the API key itself (HTTP 401/403).

    Distinct from PersoCreditExhaustedError for the same reason it exists: the
    fix is different. Out of credits -> recharge; rejected key -> open Settings
    and fix the key. RuntimeError subclass so existing generic handlers still
    catch it."""


class PersoUnavailableError(RuntimeError):
    """Perso's servers are down or overloaded (HTTP 5xx). Not the user's fault
    and nothing to fix on their side -- retrying later is the only remedy."""


class PersoProjectFailedError(RuntimeError):
    """Perso took the job, worked on it, and gave up.

    Not an HTTP status -- the request succeeded and the answer said the
    project had failed. The three above are about reaching Perso at all; this
    one is about a project that was reached and did not finish, which is a
    different thing to tell the user and a different thing to do about it.

    Carries Perso's own words so the screen can show exactly what the user
    will read on Perso's own dashboard: nothing here rewrites them.
    """

    def __init__(self, what: str, reason: str = "", code: str = ""):
        self.what = what
        self.reason = reason
        self.code = code
        said = reason or "no reason given"
        super().__init__(f"{what} failed: {said} ({code})" if code
                         else f"{what} failed: {said}")


class PersoModelRefusedError(RuntimeError):
    """Perso refused because this project's voice model cannot do what was
    asked (HTTP 400, code VT40918): a NIGHTINGALE project has no per-sentence
    voice and no RED speed. Nothing to retry -- the way through is a whole
    proofread, so the screen has to be able to tell this apart."""


# The code Perso answers with when the project's voice model lacks the option.
MODEL_REFUSED_CODE = "VT40918"
NIGHTINGALE = "NIGHTINGALE"
# The voice models a dubbing can be made with, in the order the screen shows
# them: the three Perso's own site offers. Its list names a fourth, DODO,
# which is not offered here. ORIOLE is what a dubbing gets when nobody chose,
# as on Perso's site; it covers the languages AUDIO_ENGINE_V3 did before that
# name left Perso's list (seen 2026-10-02).
TTS_MODELS = (NIGHTINGALE, "ORIOLE", "WREN")
DEFAULT_TTS_MODEL = "ORIOLE"


def _dubbing_space_candidates(api_key: str, base_url: str = BASE_URL) -> list:
    """Raw workspace dicts the key can dub in (GET /portal/api/v1/spaces).

    Strictly serviceType == "video_translator" first: Perso pairs each account
    with a "studio" sibling that ALSO carries useVideoTranslatorEdit=True
    (observed live 2026-08-06 -- every workspace listed twice under one name),
    so the official plugin's OR-filter shows duplicates and turns a
    one-workspace account into a forced manual pick. The broader tiers only
    apply when nothing matches: dubbing-editable spaces, then all of them
    (the plugin's own fallback -- a transient shape change in the payload must
    not hide real workspaces).
    """
    r = httpx.get(f"{base_url}/portal/api/v1/spaces",
                  headers=_key_headers(api_key), timeout=30)
    _raise_for_status(r)
    spaces = (r.json() or {}).get("result") or []
    vt = [s for s in spaces if s.get("serviceType") == "video_translator"]
    if vt:
        return vt
    editable = [s for s in spaces if s.get("useVideoTranslatorEdit") is True]
    return editable or spaces


def _resolve_space_seq(api_key: str, base_url: str = BASE_URL) -> int:
    """The account's workspace id, resolved from the API key alone.

    Mirrors the official perso-dubbing-plugin's space.mjs: a single candidate
    resolves silently. Several candidates raise with the id/name listing --
    the app cannot guess which workspace's credits to spend, so the user must
    pick one (Settings picker, or PERSO_SPACE_SEQ directly). The workspace id
    appears nowhere in Perso's own web UI, which is why asking the user for
    it up front was never an option.
    """
    candidates = _dubbing_space_candidates(api_key, base_url)
    if not candidates:
        raise ValueError("This Perso API key has no accessible workspace")
    if len(candidates) == 1:
        return int(candidates[0]["spaceSeq"])
    listing = ", ".join(
        f"{s['spaceSeq']} ({s.get('spaceName') or s.get('name') or 'unnamed'})"
        for s in candidates
    )
    raise ValueError(
        f"This Perso API key can use several workspaces -- pick one in "
        f"Settings (or set PERSO_SPACE_SEQ): {listing}"
    )


def list_dubbing_spaces(api_key: str, base_url: str = BASE_URL) -> list:
    """[{seq, name, tier, credits}] for the Settings workspace picker.

    Label data mirrors what the official plugin shows when it asks the user
    to choose (gates.mjs ensureSpace: "name | (plan) | remaining credits" --
    never the internal seq). Credits come from one plan-status call per
    workspace and fail soft to None: an unreachable quota endpoint must not
    hide the workspace itself.
    """
    out = []
    for s in _dubbing_space_candidates(api_key, base_url):
        seq = int(s["spaceSeq"])
        credits = None
        try:
            pr = httpx.get(
                f"{base_url}/video-translator/api/v1/projects/spaces/{seq}/plan/status",
                headers=_key_headers(api_key), timeout=15,
            )
            if pr.status_code == 200:
                res = (pr.json() or {}).get("result") or {}
                rq = res.get("remainingQuota")
                credits = rq.get("remainingQuota") if isinstance(rq, dict) else rq
        except Exception as e:
            # Credits are decoration on a workspace row; the type is all we
            # need, and an httpx error's text can carry the request (and so
            # the key) with it.
            logger.debug("No credit count for Perso workspace %s (%s)", seq, type(e).__name__)
        out.append({"seq": seq,
                    "name": s.get("spaceName") or s.get("name") or f"space {seq}",
                    "tier": s.get("tier"), "credits": credits})
    return out


# Perso says a project failed in more than one way, and only one of them was
# being read. A dub whose cloud project had already failed went on polling for
# the full hour while Perso's own dashboard said it was over (user,
# 2026-09-11). The words here are Perso's, kept as Perso wrote them: the
# reason, and any code it gave, travel to the screen unchanged so the two
# sides can be compared without a translation in between.
_FAILED_WORDS = re.compile(r"fail|error|abort|reject|cancel", re.I)

# Where Perso has been seen to put a code. Read in this order, first one wins.
_CODE_FIELDS = ("errorCode", "failCode", "code", "errorType")


# Anything with "://" in it and whatever follows, plus the "for url" that
# httpx puts in front of it.
_URL_IN_TEXT = re.compile(r"\s*(?:for url\s*)?'?\S+://\S+'?", re.I)


def short_reason(e) -> str:
    """One short clause from an exception, fit to show a person.

    httpx writes "Client error '400 Bad Request' for url
    'https://api.perso.ai/file/api/upload/video'", and that whole thing was
    going on screen -- so the message ended in an address that looked like
    somewhere the user was being sent, when it is this app's own call to
    Perso (user, 2026-09-11). The address is dropped here and kept in the
    log, where it is the diagnosis.
    """
    text = " ".join(str(e or "").split())
    text = _URL_IN_TEXT.sub("", text).strip(" .,:;")
    return text[:160] if text else type(e).__name__


def perso_failure(res):
    # type: (dict) -> tuple
    """Has this project failed, and in Perso's own words?

    Returns (failed, (reason, code)) -- both exactly as Perso spelled them,
    because the point of showing them is to match what the user sees on
    Perso's own side, and a rewrite in between would defeat that.
    """
    if not isinstance(res, dict):
        return False, ("", "")
    reason = str(res.get("progressReason") or "").strip()
    flagged = bool(res.get("hasFailed") or res.get("isFailed") or res.get("failed"))
    # "Completed" wins, however the sentence goes on: a reason can carry a
    # word like "cancelled" while describing something that did finish.
    done = reason.lower().startswith("completed")
    said_failed = not done and bool(_FAILED_WORDS.search(reason))
    if not (flagged or said_failed):
        return False, ("", "")
    code = ""
    for key in _CODE_FIELDS:
        value = res.get(key)
        if value not in (None, ""):
            code = str(value)
            break
    return True, (reason, code)


def _raise_for_status(r: httpx.Response) -> None:
    """r.raise_for_status(), except statuses the UI reacts to specifically get
    their dedicated exception: 402 -> credits, 401/403 -> bad key, 5xx -> Perso
    outage (see app/pipeline.py, which turns each into a structured notice).

    Checked directly on the status code (matching the plugin's "judged uniformly by
    HTTP 402" approach) rather than by inspecting which exception type
    r.raise_for_status() happens to throw.
    """
    if r.status_code == 402:
        raise PersoCreditExhaustedError()
    if r.status_code in (401, 403):
        raise PersoInvalidKeyError(f"Perso rejected the API key (HTTP {r.status_code})")
    if r.status_code >= 500:
        raise PersoUnavailableError(f"Perso server error (HTTP {r.status_code})")
    if r.status_code >= 400:
        # httpx's own text says only "400 Bad Request", and seven refusals
        # reached the issue tracker with nothing to go on (2026-09-28). Perso's
        # answer says why, so it rides along -- without the address.
        said = _perso_said(r)
        if said:
            raise httpx.HTTPStatusError(
                f"Client error '{r.status_code} {r.reason_phrase}': Perso said {said}",
                request=r.request, response=r)
    r.raise_for_status()


# Where Perso has been seen to put its reason. Read in this order, all kept.
_REASON_FIELDS = ("message", "detail", "error", "errorMessage") + _CODE_FIELDS


def _raise_for_edit(r: httpx.Response) -> None:
    """_raise_for_status for the editing calls, which have one refusal more:
    the project's voice model cannot do what was asked."""
    if r.status_code == 400 and MODEL_REFUSED_CODE in (r.text or ""):
        raise PersoModelRefusedError(
            "This project's voice model does not support that (%s)" % MODEL_REFUSED_CODE)
    _raise_for_status(r)


def _perso_said(r: httpx.Response) -> str:
    """Perso's reason for a refusal, one short line, or "" when it gave none."""
    try:
        body = r.json()
    except ValueError:
        body = r.text
    if isinstance(body, dict):
        parts = [str(body[k]) for k in _REASON_FIELDS if body.get(k) not in (None, "")]
        text = " / ".join(parts)
    else:
        text = str(body or "")
    text = _URL_IN_TEXT.sub("", " ".join(text.split())).strip(" .,:;")
    return text[:160]


# A credit watch: the balance read before a Perso call and again after it is
# what the call cost -- unless another Perso call of this app ran meanwhile,
# when the difference holds both (a separation read 15 for its own 5 while a
# Wren dub spent 10 beside it, Windows C8, 2026-10-07). A watch another call
# overlapped is not counted: an unknown cost is better than a wrong one.
_WATCH_LOCK = threading.Lock()
_WATCH_SEQ = [0]          # one counter for every begin and end, so order is exact
_WATCHES_OPEN = {}        # watch id -> the sequence number it began at
_WATCHES_CLOSED = []      # (began seq, ended seq, ended at) of the last hour
_WATCH_KEEP_SECONDS = 3600.0


def _tick() -> int:
    _WATCH_SEQ[0] += 1
    return _WATCH_SEQ[0]


def begin_credit_watch(pc):
    """describe_workspace() from before a Perso call, marked as a watch for
    note_credits to close. None when the client cannot describe one."""
    ws = getattr(pc, "describe_workspace", lambda: None)()
    if not ws:
        return ws
    with _WATCH_LOCK:
        wid = _tick()
        _WATCHES_OPEN[wid] = wid
        return dict(ws, _watch=wid)


def _close_credit_watch(wid) -> bool:
    """True when no other Perso call of this app ran while this watch was open.
    Order comes from the sequence counter, not the clock: Windows' clock moves
    every 15.6 ms, and two calls one after the other read as overlapping there."""
    with _WATCH_LOCK:
        began = _WATCHES_OPEN.pop(wid, None)
        if began is None:
            return True
        now = time.monotonic()
        alone = not _WATCHES_OPEN and not any(ended > began for _, ended, _ in _WATCHES_CLOSED)
        _WATCHES_CLOSED.append((began, _tick(), now))
        _WATCHES_CLOSED[:] = [w for w in _WATCHES_CLOSED if now - w[2] < _WATCH_KEEP_SECONDS]
        return alone


def end_credit_watch(ws) -> None:
    """Close a watch whose call failed, so it does not count as still running
    against every later call. Nothing when note_credits closed it already."""
    if ws and "_watch" in ws:
        _close_credit_watch(ws["_watch"])


def note_credits(ws, pc, log, what: str) -> None:
    """Log what THIS call cost -- the balance before minus the balance after --
    and add it to the client's running total, which a finished job reports.

    `ws` is begin_credit_watch() (or describe_workspace()) from before the
    call, or None. A call another Perso call overlapped leaves the total
    unknown (None) instead of wrong. Never raises: by the time this runs the
    work has succeeded and been billed, and a surprise in the credits payload
    must not discard the paid result.
    """
    try:
        alone = _close_credit_watch(ws["_watch"]) if ws and "_watch" in ws else True
        if ws and ws.get("credits") is not None:
            after = (getattr(pc, "describe_workspace", lambda: None)() or {}).get("credits")
            if after is None:
                return
            if not alone:
                log("   Perso credits used: not counted (another Perso job ran at the same time)")
                pc.credits_used = None
                return
            used = int(ws["credits"]) - int(after)
            # What this job used, not what is left: the log travels with a
            # failure report, and docs/privacy.md says the balance never does.
            log(f"   Perso credits used: {used}")
            total = getattr(pc, "credits_used", 0)
            pc.credits_used = None if total is None else total + max(used, 0)
    except Exception as e:
        logger.debug("No credits line after %s (%s)", what, type(e).__name__)


class PersoClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        space_seq: Optional[int] = None,
        poll_interval: float = 10.0,
        base_url: str = BASE_URL,
    ):
        # current_value = kit.env first, process env second: a key or workspace
        # saved in Settings applies to this client right away, with no restart.
        from app.settings_env import current_value

        self.api_key = api_key or current_value("PERSO_API_KEY")
        if not self.api_key:
            raise ValueError("PERSO_API_KEY environment variable is not set")
        if space_seq is None:
            # `or None`: PERSO_SPACE_SEQ= (present but empty, e.g. cleared via
            # Settings) must mean "unset", not int("") -> ValueError.
            space_seq = current_value("PERSO_SPACE_SEQ") or None
        if space_seq is None:
            # No pin anywhere: ask Perso which workspace this key belongs to.
            space_seq = _resolve_space_seq(self.api_key, base_url.rstrip("/"))
        self.space_seq = int(space_seq)
        self.poll_interval = poll_interval
        self.base_url = base_url.rstrip("/")
        # Optional () -> bool, set by the caller (app/pipeline.py). Polled
        # inside _wait_completed so Cancel doesn't hang for up to an hour of
        # Perso progress polling. An attribute (not a transcribe() kwarg) so
        # existing callers and test fakes keep their signature.
        self.cancel_check = None
        # The job's log.trace (app/jobs.py _launch), set by the caller like
        # cancel_check: the upload's and the downloads' lines (_say) go into
        # the job's file as well as the app log. None outside a job.
        self.trace = None
        # Credits this client has spent so far, added up by note_credits after
        # each billed call. A finished job reports the total (usage counts).
        self.credits_used = 0
        # mediaSeq per (path, space): a job that uses Perso for BOTH separation
        # and STT must not upload the same multi-hundred-MB video twice.
        self._media_seq_cache = {}

    @property
    def _headers(self) -> dict:
        return {
            "XP-API-KEY": self.api_key,
            "User-Agent": USER_AGENT,
            "X-Perso-Client-Host": CLIENT_HOST,
        }

    def _say(self, line: str, level: str = "INFO") -> None:
        """A transfer line (app/netlog.py): through the job's trace when the
        caller set one, else into the app log."""
        netlog.say(self.trace, logger, line, level)

    def describe_workspace(self) -> dict:
        """{seq, name, credits} of the workspace this client bills.

        Feeds the job log's "Perso workspace: ..." line, so the user can see
        which workspace actually paid -- with a pin saved in Settings but not
        yet applied by a restart, it can differ from what Settings shows.
        Purely informational: every lookup fails soft to None fields, because
        a logging helper must never take the job down with it.
        """
        name = credits = None
        try:
            for s in _dubbing_space_candidates(self.api_key, self.base_url):
                if int(s.get("spaceSeq", -1)) == self.space_seq:
                    name = s.get("spaceName") or s.get("name")
                    break
        except Exception as e:
            logger.debug("Could not name Perso workspace %s (%s)", self.space_seq, type(e).__name__)
        try:
            r = httpx.get(
                f"{self.base_url}/video-translator/api/v1/projects/spaces/{self.space_seq}/plan/status",
                headers=self._headers, timeout=15,
            )
            if r.status_code == 200:
                rq = ((r.json() or {}).get("result") or {}).get("remainingQuota")
                credits = rq.get("remainingQuota") if isinstance(rq, dict) else rq
        except Exception as e:
            logger.debug("Could not read credits for Perso workspace %s (%s)",
                         self.space_seq, type(e).__name__)
        return {"seq": self.space_seq, "name": name, "credits": credits}

    def _upload_media(self, video_path: str, space: int) -> int:
        """Upload steps (1)-(3), shared by transcribe() and separate():
        issue a SAS token, PUT the file to Azure Blob, register it -> mediaSeq.
        The PUT is written between UPLOAD START and DONE or FAILED lines
        (app/netlog.py); the signed link loses its query on the way."""
        cached = self._media_seq_cache.get((video_path, space))
        if cached is not None:
            return cached
        file_name = os.path.basename(video_path)

        # (1) Issue SAS token
        r = httpx.get(
            f"{self.base_url}/file/api/upload/sas-token",
            params={"fileName": file_name}, headers=self._headers, timeout=60,
        )
        _raise_for_status(r)
        blob_sas_url = r.json()["blobSasUrl"]

        # (2) Upload to Azure Blob (direct PUT)
        with open(video_path, "rb") as f:
            data = f.read()
        what = "perso media"
        self._say(netlog.start(what, video_path, blob_sas_url, note=f"({netlog.size_text(len(data))})",
                               word="UPLOAD"))
        began = time.monotonic()
        try:
            r = httpx.put(
                blob_sas_url, content=data,
                headers={"x-ms-blob-type": "BlockBlob",
                         "Content-Type": "application/octet-stream"},
                timeout=1800,
            )
            # The storage's answer comes once the whole file is sent: its size is what went.
            self._say(netlog.connected(what, r.status_code, blob_sas_url, len(data), word="UPLOAD"))
            _raise_for_status(r)
        except Exception as e:
            self._say(netlog.failed(what, time.monotonic() - began, netlog.described(e), blob_sas_url,
                                    word="UPLOAD"), "ERROR")
            raise
        self._say(netlog.done(what, time.monotonic() - began, len(data), word="UPLOAD"))

        # (3) Register the uploaded file -> mediaSeq
        file_url = blob_sas_url.split("?")[0]
        r = httpx.put(
            f"{self.base_url}/file/api/upload/video",
            json={"spaceSeq": space, "fileUrl": file_url, "fileName": file_name},
            headers=self._headers, timeout=120,
        )
        _raise_for_status(r)
        media_seq = r.json()["seq"]
        self._media_seq_cache[(video_path, space)] = media_seq
        return media_seq

    def separate(self, video_path: str, out_dir: str,
                 space_seq: Optional[int] = None) -> dict:
        """Voice/background separation through Perso -> {"vocals", "background"}.

        Mirrors the official plugin's flow (api_adapter.mjs): upload -> POST
        audio-separation -> poll -> read the project detail's downloadPathInfo.
        The generic download?target endpoint does NOT serve separation tracks
        (server gap the plugin verified 2026-07), so the project detail is the
        only source. sub_background is ignored -- the local pipeline only ever
        consumes vocals + background (app/separate.py's contract).
        """
        space = int(space_seq) if space_seq is not None else self.space_seq
        media_seq = self._upload_media(video_path, space)

        r = httpx.post(
            f"{self.base_url}/video-translator/api/v1/projects/spaces/{space}/audio-separation",
            json={"mediaSeq": media_seq, "isVideoProject": True},
            headers=self._headers, timeout=120,
        )
        _raise_for_status(r)
        project_seq = r.json()["result"]["startGenerateProjectIdList"][0]

        self._wait_completed(project_seq, space, what="Perso separation")

        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}",
            headers=self._headers, timeout=60,
        )
        _raise_for_status(r)
        body = r.json() or {}
        info = (body.get("result") or body).get("downloadPathInfo") or {}
        tracks = {"vocals": info.get("originalVoicePath"),
                  "background": info.get("originalBackgroundPath")}
        if not all(tracks.values()):
            raise RuntimeError("Perso separation finished but returned no downloadable tracks")

        os.makedirs(out_dir, exist_ok=True)
        out = {}
        for key, rel in tracks.items():
            # Storage download links, fetched like every other one
            # (download_media): identity only, no API key -- the key must not
            # travel to a different host -- and asked for again when the
            # connection drops.
            # The SAME names local Demucs writes (vocals.wav / background.wav):
            # the per-line voice remake reads work_dir/background.wav by name,
            # and a perso-separated job must feed it identically.
            out[key] = self.download_media(rel, os.path.join(out_dir, f"{key}.wav"), what=f"perso {key}")
        return out

    def dub_video(self, video_path: str, out_path: str,
                  source_code: Optional[str], target_code: str,
                  num_speakers: Optional[int] = None,
                  space_seq: Optional[int] = None, log=None,
                  target_tag: Optional[str] = None,
                  tts_model: str = DEFAULT_TTS_MODEL) -> str:
        """Full cloud dub: upload -> translate project -> poll -> download.

        The whole pipeline runs on Perso's side (translation, voices, mix);
        what comes back is the finished dubbed video, saved to out_path.
        Request contract mirrors the official plugin's api_adapter.mjs
        requestTranslation/download exactly (verified 2026-08-31).
        """
        from app.jobs import timed_step  # late, as _wait_completed's JobCancelled

        log = log or (lambda m: None)
        space = int(space_seq) if space_seq is not None else self.space_seq
        # Three steps in the job's file, each between START and DONE lines
        # (timed_step); the three lines the screen reads its progress from
        # are as they were.
        with timed_step(log, "1/3", "upload",
                        bytes=os.path.getsize(video_path) if os.path.isfile(video_path) else None):
            log("   Uploading the video to Perso…")
            media_seq = self._upload_media(video_path, space)
        with timed_step(log, "2/3", "perso-dubbing", target=target_code, model=tts_model, speakers=num_speakers):
            log("   Perso is dubbing… this takes a few minutes.")

            r = httpx.post(
                f"{self.base_url}/video-translator/api/v1/projects/spaces/{space}/translate",
                json={
                    "mediaSeq": media_seq,
                    "isVideoProject": True,
                    # "auto" is the server's own detect-the-source value.
                    "sourceLanguageCode": source_code or "auto",
                    # languageTag tells Perso's regional variants apart (en-GB,
                    # es-ES, pt-PT); the plain code alone means its default region.
                    "targetLanguages": [{"languageCode": target_code, "ttsModel": tts_model,
                                         **({"languageTag": target_tag} if target_tag else {})}],
                    "numberOfSpeakers": int(num_speakers) if num_speakers else 1,
                    "preferredSpeedType": "GREEN",
                },
                headers=self._headers, timeout=120,
            )
            _raise_for_status(r)
            project_seq = r.json()["result"]["startGenerateProjectIdList"][0]
            # Kept on the client so the caller can stamp it on the job record --
            # the script viewer reads the project back through it later.
            self.last_dub_project_seq = project_seq
            logger.info("Perso dubbing project %s (workspace %s)", project_seq, space)

            self._wait_completed(project_seq, space, what="Perso dubbing")
        with timed_step(log, "3/3", "download", project=project_seq):
            log("   Downloading the finished video…")
            return self.download_dub(project_seq, out_path, space)

    def download_dub(self, project_seq: int, out_path: str,
                     space_seq: Optional[int] = None) -> str:
        """Save a finished project's dubbed video to out_path. Free: a download."""
        space = int(space_seq) if space_seq is not None else self.space_seq
        # The gate the plugin checks before asking for a link: a completed
        # project whose video is not served yet must fail loudly, not save
        # an empty file.
        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}/download-info",
            headers=self._headers, timeout=60,
        )
        _raise_for_status(r)
        info = (r.json() or {}).get("result") or {}
        if info.get("hasTranslatedVideo") is False:
            raise RuntimeError("Perso dubbing finished but the video is not ready to download")

        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}/download",
            params={"target": "dubbingVideo"}, headers=self._headers, timeout=120,
        )
        _raise_for_status(r)
        link = r.json()["result"]["videoFile"]["videoDownloadLink"]
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        # A storage link, fetched like every other one: identity only, no API
        # key, and asked for again when the connection drops.
        return self.download_media(link, out_path, what="perso dubbing")

    def get_project_script(self, project_seq: int, space_seq: Optional[int] = None) -> dict:
        """A dubbing project's script: {"sentences": [...], "speakers": [...]}.

        Pages through GET /projects/{seq}/spaces/{space}/script the way the
        official plugin's getProjectScript does (size 100, cursor pagination;
        every page carries the full speaker array, last one wins). Sentences
        carry originalText/translatedText, offsetMs/durationMs, a per-sentence
        audioUrl and speakerOrderIndex (shape verified live 2026-08-31).
        """
        space = int(space_seq) if space_seq is not None else self.space_seq
        sentences, speakers = [], []
        cursor = None
        for _ in range(50):
            params = {"size": 100}
            if cursor is not None:
                params["cursorId"] = cursor
            r = httpx.get(
                f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}/script",
                params=params, headers=self._headers, timeout=60,
            )
            _raise_for_status(r)
            body = r.json() or {}
            body = body.get("result") or body
            sentences.extend(body.get("sentences") or [])
            if body.get("speakers"):
                speakers = body["speakers"]
            if not body.get("hasNext"):
                break
            cursor = body.get("nextCursorId")
        return {"sentences": sentences, "speakers": speakers}

    def add_speaker_from_sentence(self, project_seq: int, sentence_seq: int,
                                  space_seq: Optional[int] = None) -> dict:
        """Give one sentence a NEW speaker, derived from that sentence's own
        audio -- the write API the official plugin's speaker.mjs uses. The
        response shape is unverified upstream; callers re-read the script to
        confirm the effect (the plugin's own defensive pattern)."""
        space = int(space_seq) if space_seq is not None else self.space_seq
        r = httpx.post(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}/speakers/from-sentence",
            json={"sourceSentenceSeq": sentence_seq},
            headers=self._headers, timeout=120,
        )
        _raise_for_status(r)
        return r.json() or {}

    # ── Editing a finished dub on Perso's side ──────────────────────────────
    # One sentence at a time, or the whole project (proofread). Request and
    # response fields are the documented ones (developers.perso.ai, read
    # 2026-09-29). None of the writes had been called for real when this was
    # written -- the owner had not approved spending credits -- so every
    # answer is read defensively: a field that is missing is None, not a crash.

    def _sentence_url(self, project_seq: int, sentence_seq: int, tail: str = "") -> str:
        return (f"{self.base_url}/video-translator/api/v1/project/{project_seq}"
                f"/audio-sentence/{sentence_seq}{tail}")

    @staticmethod
    def _result(r: httpx.Response) -> dict:
        """The `result` of an answer, or the answer itself when it has none."""
        _raise_for_edit(r)
        try:
            body = r.json()
        except ValueError:
            return {}
        if not isinstance(body, dict):
            return {}
        res = body.get("result", body)
        return res if isinstance(res, dict) else {}

    def edit_sentence(self, project_seq: int, sentence_seq: int, text: str) -> dict:
        """Give one sentence new words. Perso takes them as the sentence's new
        SOURCE (originalText) and translates them again, fitted to its time;
        the answer's translatedText is what it keeps, and may differ from
        `text`. The sentence has no voice until generate-audio (audioUrl is
        empty meanwhile). Free (seen live 2026-09-29)."""
        r = httpx.patch(self._sentence_url(project_seq, sentence_seq),
                        json={"targetText": text}, headers=self._headers, timeout=120)
        return self._result(r)

    def match_rewrite(self, project_seq: int, sentence_seq: int, text: str) -> dict:
        """How well `text` would fit the sentence's time: {matchingRate, rewrite}.
        Nothing is saved -- it is the check Perso's own editor runs when a
        field loses focus (seen in the browser, 2026-09-10)."""
        r = httpx.post(self._sentence_url(project_seq, sentence_seq, "/match-rewrite"),
                       json={"targetText": text}, headers=self._headers, timeout=60)
        return self._result(r)

    def regenerate_sentence_audio(self, project_seq: int, sentence_seq: int, text: str) -> dict:
        """Speak one sentence again in Perso's voice. It speaks the words the
        sentence has SAVED (edit_sentence); targetText is required but not
        spoken (seen live 2026-09-29). Answers when the voice exists, with
        its generateAudioFilePath (relative, under MEDIA_HOST). Counted as
        spending credits, though none were taken on 2026-09-29.
        A NIGHTINGALE project refuses: PersoModelRefusedError."""
        r = httpx.patch(self._sentence_url(project_seq, sentence_seq, "/generate-audio"),
                        json={"targetText": text}, headers=self._headers, timeout=300)
        return self._result(r)

    def reset_sentence(self, project_seq: int, sentence_seq: int) -> dict:
        """Put one sentence back to what the last proofread left."""
        r = httpx.put(self._sentence_url(project_seq, sentence_seq, "/reset"),
                      headers=self._headers, timeout=120)
        return self._result(r)

    def project_detail(self, project_seq: int, space_seq: Optional[int] = None) -> dict:
        """The project's own record: ttsModel, isEditable, progress (seen live
        2026-09-29; it arrives with no `result` around it)."""
        space = int(space_seq) if space_seq is not None else self.space_seq
        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}",
            headers=self._headers, timeout=60,
        )
        return self._result(r)

    def retranslation_status(self, project_seq: int, space_seq: Optional[int] = None) -> bool:
        """Whether Perso would take a proofread of this project right now.
        False on a project nothing was changed in (seen live 2026-09-29)."""
        space = int(space_seq) if space_seq is not None else self.space_seq
        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}"
            "/retranslation/status",
            headers=self._headers, timeout=60,
        )
        return bool(self._result(r).get("retranslateAvailable"))

    def proofread_price(self, project_seq: int, duration_ms: int, width: int, height: int,
                        space_seq: Optional[int] = None,
                        tts_model: Optional[str] = None) -> dict:
        """What a proofread of this project would cost, asked of Perso's
        estimate: {"credits": number or None, "export_count": int or None}.
        Free, a read. The address and fields are the documented ones
        (developers.perso.ai, read 2026-09-30) and were never seen live, so a
        field that is missing or not a number is None, not a guess: the
        discounted price is what Perso takes, the list price stands in for it.
        export_count is 1 on a NIGHTINGALE project never proofread."""
        space = int(space_seq) if space_seq is not None else self.space_seq
        params = {"mediaType": "video", "durationMs": int(duration_ms),
                  "width": int(width), "height": int(height),
                  "projectSeq": int(project_seq)}
        if tts_model:
            # The rate per second depends on the voice model (NIGHTINGALE: 6).
            params["ttsModelCounts"] = "%s:1" % tts_model
        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/spaces/{space}/media/quota",
            params=params, headers=self._headers, timeout=30,
        )
        res = self._result(r)

        def number(value):
            ok = isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
            return value if ok else None

        credits = number(res.get("promotionExpectedUsedQuota"))
        if credits is None:
            credits = number(res.get("expectedUsedQuota"))
        count = res.get("exportCount")
        return {"credits": credits,
                "export_count": count if isinstance(count, int) and not isinstance(count, bool) else None}

    def proofread(self, project_seq: int, space_seq: Optional[int] = None,
                  speed: str = "GREEN", lip_sync: Optional[bool] = None,
                  on_asked=None) -> None:
        """Have Perso go over the whole project again, and wait until it has.
        SPENDS CREDITS (what the first dub cost; a NIGHTINGALE project's first
        one is free). RED on a NIGHTINGALE project: PersoModelRefusedError.

        on_asked() is called the moment Perso has taken the request, before
        the wait: from there on the credits are spent, whatever happens to
        this process, and the caller may want that written down."""
        space = int(space_seq) if space_seq is not None else self.space_seq
        body = {"preferredSpeedType": speed}
        if lip_sync is not None:
            body["isLipSync"] = bool(lip_sync)
        r = httpx.post(
            f"{self.base_url}/video-translator/api/v1/project/{project_seq}/space/{space}/proofread",
            json=body, headers=self._headers, timeout=120,
        )
        _raise_for_edit(r)
        if on_asked:
            on_asked()
        logger.info("Perso proofread of project %s (workspace %s)", project_seq, space)
        # The project said "Completed" before this was asked, and may go on
        # saying so for a moment: that one must not be taken for the new run.
        self._wait_completed(project_seq, space, what="All at once",
                             settle_s=PROOFREAD_SETTLE_S)

    def wait_for_project(self, project_seq: int, space_seq: Optional[int] = None,
                         what: str = "Perso") -> None:
        """Wait until a project Perso is already working on has finished."""
        space = int(space_seq) if space_seq is not None else self.space_seq
        self._wait_completed(project_seq, space, what=what)

    def download_media(self, url: str, out_path: str, what: str = "perso file") -> str:
        """Fetch one storage file (a sentence's audio, a subtitle) to disk,
        between DOWNLOAD START and DONE or FAILED lines (app/netlog.py).
        Identity headers only -- storage links never see the API key.

        httpx.get reads the whole answer before it returns, so the CONNECTED
        line -- the status and the size -- is written once the bytes are in."""
        full = url if url.startswith("http") else MEDIA_HOST + url
        self._say(netlog.start(what, full, out_path))
        began = time.monotonic()
        try:
            # The file is the paid-for result; a connection dropped mid-body
            # (httpx RemoteProtocolError, Windows 2026-09-29) threw it away with
            # the credits already spent. Storage links are safe to ask for again,
            # so a dropped connection is asked again, twice, before giving up.
            for attempt in range(3):
                try:
                    r = httpx.get(full, headers={"User-Agent": USER_AGENT,
                                                 "X-Perso-Client-Host": CLIENT_HOST}, timeout=1800)
                    break
                except httpx.TransportError as e:
                    if attempt == 2:
                        raise
                    self._say(netlog.retry(what, attempt + 2, 3, time.monotonic() - began, netlog.described(e)),
                              "WARNING")
                    time.sleep(2 * (attempt + 1))
            self._say(netlog.connected(what, r.status_code, full, len(r.content)))
            _raise_for_status(r)
            with open(out_path, "wb") as f:
                f.write(r.content)
        except Exception as e:
            self._say(netlog.failed(what, time.monotonic() - began, netlog.described(e), full), "ERROR")
            raise
        self._say(netlog.done(what, time.monotonic() - began, len(r.content)))
        return out_path

    def download_target(self, project_seq: int, target: str, out_path: str,
                        space_seq: Optional[int] = None) -> str:
        """Download one of a project's named artifacts (e.g. backgroundAudio).

        The link's key varies per target, so the response is scanned for any
        *DownloadLink value -- the official plugin's own fallback.
        """
        space = int(space_seq) if space_seq is not None else self.space_seq
        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}/download",
            params={"target": target}, headers=self._headers, timeout=120,
        )
        _raise_for_status(r)
        body = (r.json() or {}).get("result") or {}

        def find_link(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if isinstance(v, str) and k.endswith("DownloadLink") and v:
                        return v
                    hit = find_link(v)
                    if hit:
                        return hit
            return None

        link = find_link(body)
        if not link:
            raise RuntimeError(f"Perso served no download link for {target}")
        return self.download_media(link, out_path, what=f"perso {target}")

    def transcribe(self, video_path: str, space_seq: Optional[int] = None) -> list:
        """Upload one video to Perso STT and return scriptTimestamps (JSON).

        The return value is a list of segments (each: order/speaker_name/text_original/words).
        Use perso_to_cues() to convert it into our cue format.
        """
        space = int(space_seq) if space_seq is not None else self.space_seq
        media_seq = self._upload_media(video_path, space)

        # (4) Create the STT project -> projectSeq
        r = httpx.post(
            f"{self.base_url}/video-translator/api/v1/projects/spaces/{space}/stt",
            json={"mediaSeq": media_seq, "isVideoProject": True},
            headers=self._headers, timeout=120,
        )
        _raise_for_status(r)
        project_seq = r.json()["result"]["startGenerateProjectIdList"][0]

        # (5) Poll until completion
        self._wait_completed(project_seq, space)

        # (6) Download scriptTimestamps
        return self._fetch_script_timestamps(project_seq, space)

    def _wait_completed(self, project_seq: int, space: int, timeout_s: int = 3600,
                        what: str = "Perso STT", settle_s: float = 0) -> None:
        """settle_s is for work asked of a project that had ALREADY finished:
        for that long a "Completed" is the old run's unless the project has
        been seen doing something else since."""
        began = time.time()
        deadline = began + timeout_s
        moved = False
        said = None
        while time.time() < deadline:
            if self.cancel_check and self.cancel_check():
                from app.jobs import JobCancelled
                raise JobCancelled(f"cancelled while waiting for {what}")
            r = httpx.get(
                f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/space/{space}/progress",
                headers=self._headers, timeout=60,
            )
            _raise_for_status(r)
            res = r.json().get("result", {}) or {}
            # Every change of mind, written down. This loop used to run for up
            # to an hour saying nothing at all, so when the user saw "failed"
            # on Perso's own dashboard while this app carried on there was no
            # record of what Perso had actually been telling us
            # (user, 2026-09-11).
            reason = str(res.get("progressReason") or "")
            if reason != said:
                logger.info("%s project %s: %s", what, project_seq, reason or "(no reason given)")
                said = reason
            failed, (why, code) = perso_failure(res)
            if failed:
                logger.warning("%s project %s failed: %s %s", what, project_seq, why, code)
                raise PersoProjectFailedError(what, why, code)
            if reason != "Completed":
                moved = True
            elif moved or time.time() - began >= settle_s:
                return
            time.sleep(self.poll_interval)
        raise TimeoutError(f"{what} timed out after {timeout_s}s (last said: {said or 'nothing'})")

    def _fetch_script_timestamps(self, project_seq: int, space: int) -> list:
        r = httpx.get(
            f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/spaces/{space}/download",
            params={"target": "scriptTimestamps"}, headers=self._headers, timeout=120,
        )
        _raise_for_status(r)
        link = r.json()["result"]["audioFile"]["scriptTimestampsDownloadLink"]
        # The link may arrive relative (/perso-storage/...) or already absolute;
        # the official plugin's absolutize() handles both the same way.
        url = link if link.startswith("http") else MEDIA_HOST + link
        # Identity only, no API key: this is a storage download link, not the
        # Perso API -- the key must not travel to a different host.
        r = httpx.get(url, headers={"User-Agent": USER_AGENT,
                                    "X-Perso-Client-Host": CLIENT_HOST}, timeout=120)
        _raise_for_status(r)
        return r.json()


def perso_to_cues(script_json: list) -> List[dict]:
    """Convert Perso scriptTimestamps -> our cue format (pure function).

    Turns each segment into {start, end, text, speaker_id}.
    Times are the minimum start and maximum end of the word timestamps (real data
    contains start>end reversals, so min/max makes it robust). Speaker prefers speaker_name.
    Segments with no words are skipped.
    """
    cues = []
    for seg in script_json:
        word_groups = seg.get("words") or []
        words = word_groups[0] if word_groups else []
        starts = [w["start"] for w in words if "start" in w]
        ends = [w["end"] for w in words if "end" in w]
        if not starts or not ends:
            continue
        text = (seg.get("text_original") or "").strip()
        speaker = seg.get("speaker_name") or seg.get("speaker_id")
        cues.append({
            "start": min(starts),
            "end": max(ends),
            "text": text,
            "speaker_id": speaker,
        })
    return cues


def _safe_name(speaker: str) -> str:
    """Turn a speaker name into a filename-safe form (pure function)."""
    return "".join(ch if ch.isalnum() else "_" for ch in str(speaker))


def pick_speaker_spans(
    cues: List[dict],
    min_total: float = 6.0,
    max_total: float = 15.0,
    guard: float = 0.3,
) -> dict:
    """Pick clean sample time ranges per speaker (pure function).

    Lines that sit within guard (0.3s) of another speaker's line risk contamination and are excluded.
    Remaining lines are picked longest-first to build a span list whose per-speaker total is
    between min_total and max_total seconds. {speaker: [[start,end], ...]} (spans sorted by start).
    """
    clean = []
    for i, c in enumerate(cues):
        spk = c.get("speaker_id")
        if not spk:
            continue
        contaminated = False
        for j, d in enumerate(cues):
            if i == j or d.get("speaker_id") == spk:
                continue
            # Gap between the two ranges (negative if overlapping) — within guard counts as contamination
            gap = max(d["start"] - c["end"], c["start"] - d["end"])
            if gap <= guard:
                contaminated = True
                break
        if not contaminated:
            clean.append(c)

    by_spk: dict = {}
    for c in clean:
        by_spk.setdefault(c["speaker_id"], []).append(c)

    out: dict = {}
    for spk, cs in by_spk.items():
        cs = sorted(cs, key=lambda c: c["end"] - c["start"], reverse=True)
        spans = []
        total = 0.0
        for c in cs:
            if total >= min_total:
                break
            dur = c["end"] - c["start"]
            # If something is already collected and adding this line would exceed max, look for a shorter line
            if total > 0 and total + dur > max_total:
                continue
            spans.append([c["start"], c["end"]])
            total += dur
        if spans:
            out[spk] = sorted(spans)
    return out
