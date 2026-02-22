# AGENTS.md

This repository is GNOME-extension only.

## Scope
Applies to the whole repository.

## Project Overview
Speechy Go is a GNOME Shell extension with a Python companion service.

- Shell extension code: `gnome/`
- Companion service: `companion/`
- Local build/install scripts: `scripts/`

## Key Runtime Paths
- `gnome/extension.js`: panel indicator, menu actions, keybindings, live dictation, auto-paste behavior
- `gnome/prefs.js`: Adw preferences UI
- `gnome/schemas/org.speechygo.gschema.xml`: all GNOME settings
- `gnome/services/ipcClient.js`: invokes companion requests
- `companion/main.py`: health check, record/transcribe, enhance text, live streaming over Deepgram WebSocket

## Commands
```bash
npm install
npm run gnome:build
npm run gnome:install
npm run gnome:health
npm run gnome:companion-stdio
```

## Guardrails
- Do not hand-edit generated build output in `.build/` or `dist/`.
- If adding/changing GNOME settings, update all of:
  - `gnome/schemas/org.speechygo.gschema.xml`
  - `gnome/prefs.js`
  - `gnome/extension.js` (`_runtimeConfig()` and usage)
- Keep docs synchronized with behavior (`README.md`, `docs/`).
- Preserve extension UUID consistency in `gnome/metadata.json` and install/build scripts.

## Verification After Changes
1. `npm run gnome:build`
2. `npm run gnome:health`
3. Manual shell smoke test:
   - Start/stop standard recording
   - Start/stop live dictation
   - Verify auto-paste behavior
   - Verify shortcuts (`Ctrl+Shift+H`, `Ctrl+Shift+L`)
