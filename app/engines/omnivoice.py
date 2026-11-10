"""OmniVoice adapter.

Our OmniVoice sidecar (desktop/vendor/sidecar/omnivoice_server.py) speaks the
same HTTP contract as the Qwen3-TTS one (vendor/sidecar/server.py): /health,
/restart, /clone -> voice_id, /generate with that voice_id, and the
x-audio-duration / x-seed headers. So this engine is QwenTTSEngine pointed at
another address, with the few differences below:

- A clone always needs the words said in the sample (ref_text): OmniVoice
  has no "sound alone" mode. Qwen's mode field is sent and ignored.
- The sidecar ignores the speech cap (max_seconds) and never answers
  x-audio-cut, so no OmniVoice line is reported as "ran away"; the voice
  stage's own checks (a line's length against its slot) still apply.
- The rest is the same on both: memory figure and restart, device word,
  numbers written out, stray sounds trimmed, free retakes on this computer.
"""
from app import runtime
from app.engines.qwen_tts import QwenTTSEngine, _no_words_to_clone_with


class OmniVoiceEngine(QwenTTSEngine):
    id = "omnivoice"
    display_name = "OmniVoice (voice clone)"
    log_name = "OmniVoice"
    supports_cloning = True

    @property
    def base_url(self) -> str:
        # runtime.json's omnivoice_url, written by the desktop shell when it
        # starts the sidecar; without a kit (a dev run) runtime.url falls back
        # to the OMNIVOICE_URL setting. Same rule as Qwen's tts_url.
        return (self._base_url or runtime.url("omnivoice")).rstrip("/")

    def clone(self, ref_audio_path: str, ref_text: str = None, mode: str = None) -> str:
        """Register one speaker's sample with its words; `mode` is Qwen's
        choice and does not apply. Said plainly here rather than as the
        sidecar's refusal of a clone without words."""
        if not ref_text or not ref_text.strip():
            raise _no_words_to_clone_with("OmniVoice voice clone")
        # "icl" is Qwen's word for cloning from a sample and its words, which
        # is the only way OmniVoice clones; the sidecar ignores the field.
        return super().clone(ref_audio_path, ref_text, mode="icl")
