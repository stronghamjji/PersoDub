"""The OS trust hook the installer drops into every venv
(desktop/vendor/truststore/persodub_truststore.py)."""
import importlib.util
from pathlib import Path

import pytest

HOOK = Path(__file__).resolve().parents[1] / "desktop" / "vendor" / "truststore" / "persodub_truststore.py"


@pytest.fixture(scope="module")
def hook():
    spec = importlib.util.spec_from_file_location("persodub_truststore", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    yield mod
    try:  # importing the hook injects into this process; put ssl back
        import truststore
        truststore.extract_from_ssl()
    except Exception:
        pass


@pytest.mark.parametrize("argv, expected", [
    (["python", "-m", "pip", "install", "x"], True),
    (["python", "/kit/app_venv/bin/pip", "install"], True),
    (["python.exe", "C:\\kit\\app_venv\\Scripts\\pip.exe", "install"], True),
    (["python", "/kit/app_venv/lib/python3.11/site-packages/pip/__pip-runner__.py", "install"], True),
    (["python.exe", "C:\\kit\\app_venv\\Lib\\site-packages\\pip\\__pip-runner__.py", "install"], True),
    (["python", "-m", "uvicorn", "app.main:app"], False),
    (["python", "-m", "huggingface_hub.cli.hf", "download"], False),
    (["python", "/kit/app/script.py"], False),
    (["python"], False),
    ([], False),
])
def test_is_pip(hook, argv, expected):
    assert hook.is_pip(argv) is expected


@pytest.mark.parametrize("version, expected", [
    ("24.0", False), ("24.1.2", False), ("24.2", True), ("26.2.1", True), ("weird", True),
])
def test_pip_trusts_os_store(hook, version, expected):
    assert hook.pip_trusts_os_store(version) is expected


def test_should_inject(hook):
    assert hook.should_inject(["python", "-m", "pip"], lambda: "24.0") is True
    assert hook.should_inject(["python", "-m", "pip"], lambda: "26.2.1") is False

    def never():
        raise AssertionError("pip's version is only asked for pip")
    assert hook.should_inject(["python", "-m", "uvicorn"], never) is True
