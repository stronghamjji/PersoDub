"""ChatGPT sign-in on a computer with no Codex: PersoDub fetches its own copy
(user, 2026-09-28, "Couldn't start" on a tester's Mac)."""
import base64
import hashlib
import io
import os
import tarfile

import pytest
from fastapi.testclient import TestClient

import app.api.agent as agent_api
from app import codex_fetch
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def _tgz(folder="aarch64-apple-darwin"):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data, mode in [
            ("package/package.json", b"{}", 0o644),
            (f"package/vendor/{folder}/bin/codex", b"#!/bin/sh\n", 0o755),
            # Both names, so the "already here" check finds it on either system.
            (f"package/vendor/{folder}/bin/codex.exe", b"MZ", 0o755),
            (f"package/vendor/{folder}/codex-resources/x.txt", b"x", 0o644),
        ]:
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), mode
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class _Resp:
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    headers = {}
    def raise_for_status(self):
        pass
    def iter_content(self, n):
        yield self.body


@pytest.fixture
def kit(tmp_path, monkeypatch):
    k = tmp_path / "kit"
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(k))
    return k


def _serve(monkeypatch, body, sha=None):
    sha = sha or base64.b64encode(hashlib.sha512(body).digest()).decode()
    monkeypatch.setattr(codex_fetch, "package", lambda: ("darwin-arm64", "aarch64-apple-darwin", sha))
    seen = []
    def get(url, **kw):
        seen.append(url)
        return _Resp(body)
    monkeypatch.setattr(codex_fetch.requests, "get", get)
    return seen


def test_the_pinned_package_is_unpacked_into_the_kit(kit, monkeypatch):
    seen = _serve(monkeypatch, _tgz())
    out = codex_fetch.fetch()
    assert out == os.path.join(str(kit), "codex", "bin")
    assert os.access(os.path.join(out, "codex"), os.X_OK)
    assert (kit / "codex" / "codex-resources" / "x.txt").read_text() == "x"
    assert not (kit / "codex" / "package.json").exists()
    assert seen == [f"https://registry.npmjs.org/@openai/codex/-/codex-{codex_fetch.VERSION}-darwin-arm64.tgz"]
    assert sorted(os.listdir(kit)) == ["codex"]   # nothing half-done left behind


def test_a_download_that_does_not_match_its_checksum_is_refused(kit, monkeypatch):
    _serve(monkeypatch, _tgz(), sha="AAAA")
    with pytest.raises(RuntimeError, match="damaged"):
        codex_fetch.fetch()
    assert not os.path.exists(kit / "codex")
    assert os.listdir(kit) == []


def test_every_pinned_package_names_a_real_npm_checksum():
    for suffix, folder, sha in codex_fetch.PACKAGES.values():
        assert len(base64.b64decode(sha)) == 64
        assert folder in ("aarch64-apple-darwin", "x86_64-pc-windows-msvc")


def test_status_offers_sign_in_where_the_program_can_be_fetched(monkeypatch):
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: None)
    monkeypatch.setattr(codex_fetch, "package", lambda: ("darwin-arm64", "x", "y"))
    agent_api._login_cache.clear()
    rows = {a["id"]: a for a in client.get("/api/agent/status?login=1").json()["agents"]}
    assert rows["chatgpt"]["installed"] is True
    assert rows["chatgpt"]["logged_in"] is False
    # The Dub Agent's Codex shares that one sign-in, so it is offered too.
    assert rows["codex"]["installed"] is True and rows["codex"]["logged_in"] is False


def test_sign_in_fetches_the_program_first_then_starts_it(monkeypatch):
    where = {"bin": None}
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: where["bin"])
    def fetch():
        where["bin"] = "/kit/codex/bin/codex"
        return "/kit/codex/bin"
    monkeypatch.setattr(codex_fetch, "fetch", fetch)
    started = []
    monkeypatch.setattr(agent_api.subprocess, "Popen", lambda args, **kw: started.append(args) or type("P", (), {"poll": lambda s: 0})())
    r = client.post("/api/agent/login", json={"agent": "chatgpt"})
    assert r.status_code == 200
    assert started == [["/kit/codex/bin/codex", "login"]]


def test_a_failed_fetch_reaches_the_screen_as_its_sentence(monkeypatch):
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: None)
    def fetch():
        raise RuntimeError("Couldn't download the ChatGPT sign-in. Check your internet and try again.")
    monkeypatch.setattr(codex_fetch, "fetch", fetch)
    r = client.post("/api/agent/login", json={"agent": "chatgpt"})
    assert r.status_code == 502
    assert r.json()["detail"].startswith("Couldn't download the ChatGPT sign-in")


def test_a_second_sign_in_does_not_fetch_again(kit, monkeypatch):
    seen = _serve(monkeypatch, _tgz())
    codex_fetch.fetch()
    codex_fetch.fetch()
    assert len(seen) == 1


def test_progress_counts_the_bytes_and_ends_idle(kit, monkeypatch):
    body = _tgz()
    stages = []
    _serve(monkeypatch, body)
    real = codex_fetch.tarfile.open
    def watching(*a, **k):
        stages.append(dict(codex_fetch.progress))
        return real(*a, **k)
    monkeypatch.setattr(codex_fetch.tarfile, "open", watching)
    codex_fetch.fetch()
    assert stages == [{"stage": "unpack", "got": len(body), "total": 0}]
    assert codex_fetch.progress["stage"] == ""


# The conftest turns the launch prefetch off for every test; this is the real one.
from app.codex_fetch import prefetch as real_prefetch


def _prefetch_env(monkeypatch, *, installed=None, translator="chatgpt"):
    from app import setup
    fetched = []
    monkeypatch.setattr(codex_fetch, "package", lambda: ("darwin-arm64", "x", "y"))
    monkeypatch.setattr(agent_api.agent_base, "find_cli", lambda name: installed)
    monkeypatch.setattr(setup, "default_for", lambda stage: translator)
    monkeypatch.setattr(codex_fetch, "fetch", lambda: fetched.append(1))
    started = []
    class T:
        def __init__(self, target, **k): self.target = target
        def start(self): started.append(1); self.target()
    monkeypatch.setattr(codex_fetch.threading, "Thread", T)
    return fetched


def test_launch_fetches_ahead_when_chatgpt_will_need_it(monkeypatch):
    fetched = _prefetch_env(monkeypatch)
    real_prefetch()
    assert fetched == [1]


def test_launch_leaves_it_alone_when_not_needed(monkeypatch):
    fetched = _prefetch_env(monkeypatch, installed="/usr/bin/codex")
    real_prefetch()
    assert fetched == []
    fetched = _prefetch_env(monkeypatch, translator="hunyuan")
    real_prefetch()
    assert fetched == []


def test_translation_and_the_dub_agent_share_one_sign_in():
    """One Sign In for both (user, 2026-09-28): the agent's Codex runs in the
    same PersoDub-owned home ChatGPT translation signs in to."""
    env = agent_api._env_of(agent_api.AGENTS["codex"])
    assert env is not None
    assert env["CODEX_HOME"] == agent_api._env_of(agent_api.AGENTS["chatgpt"])["CODEX_HOME"]


def test_the_agents_codex_remembers_its_conversation_in_its_own_folder():
    """A conversation remembered from ~/.codex cannot be resumed in PersoDub's
    home ("no rollout found", Mac tester 2026-09-28): a folder of its own
    starts it afresh once, and keeps it after."""
    assert agent_api.AGENTS["codex"]["dir"] == "codex"
    assert agent_api.AGENTS["codex"]["dir"] != agent_api.AGENTS["chatgpt"]["dir"]
