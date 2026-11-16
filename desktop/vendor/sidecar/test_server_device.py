"""The voice sidecars' device choice (desktop/vendor/sidecar/server.py,
shared by omnivoice_server.py): "auto" must not pick a GPU this torch build
has no kernels for, or the engine dies while starting with "no kernel image
is available for execution on the device" (issue #235, a GTX 750 Ti,
compute 5.0, under a cu128 build).

Run from the repo root:
  python -m pytest -q desktop/vendor/sidecar/test_server_device.py
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402


def _fake_torch(available, capability, arches):
    cuda = types.SimpleNamespace(
        is_available=lambda: available,
        get_device_capability=lambda index=0: capability,
        get_arch_list=lambda: list(arches),
    )
    return types.SimpleNamespace(cuda=cuda)


CU128 = ["sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]


@pytest.mark.parametrize("capability, arches, expected", [
    ((5, 0), CU128, "cpu"),            # the GPU of issue #235
    ((7, 5), CU128, "cuda:0"),
    ((8, 9), CU128, "cuda:0"),         # same major, newer minor than sm_86
    ((12, 0), CU128, "cuda:0"),
    ((5, 0), ["sm_50", "sm_60"], "cuda:0"),
    ((9, 0), ["sm_80", "compute_80"], "cuda:0"),   # PTX the driver can build
    ((8, 6), [], "cuda:0"),            # a build that does not say: keep the GPU
])
def test_auto_uses_the_gpu_only_when_the_build_has_kernels_for_it(
        monkeypatch, capability, arches, expected):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(True, capability, arches))
    assert server._resolve_device("auto") == expected


def test_auto_without_a_gpu_is_cpu(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(False, (8, 6), CU128))
    assert server._resolve_device("auto") == "cpu"


def test_an_explicit_device_is_kept(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(True, (5, 0), CU128))
    assert server._resolve_device("cuda:0") == "cuda:0"
    assert server._resolve_device("mps") == "mps"
