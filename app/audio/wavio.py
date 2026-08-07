"""Reading wav files off disk. Depends only on app.audio.pcm.

Split from the PCM primitives so the byte-level transforms stay filesystem-free
and trivially testable, while everything that opens a file lives in one place --
which is also where the eventual audioop replacement will need a seam.
"""
import audioop
import wave

from app.audio.pcm import MIX_WIDTH, SAMPWIDTH, resample_chunk_to_48k_stereo


def read_wav(path: str):
    """Whole file as (raw_pcm, framerate, sampwidth, nchannels)."""
    with wave.open(path, "rb") as w:
        data = w.readframes(w.getnframes())
        return data, w.getframerate(), w.getsampwidth(), w.getnchannels()


def read_span_48k(path: str, start_sec: float, end_sec: float) -> bytes:
    """One [start, end) span as 48kHz stereo MIX_WIDTH PCM.

    Fresh resample state per span -- fine for the correlation estimates this
    serves, which compare a span against another span rather than streaming a
    continuous track.
    """
    with wave.open(path, "rb") as w:
        sr, width, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        a = max(0, min(w.getnframes(), int(round(start_sec * sr))))
        b = max(a, min(w.getnframes(), int(round(end_sec * sr))))
        w.setpos(a)
        raw = w.readframes(b - a)
    data, _ = resample_chunk_to_48k_stereo(raw, sr, width, ch, None)
    return audioop.lin2lin(data, SAMPWIDTH, MIX_WIDTH)
