"""app/timeouts.py: the one shared "does this subprocess timeout scale with
the video" formula used by app/separate.py, app/stt_local.py,
app/diar_campplus_client.py and app/nonverbal.py.

Each of those has its own "computed timeout actually reaches subprocess.run"
wiring test next to it -- this file tests the formula itself, once.
"""
import importlib

from app import timeouts


def test_keeps_the_floor_for_a_short_video():
    # 31s video: 31 * PERSODUB_TIMEOUT_PER_SEC is well under any stage's floor.
    assert timeouts.scaled_timeout(31.0, floor=900) == 900


def test_scales_past_the_floor_for_a_long_video():
    ten_min = 600.0
    expected = min(max(900, ten_min * timeouts.PERSODUB_TIMEOUT_PER_SEC), timeouts.PERSODUB_TIMEOUT_CAP)
    assert timeouts.scaled_timeout(ten_min, floor=900) == expected
    assert expected > 900


def test_capped_so_a_stuck_subprocess_cannot_hang_a_day():
    assert timeouts.scaled_timeout(999999.0, floor=900) == timeouts.PERSODUB_TIMEOUT_CAP


def test_falls_back_to_the_floor_when_duration_is_unknown_zero_or_negative():
    assert timeouts.scaled_timeout(None, floor=900) == 900
    assert timeouts.scaled_timeout(0, floor=900) == 900
    assert timeouts.scaled_timeout(-5.0, floor=900) == 900


def test_a_different_floor_is_respected_unscaled():
    # Each stage passes its own today's-fixed-value floor (diarization's is
    # 600, the nonverbal gate's is 1800) -- confirm the floor itself, not just
    # 900, survives when the scaled budget doesn't beat it.
    assert timeouts.scaled_timeout(1.0, floor=600) == 600
    assert timeouts.scaled_timeout(1.0, floor=1800) == 1800


def test_per_sec_env_override_wins(monkeypatch):
    monkeypatch.setenv("PERSODUB_TIMEOUT_PER_SEC", "1")
    reloaded = importlib.reload(timeouts)
    try:
        assert reloaded.scaled_timeout(600.0, floor=900) == 900  # 600*1 < 900 floor, unchanged
    finally:
        monkeypatch.undo()
        importlib.reload(timeouts)


def test_cap_env_override_wins(monkeypatch):
    monkeypatch.setenv("PERSODUB_TIMEOUT_CAP", "1200")
    reloaded = importlib.reload(timeouts)
    try:
        assert reloaded.scaled_timeout(999999.0, floor=900) == 1200.0
    finally:
        monkeypatch.undo()
        importlib.reload(timeouts)


def test_garbage_env_falls_back_to_defaults(monkeypatch):
    monkeypatch.setenv("PERSODUB_TIMEOUT_PER_SEC", "banana")
    monkeypatch.setenv("PERSODUB_TIMEOUT_CAP", "banana")
    reloaded = importlib.reload(timeouts)
    try:
        assert reloaded.PERSODUB_TIMEOUT_PER_SEC == 6.0
        assert reloaded.PERSODUB_TIMEOUT_CAP == 10800.0
    finally:
        monkeypatch.undo()
        importlib.reload(timeouts)
