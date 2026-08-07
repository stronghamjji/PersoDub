# opendub app image — lightweight orchestrator (the heavy AI work is handled by the
# Qwen3-TTS sidecar + Ollama, both reached over HTTP, not by a docker-exec'd container).
#
# NOTE (2026-07-30): this Docker route is currently UNTESTED. The app also relies on
# several subprocess interpreters (SEP_PYTHON/DIAR_PYTHON/STT_PYTHON/QWEN_SCORER_PYTHON/
# NONVERBAL_WHISPER_PYTHON, see app/config.py) that this image does not build or provide;
# without them, local Demucs separation, CAM++ diarization, local Whisper STT, and the
# best-of-N take scorer will all fail inside the container. The supported way to run this
# app today is the local `uvicorn` command in README.md. Update this file (and remove this
# note) once the docker path is verified to actually work end-to-end.

FROM python:3.11-slim
# ffmpeg: used to guarantee the final video length (ensure_video_length)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-docker.txt .
RUN pip install --no-cache-dir -r requirements-docker.txt

COPY app ./app
COPY static ./static
# app/main.py mounts ui/src at import time -- without it the container
# dies on startup.
COPY ui ./ui

# Exposed on internal-only address (127.0.0.1) — runs in host network mode
CMD ["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8860"]
