"""Perso STT client — speaker diarization + word-level timestamp transcription.

Procedure: (1) issue sas-token -> (2) upload to Azure Blob -> (3) register the file (mediaSeq) ->
(4) create the STT project -> (5) poll progressReason (10s) -> (6) download scriptTimestamps (JSON).

Only the PERSO_API_KEY environment variable is required (ValueError in the
constructor if missing). The workspace id resolves from the key itself when
PERSO_SPACE_SEQ is unset -- see _resolve_space_seq. The key value must never
be exposed in code or logs.
"""
import os
import sys
import time
from typing import List, Optional

import httpx

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
        except Exception:
            pass
        out.append({"seq": seq,
                    "name": s.get("spaceName") or s.get("name") or f"space {seq}",
                    "tier": s.get("tier"), "credits": credits})
    return out


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
    r.raise_for_status()


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
        except Exception:
            pass
        try:
            r = httpx.get(
                f"{self.base_url}/video-translator/api/v1/projects/spaces/{self.space_seq}/plan/status",
                headers=self._headers, timeout=15,
            )
            if r.status_code == 200:
                rq = ((r.json() or {}).get("result") or {}).get("remainingQuota")
                credits = rq.get("remainingQuota") if isinstance(rq, dict) else rq
        except Exception:
            pass
        return {"seq": self.space_seq, "name": name, "credits": credits}

    def _upload_media(self, video_path: str, space: int) -> int:
        """Upload steps (1)-(3), shared by transcribe() and separate():
        issue a SAS token, PUT the file to Azure Blob, register it -> mediaSeq."""
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
        r = httpx.put(
            blob_sas_url, content=data,
            headers={"x-ms-blob-type": "BlockBlob",
                     "Content-Type": "application/octet-stream"},
            timeout=1800,
        )
        _raise_for_status(r)

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
            # Identity only, no API key: these are storage download links, not
            # the Perso API -- the key must not travel to a different host.
            url = rel if rel.startswith("http") else MEDIA_HOST + rel
            r = httpx.get(url, headers={"User-Agent": USER_AGENT,
                                        "X-Perso-Client-Host": CLIENT_HOST}, timeout=1800)
            _raise_for_status(r)
            path = os.path.join(out_dir, f"perso_{key}.wav")
            with open(path, "wb") as f:
                f.write(r.content)
            out[key] = path
        return out

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
                        what: str = "Perso STT") -> None:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            if self.cancel_check and self.cancel_check():
                from app.jobs import JobCancelled
                raise JobCancelled(f"cancelled while waiting for {what}")
            r = httpx.get(
                f"{self.base_url}/video-translator/api/v1/projects/{project_seq}/space/{space}/progress",
                headers=self._headers, timeout=60,
            )
            _raise_for_status(r)
            res = r.json().get("result", {})
            if res.get("hasFailed"):
                raise RuntimeError(f"{what} failed: {res.get('progressReason')}")
            if res.get("progressReason") == "Completed":
                return
            time.sleep(self.poll_interval)
        raise TimeoutError(f"{what} timed out")

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
