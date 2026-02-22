#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
METADATA_PATH="${ROOT_DIR}/gnome/metadata.json"
UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["uuid"])' "${METADATA_PATH}")"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

"${ROOT_DIR}/scripts/build-gnome.sh"

BUILD_DIR="${ROOT_DIR}/.build/gnome/${UUID}"
mkdir -p "$(dirname "${TARGET_DIR}")"
rm -rf "${TARGET_DIR}"
cp -R "${BUILD_DIR}" "${TARGET_DIR}"

# Keep installed files in secure mode to avoid GNOME rejecting the extension.
find "${TARGET_DIR}" -type d -exec chmod 755 {} +
find "${TARGET_DIR}" -type f -exec chmod 644 {} +
chmod 755 "${TARGET_DIR}/companion/main.py"

echo "Installed extension to: ${TARGET_DIR}"

if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions list --user | grep -Fxq "${UUID}"; then
        gnome-extensions disable "${UUID}" >/dev/null 2>&1 || true
        gnome-extensions enable "${UUID}" >/dev/null 2>&1 || true
        echo "Extension detected by GNOME and reloaded."
    else
        echo "GNOME has not discovered ${UUID} yet."
        echo "If this is your first install, log out and log back in, then run:"
        echo "  gnome-extensions enable ${UUID}"
    fi
fi

echo "Manual reload commands:"
echo "  gnome-extensions disable ${UUID} || true"
echo "  gnome-extensions enable ${UUID}"
