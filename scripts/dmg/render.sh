#!/usr/bin/env bash
# Re-render the DMG background PNGs from background.svg (needs rsvg-convert: brew install librsvg).
# scripts/release.sh combines the two into a Retina-aware TIFF with tiffutil at build time.
set -euo pipefail
cd "$(dirname "$0")"
rsvg-convert -w 660 -h 400 background.svg -o background.png
rsvg-convert -w 1320 -h 800 background.svg -o background@2x.png
