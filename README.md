# Speechy Go GNOME Extension

Speechy Go is now a GNOME Shell extension project only.

It provides:
- Speech-to-text via Deepgram
- Optional text enhancement via Gemini
- Live streaming dictation mode
- Wayland-friendly auto-paste into the active application

## Project Layout

- `gnome/` GNOME Shell extension code (`extension.js`, `prefs.js`, schema, services)
- `companion/` Python companion service used by the extension
- `scripts/` local build/install scripts for GNOME
- `docs/` technical docs (`ipc-protocol.md`)
- `icon.png` extension icon

## Requirements

- GNOME Shell 46+
- Python 3.10+
- One recording backend available (`parecord` or `arecord`)
- For live dictation: Python package `websockets`

Install `websockets` for the same Python GNOME uses:

```bash
/usr/bin/python3 -m pip install --user --break-system-packages websockets
```

## Commands

```bash
npm install
npm run gnome:build
npm run gnome:install
npm run gnome:health
npm run gnome:companion-stdio
```

## Shortcuts

- Standard recording toggle: `Ctrl+Shift+H`
- Live dictation toggle: `Ctrl+Shift+L`

Both are configurable in extension preferences.

## Local Install

```bash
npm run gnome:install
gnome-extensions disable speechygo@seemoo.dev || true
gnome-extensions enable speechygo@seemoo.dev
```

## Troubleshooting

- If live dictation reports missing websockets, run:

```bash
/usr/bin/python3 -m pip install --user --break-system-packages websockets
npm run gnome:health
```

- If `streaming_websockets` is `missing`, GNOME is using a Python interpreter without the package.
