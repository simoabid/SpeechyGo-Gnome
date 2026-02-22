#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
METADATA_PATH="${ROOT_DIR}/gnome/metadata.json"

if [[ ! -f "${METADATA_PATH}" ]]; then
    echo "Missing metadata file: ${METADATA_PATH}" >&2
    exit 1
fi

UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["uuid"])' "${METADATA_PATH}")"
BUILD_BASE="${ROOT_DIR}/.build/gnome"
EXTENSION_DIR="${BUILD_BASE}/${UUID}"
DIST_DIR="${ROOT_DIR}/dist"
ZIP_PATH="${DIST_DIR}/speechygo-gnome-extension.zip"

rm -rf "${EXTENSION_DIR}"
mkdir -p "${EXTENSION_DIR}" "${DIST_DIR}"

cp "${ROOT_DIR}/gnome/metadata.json" "${EXTENSION_DIR}/metadata.json"
cp "${ROOT_DIR}/gnome/extension.js" "${EXTENSION_DIR}/extension.js"
cp "${ROOT_DIR}/gnome/prefs.js" "${EXTENSION_DIR}/prefs.js"
cp "${ROOT_DIR}/gnome/stylesheet.css" "${EXTENSION_DIR}/stylesheet.css"
cp "${ROOT_DIR}/icon.png" "${EXTENSION_DIR}/icon.png"

mkdir -p "${EXTENSION_DIR}/services" "${EXTENSION_DIR}/lib" "${EXTENSION_DIR}/schemas"
cp "${ROOT_DIR}/gnome/services/"*.js "${EXTENSION_DIR}/services/"
cp "${ROOT_DIR}/gnome/lib/"*.js "${EXTENSION_DIR}/lib/"
cp "${ROOT_DIR}/gnome/schemas/"*.xml "${EXTENSION_DIR}/schemas/"
cp -R "${ROOT_DIR}/companion" "${EXTENSION_DIR}/companion"

# Use safe extension permissions so GNOME does not reject files as insecure.
find "${EXTENSION_DIR}" -type d -exec chmod 755 {} +
find "${EXTENSION_DIR}" -type f -exec chmod 644 {} +
chmod 755 "${EXTENSION_DIR}/companion/main.py"

if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "${EXTENSION_DIR}/schemas"
else
    echo "Warning: glib-compile-schemas not found; install glib2 to compile schemas." >&2
fi

rm -f "${ZIP_PATH}"
(
    cd "${BUILD_BASE}"
    zip -rq "${ZIP_PATH}" "${UUID}"
)

echo "Built GNOME extension directory: ${EXTENSION_DIR}"
echo "Packaged zip: ${ZIP_PATH}"
