"""The catalog's HF downloads run the `hf` CLI from app_venv -- the one venv a
light install always has. Until 0.5.1 it ran from qwen_venv, which is gone."""
import os
import sys

from app import models as models_module


def test_hf_cli_lives_in_app_venv():
    path = models_module._hf_cli("/kit")
    parts = path.replace("\\", "/").split("/")
    assert "app_venv" in parts
    assert "qwen_venv" not in parts
    assert parts[-1] == ("hf.exe" if sys.platform == "win32" else "hf")


def test_pull_hf_invokes_the_app_venv_cli(monkeypatch, tmp_path):
    seen = {}

    class FakeProc:
        stdout = iter(["  50%", " 100%"])

        def wait(self):
            return 0

    def fake_popen(argv, **kw):
        seen["argv"] = argv
        return FakeProc()

    monkeypatch.setattr(models_module._subprocess, "Popen", fake_popen)
    entry = {"dir": "models/demucs/HTDemucs",
             "source": {"kind": "hf", "repo": "adefossez/HTDemucs", "rev": "abc",
                        "files": ["htdemucs.yaml"]}}
    pcts = []
    models_module._pull_hf(entry, str(tmp_path), pcts.append, lambda: False)
    assert seen["argv"][0] == models_module._hf_cli(str(tmp_path))
    assert seen["argv"][1:4] == ["download", "adefossez/HTDemucs", "htdemucs.yaml"]
    assert "--revision" in seen["argv"] and "--local-dir" in seen["argv"]
    assert pcts == [50, 100]
    assert os.path.isdir(tmp_path / "models" / "demucs" / "HTDemucs")
