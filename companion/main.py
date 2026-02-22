#!/usr/bin/env python3
"""Speechy Go companion service.

Implements local JSON IPC actions for GNOME extension:
- health_check
- start_recording
- stop_recording
- transcribe_file
- enhance_text

Also supports a live streaming mode for real-time dictation via Deepgram WebSockets.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SCRIPT_NAME = "speechygo-companion"
STATE_FILE = Path(tempfile.gettempdir()) / f"speechygo_recording_state_{os.getuid()}.json"
MIN_AUDIO_BYTES = 1000

STREAM_SAMPLE_RATE = 16000
STREAM_CHANNELS = 1
STREAM_SAMPLE_WIDTH_BYTES = 2
DEFAULT_STREAM_CHUNK_MS = 100
MIN_STREAM_CHUNK_MS = 20
MAX_STREAM_CHUNK_MS = 500


class CompanionError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def ok_response(request_id: str, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": request_id,
        "ok": True,
        "result": result,
    }


def error_response(
    request_id: str,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": request_id,
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
        },
    }


def emit_stream_event(event_type: str, **payload: Any) -> None:
    event = {"type": event_type}
    event.update(payload)
    print(json.dumps(event), flush=True)


def clamp(value: int, min_value: int, max_value: int) -> int:
    return max(min_value, min(max_value, value))


def load_state() -> dict[str, Any] | None:
    if not STATE_FILE.exists():
        return None

    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def write_state(state: dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state), encoding="utf-8")


def clear_state() -> None:
    try:
        STATE_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def available_backends() -> dict[str, bool]:
    return {
        "gstreamer": shutil.which("gst-launch-1.0") is not None,
        "parecord": shutil.which("parecord") is not None,
        "arecord": shutil.which("arecord") is not None,
    }


def choose_backend(preferred: str) -> str:
    backends = available_backends()
    choice = preferred.strip().lower() if preferred else "auto"

    if choice == "auto":
        for name in ("gstreamer", "parecord", "arecord"):
            if backends.get(name):
                return name
        raise CompanionError(
            "AUDIO_DEVICE_NOT_FOUND",
            "No recording backend found (gst-launch-1.0, parecord, arecord).",
        )

    if choice not in backends:
        raise CompanionError(
            "INVALID_CONFIG",
            f"Unknown recording backend '{choice}'.",
            {"allowed": ["auto", "gstreamer", "parecord", "arecord"]},
        )

    if not backends[choice]:
        raise CompanionError(
            "AUDIO_DEVICE_NOT_FOUND",
            f"Requested backend '{choice}' is not available on this system.",
        )

    return choice


def choose_streaming_backend(preferred: str) -> str:
    """Choose backend for real-time streaming.

    Streaming to stdout is reliably supported with parecord/arecord.
    """
    backends = available_backends()
    choice = preferred.strip().lower() if preferred else "auto"

    if choice in ("", "auto", "gstreamer"):
        if backends.get("parecord"):
            return "parecord"
        if backends.get("arecord"):
            return "arecord"
        raise CompanionError(
            "AUDIO_DEVICE_NOT_FOUND",
            "No streaming-capable recording backend found (parecord or arecord).",
        )

    if choice not in ("parecord", "arecord"):
        raise CompanionError(
            "INVALID_CONFIG",
            f"Unsupported live-streaming backend '{choice}'.",
            {"allowed": ["auto", "parecord", "arecord"]},
        )

    if not backends.get(choice):
        raise CompanionError(
            "AUDIO_DEVICE_NOT_FOUND",
            f"Requested streaming backend '{choice}' is not available.",
        )

    return choice


def recording_command(backend: str, output_file: str) -> list[str]:
    if backend == "gstreamer":
        return [
            "gst-launch-1.0",
            "-q",
            "pulsesrc",
            "!",
            "audioconvert",
            "!",
            "audioresample",
            "!",
            "audio/x-raw,rate=16000,channels=1",
            "!",
            "wavenc",
            "!",
            "filesink",
            f"location={output_file}",
        ]

    if backend == "parecord":
        return [
            "parecord",
            "--format=s16le",
            "--rate=16000",
            "--channels=1",
            output_file,
        ]

    if backend == "arecord":
        return [
            "arecord",
            "-f",
            "S16_LE",
            "-r",
            "16000",
            "-c",
            "1",
            "-t",
            "wav",
            output_file,
        ]

    raise CompanionError("INVALID_CONFIG", f"Unsupported backend '{backend}'.")


def streaming_record_command(backend: str, chunk_ms: int) -> list[str]:
    if backend == "parecord":
        latency = max(chunk_ms, 40)
        return [
            "parecord",
            "--raw",
            "--format=s16le",
            "--rate=16000",
            "--channels=1",
            "--process-time-msec",
            str(chunk_ms),
            "--latency-msec",
            str(latency),
        ]

    if backend == "arecord":
        return [
            "arecord",
            "-q",
            "-f",
            "S16_LE",
            "-r",
            "16000",
            "-c",
            "1",
            "-t",
            "raw",
        ]

    raise CompanionError("INVALID_CONFIG", f"Unsupported streaming backend '{backend}'.")


def http_json_request(url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url=url,
        headers=headers,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload)
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        raise CompanionError(
            "NETWORK_ERROR",
            f"HTTP error {exc.code}: {response_body[:800]}",
            {"status": exc.code},
        ) from exc
    except urllib.error.URLError as exc:
        raise CompanionError("NETWORK_ERROR", f"Network request failed: {exc}") from exc


def deepgram_transcribe(audio_file: str, config: dict[str, Any]) -> str:
    api_key = str(config.get("deepgram_api_key", "")).strip()
    if not api_key:
        raise CompanionError("INVALID_CONFIG", "Deepgram API key is missing.")

    with open(audio_file, "rb") as file_handle:
        audio_bytes = file_handle.read()

    request = urllib.request.Request(
        url="https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "audio/wav",
        },
        data=audio_bytes,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        code = "DEEPGRAM_AUTH_FAILED" if exc.code in (401, 403) else "NETWORK_ERROR"
        raise CompanionError(
            code,
            f"Deepgram request failed ({exc.code}): {response_body[:800]}",
            {"status": exc.code},
        ) from exc
    except urllib.error.URLError as exc:
        raise CompanionError("NETWORK_ERROR", f"Deepgram connection failed: {exc}") from exc

    transcript = (
        payload.get("results", {})
        .get("channels", [{}])[0]
        .get("alternatives", [{}])[0]
        .get("transcript", "")
    )

    transcript = transcript.strip()
    if not transcript:
        raise CompanionError("NO_SPEECH_DETECTED", "No speech detected in the recording.")

    return transcript


def gemini_enhance_text(text: str, config: dict[str, Any], standalone: bool) -> str:
    api_key = str(config.get("gemini_api_key", "")).strip()
    if not api_key:
        raise CompanionError("INVALID_CONFIG", "Gemini API key is missing.")

    model = str(config.get("gemini_model", "gemini-3-flash-preview")).strip() or "gemini-3-flash-preview"

    if standalone:
        default_prompt = (
            "You are a professional editor. Enhance the following text by improving punctuation, "
            "clarity, structure, and professional tone. Keep the original meaning and return only "
            "the enhanced text."
        )
        prompt = str(config.get("enhance_prompt", default_prompt)).strip() or default_prompt
    else:
        default_prompt = (
            "Improve this transcription by adding proper punctuation, capitalization, and formatting. "
            "Keep the original meaning intact. Only return the improved text, nothing else:"
        )
        prompt = str(config.get("gemini_prompt", default_prompt)).strip() or default_prompt

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(api_key)}"
    )

    body = {
        "contents": [
            {
                "parts": [
                    {
                        "text": f"{prompt}\n\n{text}",
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 2048,
        },
    }

    response = http_json_request(
        url=url,
        headers={"Content-Type": "application/json"},
        body=body,
    )

    candidates = response.get("candidates", [])
    first = candidates[0] if candidates else {}
    output = (
        first.get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
        .strip()
    )

    if output:
        return output

    finish_reason = first.get("finishReason")
    if finish_reason:
        raise CompanionError(
            "GEMINI_RESPONSE_ERROR",
            f"Gemini returned no text (finish reason: {finish_reason}).",
        )

    raise CompanionError("GEMINI_RESPONSE_ERROR", "Gemini returned an unexpected response payload.")


def start_recording(config: dict[str, Any]) -> dict[str, Any]:
    existing = load_state()
    if existing and is_process_alive(int(existing.get("pid", -1))):
        raise CompanionError("RECORDING_IN_PROGRESS", "Recording is already in progress.")

    backend = choose_backend(str(config.get("recording_backend", "auto")))

    temp_path = Path(tempfile.gettempdir()) / f"speechygo_{int(time.time() * 1000)}.wav"
    command = recording_command(backend, str(temp_path))

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
    except OSError as exc:
        raise CompanionError("AUDIO_START_FAILED", f"Failed to start recording: {exc}") from exc

    time.sleep(0.2)
    if process.poll() is not None:
        raise CompanionError(
            "AUDIO_START_FAILED",
            f"Recording backend '{backend}' exited immediately. Check microphone permissions.",
        )

    write_state(
        {
            "pid": process.pid,
            "backend": backend,
            "audio_file": str(temp_path),
            "started_at": time.time(),
        }
    )

    return {
        "message": f"Recording started using {backend}.",
        "backend": backend,
        "audio_file": str(temp_path),
    }


def stop_recording(config: dict[str, Any]) -> dict[str, Any]:
    state = load_state()
    if not state:
        raise CompanionError("NOT_RECORDING", "No active recording session found.")

    pid = int(state.get("pid", -1))
    started_at = float(state.get("started_at", time.time()))
    audio_file = str(state.get("audio_file", ""))

    try:
        os.killpg(pid, signal.SIGINT)
    except ProcessLookupError:
        pass

    timeout_at = time.time() + 3.0
    while time.time() < timeout_at and is_process_alive(pid):
        time.sleep(0.1)

    if is_process_alive(pid):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    clear_state()

    if not audio_file or not Path(audio_file).exists():
        raise CompanionError("AUDIO_FILE_MISSING", "Recorded audio file was not created.")

    file_size = Path(audio_file).stat().st_size
    if file_size < MIN_AUDIO_BYTES:
        try:
            Path(audio_file).unlink(missing_ok=True)
        except OSError:
            pass
        raise CompanionError("NO_SPEECH_DETECTED", "Recording is too short or empty.")

    try:
        raw_text = deepgram_transcribe(audio_file, config)

        final_text = raw_text
        enhanced = False
        if bool(config.get("enable_gemini")) and str(config.get("gemini_api_key", "")).strip():
            final_text = gemini_enhance_text(raw_text, config, standalone=False)
            enhanced = final_text.strip() != raw_text.strip()

        return {
            "raw_text": raw_text,
            "final_text": final_text,
            "enhanced": enhanced,
            "duration_ms": int((time.time() - started_at) * 1000),
            "audio_bytes": file_size,
        }
    finally:
        try:
            Path(audio_file).unlink(missing_ok=True)
        except OSError:
            pass


def transcribe_file(payload: dict[str, Any]) -> dict[str, Any]:
    audio_file = str(payload.get("audio_file", "")).strip()
    if not audio_file:
        raise CompanionError("INVALID_REQUEST", "'audio_file' is required for transcribe_file.")

    if not Path(audio_file).exists():
        raise CompanionError("AUDIO_FILE_MISSING", "Provided audio file does not exist.")

    config = dict(payload.get("config", {}))
    raw_text = deepgram_transcribe(audio_file, config)
    return {
        "raw_text": raw_text,
        "audio_file": audio_file,
    }


def enhance_text(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text", "")).strip()
    if not text:
        raise CompanionError("INVALID_REQUEST", "Text payload is empty.")

    config = dict(payload.get("config", {}))
    enhanced = gemini_enhance_text(text, config, standalone=True)

    return {
        "text": enhanced,
    }


async def open_deepgram_websocket(url: str, api_key: str):
    try:
        import websockets  # type: ignore
    except ImportError as exc:
        raise CompanionError(
            "MISSING_DEPENDENCY",
            "Python package 'websockets' is required for live streaming mode.",
            {
                "python": sys.executable,
                "hint": f"Install with: {sys.executable} -m pip install --user websockets",
            },
        ) from exc

    headers = {"Authorization": f"Token {api_key}"}
    kwargs = {
        "ping_interval": 20,
        "ping_timeout": 20,
        "max_size": 4 * 1024 * 1024,
    }

    try:
        return await websockets.connect(url, extra_headers=headers, **kwargs)
    except TypeError:
        return await websockets.connect(url, additional_headers=headers, **kwargs)


async def forward_stderr(stream: asyncio.StreamReader | None) -> None:
    if stream is None:
        return

    while True:
        line = await stream.readline()
        if not line:
            break
        message = line.decode("utf-8", errors="replace").strip()
        if message:
            print(f"[stream-backend] {message}", file=sys.stderr, flush=True)


async def stream_audio_chunks(
    stream: asyncio.StreamReader | None,
    ws,
    chunk_bytes: int,
    stop_event: asyncio.Event,
) -> None:
    if stream is None:
        raise CompanionError("AUDIO_START_FAILED", "Recording stream is unavailable.")

    while not stop_event.is_set():
        chunk = await stream.read(chunk_bytes)
        if not chunk:
            break
        await ws.send(chunk)


async def receive_deepgram_events(ws, stop_event: asyncio.Event) -> None:
    async for message in ws:
        if stop_event.is_set():
            break

        if isinstance(message, bytes):
            continue

        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            continue

        alternatives = data.get("channel", {}).get("alternatives", [])
        alternative = alternatives[0] if alternatives else {}
        transcript = str(alternative.get("transcript", "")).strip()
        if not transcript:
            continue

        confidence = float(alternative.get("confidence", 0.0) or 0.0)
        if data.get("is_final"):
            emit_stream_event("final", text=transcript, confidence=confidence)
        else:
            emit_stream_event("interim", text=transcript, confidence=confidence)


async def run_live_stream(config: dict[str, Any]) -> int:
    api_key = str(config.get("deepgram_api_key", "")).strip()
    if not api_key:
        raise CompanionError("INVALID_CONFIG", "Deepgram API key is required for live streaming.")

    preferred_backend = str(config.get("recording_backend", "auto"))
    backend = choose_streaming_backend(preferred_backend)

    model = str(config.get("live_streaming_model", "nova-2")).strip() or "nova-2"
    interim_enabled = bool(config.get("live_streaming_interim_enabled", True))
    chunk_ms = clamp(
        int(config.get("live_streaming_chunk_ms", DEFAULT_STREAM_CHUNK_MS)),
        MIN_STREAM_CHUNK_MS,
        MAX_STREAM_CHUNK_MS,
    )

    params = {
        "model": model,
        "encoding": "linear16",
        "sample_rate": str(STREAM_SAMPLE_RATE),
        "channels": str(STREAM_CHANNELS),
        "interim_results": "true" if interim_enabled else "false",
        "smart_format": "true",
    }
    stream_url = f"wss://api.deepgram.com/v1/listen?{urllib.parse.urlencode(params)}"

    command = streaming_record_command(backend, chunk_ms)
    chunk_bytes = int((STREAM_SAMPLE_RATE * STREAM_CHANNELS * STREAM_SAMPLE_WIDTH_BYTES * chunk_ms) / 1000)

    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()

    def request_stop() -> None:
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_stop)
        except NotImplementedError:
            signal.signal(sig, lambda _s, _f: request_stop())

    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )

    ws = None
    sender: asyncio.Task[None] | None = None
    receiver: asyncio.Task[None] | None = None
    stderr_forwarder: asyncio.Task[None] | None = None
    stop_waiter: asyncio.Task[None] | None = None
    error: Exception | None = None

    try:
        await asyncio.sleep(0.15)
        if process.returncode is not None:
            raise CompanionError(
                "AUDIO_START_FAILED",
                f"Streaming backend '{backend}' exited immediately. Check microphone permissions.",
            )

        # Keep recorder cleanup inside the same try/finally scope so early failures
        # (e.g. missing Python deps or websocket connect errors) do not leak mic processes.
        ws = await open_deepgram_websocket(stream_url, api_key)

        emit_stream_event(
            "session_started",
            backend=backend,
            model=model,
            chunk_ms=chunk_ms,
            interim_results=interim_enabled,
        )

        sender = asyncio.create_task(stream_audio_chunks(process.stdout, ws, chunk_bytes, stop_event))
        receiver = asyncio.create_task(receive_deepgram_events(ws, stop_event))
        stderr_forwarder = asyncio.create_task(forward_stderr(process.stderr))
        stop_waiter = asyncio.create_task(stop_event.wait())

        done, pending = await asyncio.wait(
            {sender, receiver, stop_waiter},
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in done:
            if task is stop_waiter:
                continue
            exc = task.exception()
            if exc:
                error = exc
                break

        stop_event.set()

        for task in pending:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

        if stderr_forwarder is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await stderr_forwarder

        if error:
            raise error

        return 0
    finally:
        stop_event.set()

        for task in (sender, receiver, stop_waiter, stderr_forwarder):
            if task is None:
                continue
            if not task.done():
                task.cancel()
            with contextlib.suppress(Exception):
                await task

        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGINT)
            except ProcessLookupError:
                pass

            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                with contextlib.suppress(Exception):
                    await process.wait()

        emit_stream_event("session_stopped")


def health_check() -> dict[str, Any]:
    backend = "none"
    for name, is_available in available_backends().items():
        if is_available:
            backend = name
            break

    try:
        import websockets  # type: ignore

        websockets_version = getattr(websockets, "__version__", "installed")
    except ImportError:
        websockets_version = "missing"

    return {
        "service": SCRIPT_NAME,
        "python": sys.version.split()[0],
        "recording_backend": backend,
        "available_backends": available_backends(),
        "state_file": str(STATE_FILE),
        "recording_active": bool(load_state()),
        "streaming_websockets": websockets_version,
        "timestamp": int(time.time()),
    }


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    request_id = str(request.get("id", "no-id"))
    action = str(request.get("action", "")).strip()
    payload = dict(request.get("payload", {}))

    if not action:
        return error_response(request_id, "INVALID_REQUEST", "Missing request action.")

    try:
        if action == "health_check":
            return ok_response(request_id, health_check())

        if action == "start_recording":
            config = dict(payload.get("config", {}))
            return ok_response(request_id, start_recording(config))

        if action == "stop_recording":
            config = dict(payload.get("config", {}))
            return ok_response(request_id, stop_recording(config))

        if action == "transcribe_file":
            return ok_response(request_id, transcribe_file(payload))

        if action == "enhance_text":
            return ok_response(request_id, enhance_text(payload))

        raise CompanionError("UNKNOWN_ACTION", f"Unsupported action: {action}")
    except CompanionError as exc:
        return error_response(request_id, exc.code, exc.message, exc.details)
    except Exception as exc:  # pylint: disable=broad-exception-caught
        return error_response(
            request_id,
            "UNKNOWN",
            f"Unexpected error: {exc}",
        )


def run_stdio_loop() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            response = error_response("no-id", "INVALID_REQUEST", f"Invalid JSON: {exc}")
            print(json.dumps(response), flush=True)
            continue

        response = handle_request(request)
        print(json.dumps(response), flush=True)

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Speechy Go companion service")
    parser.add_argument("--health-check", action="store_true", help="Print health check result and exit")
    parser.add_argument("--request", type=str, help="Single JSON request payload")
    parser.add_argument("--stdio", action="store_true", help="Run newline-delimited JSON IPC loop on stdin/stdout")
    parser.add_argument("--stream", action="store_true", help="Run live streaming mode and emit event JSON lines")
    parser.add_argument("--config-json", type=str, default="{}", help="JSON config payload for --stream mode")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.health_check:
        print(json.dumps(health_check()))
        return 0

    if args.request:
        try:
            request = json.loads(args.request)
        except json.JSONDecodeError as exc:
            print(json.dumps(error_response("no-id", "INVALID_REQUEST", f"Invalid JSON: {exc}")))
            return 1

        response = handle_request(request)
        print(json.dumps(response))
        return 0 if response.get("ok") else 1

    if args.stdio:
        return run_stdio_loop()

    if args.stream:
        try:
            config = json.loads(args.config_json or "{}")
        except json.JSONDecodeError as exc:
            emit_stream_event("error", code="INVALID_CONFIG", message=f"Invalid config JSON: {exc}")
            return 1

        try:
            return asyncio.run(run_live_stream(config))
        except CompanionError as exc:
            emit_stream_event("error", code=exc.code, message=exc.message, details=exc.details)
            return 1
        except Exception as exc:  # pylint: disable=broad-exception-caught
            emit_stream_event("error", code="UNKNOWN", message=f"Unexpected streaming error: {exc}")
            return 1

    print("No mode selected. Use --request, --stdio, --stream, or --health-check.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
