"""Perso STT integration tests — without real API calls, pure functions are verified
against real json, and the pipeline branch is verified with a fake client.
"""
import json
import os

import httpx
import pytest

from app import perso_client as perso_client_module
from app.perso_client import (
    PersoClient,
    PersoCreditExhaustedError,
    PersoInvalidKeyError,
    PersoUnavailableError,
    perso_to_cues,
    pick_speaker_spans,
)

FIXTURE = os.environ.get(
    "PERSODUB_PERSO_FIXTURE",
    os.path.join(os.path.dirname(__file__), "fixtures", "perso_stt_sample.json"),
)


def _load_script():
    if not os.path.exists(FIXTURE):
        pytest.skip(f"Perso STT sample not found at {FIXTURE}")
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)


# ── 1. Constructor: ValueError when the key is missing ────────────────────────────────
def test_client_requires_api_key(monkeypatch):
    monkeypatch.delenv("PERSO_API_KEY", raising=False)
    with pytest.raises(ValueError):
        PersoClient()


def test_client_reads_space_seq_env(monkeypatch):
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.setenv("PERSO_SPACE_SEQ", "999")
    assert PersoClient().space_seq == 999


# ── 1b. space_seq auto-resolution (mirrors the official plugin's space.mjs:
#        env pin above wins → else GET /portal/api/v1/spaces with the key,
#        filter to dubbing-capable spaces, a single candidate resolves
#        silently, several must be chosen by hand) ──────────────────────────
class _FakeSpacesResponse:
    status_code = 200

    def __init__(self, spaces):
        self._spaces = spaces

    def raise_for_status(self):
        pass

    def json(self):
        return {"result": self._spaces}


def _fake_spaces_get(spaces, calls):
    def fake_get(url, **kwargs):
        calls.append(url)
        assert url.endswith("/portal/api/v1/spaces")
        assert kwargs["headers"]["XP-API-KEY"] == "dummy"
        return _FakeSpacesResponse(spaces)
    return fake_get


def test_space_seq_resolved_from_single_space(monkeypatch):
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    calls = []
    monkeypatch.setattr(perso_client_module.httpx, "get",
                        _fake_spaces_get([{"spaceSeq": 999999, "spaceName": "ACME"}], calls))
    assert PersoClient().space_seq == 999999
    assert len(calls) == 1


def test_space_seq_prefers_video_translator_spaces(monkeypatch):
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    spaces = [
        {"spaceSeq": 1, "spaceName": "avatar-only", "serviceType": "avatar"},
        {"spaceSeq": 2, "spaceName": "dub", "serviceType": "video_translator"},
    ]
    monkeypatch.setattr(perso_client_module.httpx, "get", _fake_spaces_get(spaces, []))
    assert PersoClient().space_seq == 2


def test_space_seq_ignores_studio_twin_spaces(monkeypatch):
    # Perso pairs each account with a "studio" sibling that also carries
    # useVideoTranslatorEdit=True (observed live 2026-08-06: every workspace
    # appeared twice). Only the video_translator one is a dubbing workspace --
    # with the studio twin filtered out, this common shape resolves silently
    # instead of demanding a manual pick between two copies of one name.
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    spaces = [
        {"spaceSeq": 567306, "spaceName": "acme", "serviceType": "studio",
         "useVideoTranslatorEdit": True},
        {"spaceSeq": 48, "spaceName": "acme", "serviceType": "video_translator",
         "useVideoTranslatorEdit": True},
    ]
    monkeypatch.setattr(perso_client_module.httpx, "get", _fake_spaces_get(spaces, []))
    assert PersoClient().space_seq == 48


def test_space_seq_falls_back_to_vt_edit_spaces(monkeypatch):
    # No video_translator space at all, but one marked dubbing-editable:
    # usable rather than "no accessible workspace".
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    spaces = [
        {"spaceSeq": 9, "spaceName": "solo-studio", "serviceType": "studio",
         "useVideoTranslatorEdit": True},
        {"spaceSeq": 10, "spaceName": "avatar", "serviceType": "avatar"},
    ]
    monkeypatch.setattr(perso_client_module.httpx, "get", _fake_spaces_get(spaces, []))
    assert PersoClient().space_seq == 9


def test_space_seq_ambiguous_raises_with_listing(monkeypatch):
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    spaces = [
        {"spaceSeq": 1, "spaceName": "one", "serviceType": "video_translator"},
        {"spaceSeq": 2, "spaceName": "two", "serviceType": "video_translator"},
    ]
    monkeypatch.setattr(perso_client_module.httpx, "get", _fake_spaces_get(spaces, []))
    with pytest.raises(ValueError, match="PERSO_SPACE_SEQ"):
        PersoClient()


def test_space_seq_no_spaces_raises(monkeypatch):
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.delenv("PERSO_SPACE_SEQ", raising=False)
    monkeypatch.setattr(perso_client_module.httpx, "get", _fake_spaces_get([], []))
    with pytest.raises(ValueError):
        PersoClient()


# ── 1c. list_dubbing_spaces — feeds the Settings workspace picker ──────────
class _FakePlanResponse:
    def __init__(self, status_code, credits=None):
        self.status_code = status_code
        self._credits = credits

    def raise_for_status(self):
        pass

    def json(self):
        return {"result": {"remainingQuota": {"remainingQuota": self._credits}}}


def test_list_dubbing_spaces_carries_name_tier_credits(monkeypatch):
    spaces = [
        {"spaceSeq": 999999, "spaceName": "ACME", "tier": "pro", "serviceType": "video_translator"},
        {"spaceSeq": 48, "spaceName": "My Workspace", "serviceType": "video_translator"},
    ]
    credits = {999999: 3400, 48: 120}

    def fake_get(url, **kwargs):
        if url.endswith("/portal/api/v1/spaces"):
            return _FakeSpacesResponse(spaces)
        seq = int(url.split("/spaces/")[1].split("/")[0])
        return _FakePlanResponse(200, credits[seq])

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)
    out = perso_client_module.list_dubbing_spaces("dummy")
    assert out == [
        {"seq": 999999, "name": "ACME", "tier": "pro", "credits": 3400},
        {"seq": 48, "name": "My Workspace", "tier": None, "credits": 120},
    ]


def test_describe_workspace_names_the_active_space_with_credits(monkeypatch):
    # Feeds the job-log line "Perso workspace: NAME (#seq), N credits left" --
    # added after a job billed a different workspace than the user believed
    # was selected (saved-but-not-restarted pin, 2026-08-06).
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.setenv("PERSO_SPACE_SEQ", "999999")

    def fake_get(url, **kwargs):
        if url.endswith("/portal/api/v1/spaces"):
            return _FakeSpacesResponse([
                {"spaceSeq": 999999, "spaceName": "ACME", "serviceType": "video_translator"},
                {"spaceSeq": 48, "spaceName": "other", "serviceType": "video_translator"},
            ])
        assert "/spaces/999999/" in url
        return _FakePlanResponse(200, 191175)

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)
    assert PersoClient().describe_workspace() == {"seq": 999999, "name": "ACME", "credits": 191175}


def test_describe_workspace_fails_soft(monkeypatch):
    # A logging helper must never take the job down with it.
    monkeypatch.setenv("PERSO_API_KEY", "dummy")
    monkeypatch.setenv("PERSO_SPACE_SEQ", "999999")

    def fake_get(url, **kwargs):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)
    assert PersoClient().describe_workspace() == {"seq": 999999, "name": None, "credits": None}


def test_list_dubbing_spaces_credits_fail_soft(monkeypatch):
    # A plan-status failure must not hide the workspace -- credits just read unknown.
    def fake_get(url, **kwargs):
        if url.endswith("/portal/api/v1/spaces"):
            return _FakeSpacesResponse([{"spaceSeq": 7, "spaceName": "solo",
                                         "serviceType": "video_translator"}])
        raise httpx.ConnectError("down")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)
    assert perso_client_module.list_dubbing_spaces("dummy") == [
        {"seq": 7, "name": "solo", "tier": None, "credits": None},
    ]


# ── 2. perso_to_cues (pure function, real json) ────────────────────────
def test_perso_to_cues_shape():
    cues = perso_to_cues(_load_script())
    assert len(cues) == 31  # real data: order 0~30
    first = cues[0]
    assert set(first) == {"start", "end", "text", "speaker_id"}
    assert first["speaker_id"] == "Joker"
    assert first["text"] == "This is the opening line."
    # Even with start<end reversals in the data, start<=end is guaranteed (min/max)
    assert all(c["start"] <= c["end"] for c in cues)
    # Speaker uses speaker_name
    assert {c["speaker_id"] for c in cues} == {"Joker", "Batman"}


def test_perso_to_cues_times_from_words():
    cues = perso_to_cues(_load_script())
    # order 0: word start 0.171 ~ last word end 1.74
    assert cues[0]["start"] == pytest.approx(0.171)
    assert cues[0]["end"] == pytest.approx(1.74)


def test_perso_to_cues_skips_empty_words():
    fake = [{"order": 0, "speaker_name": "A", "text_original": "hi", "words": [[]]}]
    assert perso_to_cues(fake) == []


# ── 3. pick_speaker_spans (pure function) ──────────────────────────────
def test_pick_speaker_spans_totals_and_speakers():
    cues = perso_to_cues(_load_script())
    spans = pick_speaker_spans(cues)
    assert set(spans) == {"Joker", "Batman"}
    for spk, sp in spans.items():
        total = sum(e - s for s, e in sp)
        assert total > 0
        assert sp == sorted(sp)  # sorted by start
    # Joker, who has plenty of lines, meets the target (6s or more)
    assert sum(e - s for s, e in spans["Joker"]) >= 6.0


def test_pick_speaker_spans_excludes_contaminated():
    # Lines where two speakers sit within 0.3s must be excluded
    cues = [
        {"start": 0.0, "end": 5.0, "text": "a long", "speaker_id": "A"},   # clean (5s gap from the next speaker)
        {"start": 10.0, "end": 10.2, "text": "x", "speaker_id": "B"},
        {"start": 10.3, "end": 15.0, "text": "b close", "speaker_id": "A"},  # 0.1s from B -> excluded as contaminated
    ]
    spans = pick_speaker_spans(cues, min_total=1.0)
    assert spans["A"] == [[0.0, 5.0]]  # the contaminated 10.3~15.0 is dropped


def test_pick_speaker_spans_respects_max_total():
    cues = [
        {"start": 0.0, "end": 20.0, "text": "huge", "speaker_id": "A"},
        {"start": 30.0, "end": 38.0, "text": "mid", "speaker_id": "A"},
    ]
    # Even if the first line exceeds max, at least one is included
    spans = pick_speaker_spans(cues, min_total=6.0, max_total=15.0)
    assert spans["A"] == [[0.0, 20.0]]


# ── 4. Pipeline branch: see tests/test_stt_engine_wiring.py -----------------
# (the "pipeline uses perso branch" / "falls back on failure" tests that used
# to live here tested the now-deleted container-based
# generate/profile-registration path -- the Perso-vs-local-Whisper STT chain
# itself is covered there, against the current Qwen-only pipeline.)


# ── 5. PersoClient.transcribe() HTTP flow (mocked httpx, no network) ──────
class _FakeHttpxResponse:
    def __init__(self, json_data=None, status_code=200):
        self._json = json_data
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json


def _install_fake_perso_http(monkeypatch, script_json, progress_sequence):
    """Fake the six-step Perso HTTP flow: sas-token -> blob PUT -> register ->
    create STT -> poll progress -> download scriptTimestamps.

    progress_sequence: list of dicts returned by successive progress polls,
    e.g. [{"progressReason": "Processing"}, {"progressReason": "Completed"}].
    """
    calls = {"get": [], "put": [], "post": []}
    progress_iter = iter(progress_sequence)
    # MEDIA_HOST has no public default -- pin a fake one for this test.
    monkeypatch.setattr(perso_client_module, "MEDIA_HOST", "https://media.example.com")

    def fake_get(url, params=None, headers=None, timeout=None):
        calls["get"].append(url)
        if url.endswith("/file/api/upload/sas-token"):
            return _FakeHttpxResponse({"blobSasUrl": "https://blob.example.com/x?sig=abc"})
        if "/progress" in url:
            return _FakeHttpxResponse({"result": next(progress_iter)})
        if "/download" in url:
            return _FakeHttpxResponse({"result": {"audioFile": {
                "scriptTimestampsDownloadLink": "/perso-storage/script.json"}}})
        if url.startswith(perso_client_module.MEDIA_HOST):
            return _FakeHttpxResponse(script_json)
        raise AssertionError(f"unexpected GET {url}")

    def fake_put(url, content=None, json=None, headers=None, timeout=None):
        calls["put"].append(url)
        if url == "https://blob.example.com/x?sig=abc":
            return _FakeHttpxResponse({})
        if url.endswith("/file/api/upload/video"):
            return _FakeHttpxResponse({"seq": 555})
        raise AssertionError(f"unexpected PUT {url}")

    def fake_post(url, json=None, headers=None, timeout=None):
        calls["post"].append(url)
        if "/stt" in url:
            return _FakeHttpxResponse({"result": {"startGenerateProjectIdList": [777]}})
        raise AssertionError(f"unexpected POST {url}")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)
    monkeypatch.setattr(perso_client_module.httpx, "put", fake_put)
    monkeypatch.setattr(perso_client_module.httpx, "post", fake_post)
    return calls


def test_perso_client_transcribe_happy_path_mocked_http(monkeypatch, tmp_path):
    # Full 6-step flow: sas-token -> blob upload -> register -> create STT ->
    # poll (Processing then Completed) -> download scriptTimestamps.
    script = _load_script()
    calls = _install_fake_perso_http(
        monkeypatch, script,
        progress_sequence=[{"progressReason": "Processing", "hasFailed": False},
                            {"progressReason": "Completed", "hasFailed": False}],
    )
    monkeypatch.setattr(perso_client_module.time, "sleep", lambda s: None)

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake-video-bytes")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    result = client.transcribe(str(video))

    assert result == script
    assert any(u.endswith("/file/api/upload/sas-token") for u in calls["get"])
    assert any(u == "https://blob.example.com/x?sig=abc" for u in calls["put"])
    assert any(u.endswith("/file/api/upload/video") for u in calls["put"])
    assert any("/stt" in u for u in calls["post"])
    assert sum("/progress" in u for u in calls["get"]) == 2  # polled twice (Processing, then Completed)


def test_perso_client_transcribe_raises_on_hasFailed(monkeypatch, tmp_path):
    # If Perso reports hasFailed, the client must raise (the pipeline's Perso
    # branch catches this and falls back to the local Whisper path).
    script = _load_script()
    _install_fake_perso_http(
        monkeypatch, script,
        progress_sequence=[{"progressReason": "Error", "hasFailed": True}],
    )
    monkeypatch.setattr(perso_client_module.time, "sleep", lambda s: None)

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake-video-bytes")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    with pytest.raises(RuntimeError, match="Perso STT failed"):
        client.transcribe(str(video))


# ── 6. Credit-exhausted detection (HTTP 402) ───────────────────────────────
# Matches the official perso-dubbing-plugin's contract: credit/usage shortage is
# judged uniformly by HTTP 402, not by any error code in the body (see
# perso-dubbing-plugin skills/dubbing/lib/scheduler.mjs:22).

def test_perso_client_raises_credit_exhausted_on_402(monkeypatch, tmp_path):
    monkeypatch.setattr(perso_client_module, "MEDIA_HOST", "https://media.example.com")

    def fake_get(url, params=None, headers=None, timeout=None):
        if url.endswith("/file/api/upload/sas-token"):
            return _FakeHttpxResponse({"detail": "insufficient credits"}, status_code=402)
        raise AssertionError(f"unexpected GET {url}")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake-video-bytes")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    with pytest.raises(PersoCreditExhaustedError) as excinfo:
        client.transcribe(str(video))
    # Default link = recharge portal + the UTM tag mirroring the API-call identity.
    assert excinfo.value.link.startswith(perso_client_module.PERSO_RECHARGE_URL)
    assert excinfo.value.link.startswith("https://")
    assert f"utm_source={perso_client_module.CLIENT_HOST}" in excinfo.value.link


def test_perso_client_other_4xx_is_not_credit_exhausted(monkeypatch, tmp_path):
    # A different error status (e.g. 401 auth) must NOT be misread as credit exhaustion.
    monkeypatch.setattr(perso_client_module, "MEDIA_HOST", "https://media.example.com")

    def fake_get(url, params=None, headers=None, timeout=None):
        if url.endswith("/file/api/upload/sas-token"):
            return _FakeHttpxResponse({"detail": "unauthorized"}, status_code=401)
        raise AssertionError(f"unexpected GET {url}")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake-video-bytes")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    with pytest.raises(RuntimeError) as excinfo:
        client.transcribe(str(video))
    assert not isinstance(excinfo.value, PersoCreditExhaustedError)


@pytest.mark.parametrize("status", [401, 403])
def test_perso_client_auth_status_raises_invalid_key(monkeypatch, tmp_path, status):
    # 401/403 -> the key itself is wrong: dedicated exception so the UI can send
    # the user to Settings instead of showing a generic failure.
    monkeypatch.setattr(perso_client_module, "MEDIA_HOST", "https://media.example.com")

    def fake_get(url, params=None, headers=None, timeout=None):
        if url.endswith("/file/api/upload/sas-token"):
            return _FakeHttpxResponse({"detail": "unauthorized"}, status_code=status)
        raise AssertionError(f"unexpected GET {url}")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake-video-bytes")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    with pytest.raises(PersoInvalidKeyError):
        client.transcribe(str(video))


def test_perso_client_5xx_raises_unavailable(monkeypatch, tmp_path):
    # 5xx -> Perso outage: dedicated exception so the UI can say "try again
    # later" instead of implying the user did something wrong.
    monkeypatch.setattr(perso_client_module, "MEDIA_HOST", "https://media.example.com")

    def fake_get(url, params=None, headers=None, timeout=None):
        if url.endswith("/file/api/upload/sas-token"):
            return _FakeHttpxResponse({"detail": "oops"}, status_code=503)
        raise AssertionError(f"unexpected GET {url}")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake-video-bytes")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    with pytest.raises(PersoUnavailableError):
        client.transcribe(str(video))


def test_perso_credit_exhausted_link_explicitly_overridable():
    # The link must come from config/env, never a hardcoded account-specific value --
    # exercised here by passing an explicit link, the same knob PERSO_RECHARGE_URL
    # (read once at module import) feeds into the class's default.
    err = PersoCreditExhaustedError(link="https://example.com/custom-portal")
    assert err.link == "https://example.com/custom-portal"

# ── 6. Client identity: what Perso sees on every call ─────────────────────
# resolve_identity is pure, so each case is one call -- no module reload, which would
# rebind PersoCreditExhaustedError and break the `except` in every other test.

@pytest.mark.parametrize("platform,expected_os", [
    ("darwin", "mac"),
    ("win32", "windows"),
    ("linux", "linux"),
])
def test_identity_names_the_platform_in_friendly_words(platform, expected_os):
    # "mac"/"windows", not sys.platform's raw darwin/win32, so Perso-side stats read as-is.
    # The host is one value on every platform -- the build rides in os=, which is what keeps
    # them separable without the host drifting from what X-Perso-Client-Host sends.
    version, host, ua = perso_client_module.resolve_identity(
        platform, {"PERSODUB_APP_VERSION": "1.2.3"})
    assert (version, host) == ("1.2.3", "desktop_app")
    assert ua == "desktop_app/1.2.3 (os=%s)" % expected_os


def test_version_is_not_a_second_hardcoded_copy():
    # A copy hardcoded here would keep reporting a stale version after a release, silently.
    assert perso_client_module.resolve_identity("darwin", {"PERSODUB_APP_VERSION": "9.9.9"})[0] == "9.9.9"
    # Absent (server run, or a shell too old to pass it) -> an explicit unknown marker.
    assert perso_client_module.resolve_identity("darwin", {})[0] == "0.0.0"


def test_outbound_links_carry_the_running_identity():
    # The UTM source must be the exact host the API headers send, so Perso can line up
    # "API usage by this app" with "visits from this app"; utm_content separates the two links.
    for link, kind in ((perso_client_module.SIGNUP_LINK, "signup"),
                       (perso_client_module.RECHARGE_LINK, "recharge")):
        assert "utm_source=%s" % perso_client_module.CLIENT_HOST in link
        assert "utm_content=%s" % kind in link
        assert "utm_term=v%s" % perso_client_module.APP_VERSION in link


# ── 7. PersoClient.separate() HTTP flow (mocked httpx, no network) ─────────
def _install_fake_perso_sep_http(monkeypatch, progress_sequence, download_info="default"):
    """Fake the separation flow: sas-token -> blob PUT -> register ->
    create audio-separation project -> poll progress -> project detail
    (downloadPathInfo) -> track downloads from MEDIA_HOST."""
    calls = {"get": [], "put": [], "post": []}
    progress_iter = iter(progress_sequence)
    monkeypatch.setattr(perso_client_module, "MEDIA_HOST", "https://media.example.com")
    if download_info == "default":
        download_info = {
            "originalVoicePath": "/perso-storage/voice.wav",
            "originalBackgroundPath": "/perso-storage/background.wav",
            "originalSubBackgroundPath": "/perso-storage/sub.wav",
        }

    def fake_get(url, params=None, headers=None, timeout=None):
        calls["get"].append(url)
        if url.endswith("/file/api/upload/sas-token"):
            return _FakeHttpxResponse({"blobSasUrl": "https://blob.example.com/x?sig=abc"})
        if "/progress" in url:
            return _FakeHttpxResponse({"result": next(progress_iter)})
        if url.startswith("https://media.example.com"):
            r = _FakeHttpxResponse({})
            r.content = b"RIFF-fake-wav"
            return r
        if "/projects/777/spaces/" in url:
            return _FakeHttpxResponse({"result": {"downloadPathInfo": download_info}})
        raise AssertionError(f"unexpected GET {url}")

    def fake_put(url, content=None, json=None, headers=None, timeout=None):
        calls["put"].append(url)
        if url == "https://blob.example.com/x?sig=abc":
            return _FakeHttpxResponse({})
        if url.endswith("/file/api/upload/video"):
            return _FakeHttpxResponse({"seq": 555})
        raise AssertionError(f"unexpected PUT {url}")

    def fake_post(url, json=None, headers=None, timeout=None):
        calls["post"].append(url)
        if "/audio-separation" in url:
            return _FakeHttpxResponse({"result": {"startGenerateProjectIdList": [777]}})
        raise AssertionError(f"unexpected POST {url}")

    monkeypatch.setattr(perso_client_module.httpx, "get", fake_get)
    monkeypatch.setattr(perso_client_module.httpx, "put", fake_put)
    monkeypatch.setattr(perso_client_module.httpx, "post", fake_post)
    return calls


def test_perso_client_separate_happy_path(monkeypatch, tmp_path):
    calls = _install_fake_perso_sep_http(
        monkeypatch,
        progress_sequence=[{"progressReason": "Processing", "hasFailed": False},
                           {"progressReason": "Completed", "hasFailed": False}],
    )
    monkeypatch.setattr(perso_client_module.time, "sleep", lambda s: None)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake-video-bytes")
    out_dir = tmp_path / "work"

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    result = client.separate(str(video), str(out_dir))

    # The two tracks the pipeline needs, saved as real files; sub_background ignored.
    assert set(result) == {"vocals", "background"}
    for p in result.values():
        assert os.path.exists(p)
        with open(p, "rb") as f:
            assert f.read() == b"RIFF-fake-wav"
    assert any("/audio-separation" in u for u in calls["post"])
    # Only voice + background are downloaded from the media host (not sub_background).
    assert sum(u.startswith("https://media.example.com") for u in calls["get"]) == 2


def test_perso_client_separate_raises_without_tracks(monkeypatch, tmp_path):
    _install_fake_perso_sep_http(
        monkeypatch,
        progress_sequence=[{"progressReason": "Completed", "hasFailed": False}],
        download_info={},
    )
    monkeypatch.setattr(perso_client_module.time, "sleep", lambda s: None)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"x")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    with pytest.raises(RuntimeError):
        client.separate(str(video), str(tmp_path / "work"))


def test_upload_media_is_cached_per_video(monkeypatch, tmp_path):
    # Separation + Perso STT on the same job must not upload the video twice.
    calls = _install_fake_perso_sep_http(monkeypatch, progress_sequence=[])
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"x")

    client = PersoClient(api_key="dummy-key", space_seq=999, poll_interval=0)
    first = client._upload_media(str(video), 999)
    second = client._upload_media(str(video), 999)

    assert first == second == 555
    assert sum(u.endswith("/file/api/upload/sas-token") for u in calls["get"]) == 1


# ── 8. pipeline._separate_with_perso (fake client, no network) ─────────────
def test_separate_with_perso_uses_client_and_maps_tracks(tmp_path):
    from app import pipeline as pipeline_module

    class FakeClient:
        def __init__(self):
            self.cancel_check = None
            self.calls = []

        def describe_workspace(self):
            return {"seq": 9, "name": "My Space", "credits": 100}

        def separate(self, video_path, out_dir):
            self.calls.append((video_path, out_dir))
            return {"vocals": "/w/perso_vocals.wav", "background": "/w/perso_background.wav"}

    fake = FakeClient()
    logs = []
    sep_paths, pc = pipeline_module._separate_with_perso(
        "/v/in.mp4", "/w", perso_client=fake,
        cancel_check=lambda: False, on_notice=None, log=logs.append)

    assert pc is fake
    assert sep_paths == {"vocals": "/w/perso_vocals.wav", "background": "/w/perso_background.wav"}
    assert fake.calls == [("/v/in.mp4", "/w")]
    assert any("My Space" in l for l in logs)


def test_separate_with_perso_credit_exhausted_notice():
    from app import pipeline as pipeline_module

    class FakeClient:
        cancel_check = None

        def describe_workspace(self):
            return None

        def separate(self, video_path, out_dir):
            raise PersoCreditExhaustedError()

    notices = []
    with pytest.raises(RuntimeError):
        pipeline_module._separate_with_perso(
            "/v/in.mp4", "/w", perso_client=FakeClient(),
            cancel_check=None, on_notice=notices.append, log=lambda m: None)
    assert notices and notices[0]["type"] == "perso_credit_exhausted"
