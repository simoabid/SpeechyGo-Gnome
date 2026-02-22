# Speechy Go Companion Service

This directory contains the native Python companion process used by the GNOME Shell extension.

## Modes

- `--health-check`: print backend/runtime diagnostics as JSON.
- `--request '<json>'`: handle one request and exit.
- `--stdio`: run newline-delimited JSON request/response loop.
- `--stream --config-json '<json>'`: run live streaming mode and emit line-delimited event JSON.

## Supported Actions

- `health_check`
- `start_recording`
- `stop_recording`
- `transcribe_file`
- `enhance_text`

## Example

```bash
python3 companion/main.py --request '{"id":"1","action":"health_check","payload":{}}'
```

Live streaming example:

```bash
python3 companion/main.py --stream --config-json '{"deepgram_api_key":"DG_KEY","recording_backend":"auto","live_streaming_model":"nova-2","live_streaming_chunk_ms":100,"live_streaming_interim_enabled":true}'
```

## Live Streaming Requirements

- `parecord` or `arecord` must be installed for microphone capture.
- `websockets` must be available in the Python environment GNOME uses.

Recommended install command:

```bash
/usr/bin/python3 -m pip install --user --break-system-packages websockets
```
