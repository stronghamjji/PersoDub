# Acknowledgments

PersoDub stands on these open-source projects.

| Project | Role |
|---|---|
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | Voice-cloning speech synthesis |
| [OmniVoice](https://github.com/k2-fsa/OmniVoice) | Voice-cloning speech synthesis in 646 languages, in place of Qwen3-TTS once its model is downloaded. The model is for personal, non-commercial use only |
| [Demucs](https://github.com/adefossez/demucs) | Source separation — splits speech from background audio |
| [Mel-Band RoFormer](https://huggingface.co/KimberleyJSN/melbandroformer) (network after [BS-RoFormer](https://github.com/lucidrains/BS-RoFormer)) | Source separation in place of Demucs, once its model is downloaded |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Speech recognition |
| [CAM++ (3D-Speaker)](https://github.com/modelscope/3D-Speaker) | Speaker diarization |
| [Ollama](https://github.com/ollama/ollama) + [Hunyuan](https://github.com/Tencent-Hunyuan) | Local translation model and runtime |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | Video and audio processing |
| [video-subtitle-remover](https://github.com/YaoFANGUK/video-subtitle-remover) | Erasing subtitles burned into the picture |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Fetching a video from a pasted link |
| [Electron](https://github.com/electron/electron) | Desktop application framework |

The full list of third-party components and their licenses is in [NOTICE](../NOTICE).

## How the pipeline fits together

```mermaid
flowchart LR
    A["Video"] --> P["Perso API<br/>(if chosen: the whole dub)"]
    A --> B["Source separation<br/>(Mel-Band RoFormer or Demucs)"]
    B --> C["Transcription<br/>(faster-whisper)"]
    C --> D["Speaker diarization<br/>(CAM++)"]
    D --> E["Translation<br/>(ChatGPT, or a local model via Ollama)"]
    E --> F["Speech synthesis<br/>(Qwen3-TTS or OmniVoice)"]
    F --> G["Mix &amp; mux<br/>(FFmpeg)"]
    G --> H["Finished video<br/>(.mp4 + .srt)"]
    P --> H
```

The app itself is a thin orchestrator. By default each heavy stage runs on this computer
as a separate process outside the app's own Python environment, so a failure in one
stage fails that job, not the app; the Perso API, if chosen, makes the whole dub. Architecture details
are in [Architecture](architecture.md#2-the-dubbing-pipeline).
