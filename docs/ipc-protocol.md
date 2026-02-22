# Speechy Go Companion IPC Protocol v1

Companion responses are JSON objects with either `ok: true` and `result`, or `ok: false` and `error`.

## Request Envelope

```json
{
  "id": "string",
  "action": "health_check | start_recording | stop_recording | transcribe_file | enhance_text",
  "payload": {}
}
```

## Success Envelope

```json
{
  "id": "string",
  "ok": true,
  "result": {}
}
```

## Error Envelope

```json
{
  "id": "string",
  "ok": false,
  "error": {
    "code": "STRING_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```

## Known Error Codes

- `INVALID_REQUEST`
- `INVALID_CONFIG`
- `UNKNOWN_ACTION`
- `AUDIO_DEVICE_NOT_FOUND`
- `AUDIO_START_FAILED`
- `RECORDING_IN_PROGRESS`
- `NOT_RECORDING`
- `AUDIO_FILE_MISSING`
- `NO_SPEECH_DETECTED`
- `DEEPGRAM_AUTH_FAILED`
- `GEMINI_RESPONSE_ERROR`
- `NETWORK_ERROR`
- `UNKNOWN`
