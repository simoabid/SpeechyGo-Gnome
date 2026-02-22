# GNOME Extension Status

Speechy Go is maintained here as a GNOME Shell extension with a Python companion service.

## Implemented

- GNOME panel indicator and menu controls
- Standard recording and transcription flow
- Deepgram live streaming dictation (`--stream` mode)
- Gemini enhancement for speech and clipboard text
- Global shortcuts:
  - `Ctrl+Shift+H` standard recording toggle
  - `Ctrl+Shift+L` live dictation toggle
- Wayland-friendly auto-paste and interim/final text injection
- Preferences UI backed by GSettings schema

## Known Limitations

- History menu UI is still a placeholder.
- Notification filtering modes are not fully enforced.
- Live dictation requires the Python `websockets` package in GNOME's Python environment.

## Developer Flow

```bash
npm run gnome:build
npm run gnome:health
npm run gnome:install
```
