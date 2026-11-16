#!/bin/bash
# macOS release: Tauri build (Developer ID, hardened runtime) → designed DMG (dmgbuild) → sign → notarize → staple → verify.
#   scripts/release-macos.sh                     arm64 (default)
#   TARGET=x86_64-apple-darwin scripts/release-macos.sh
#   SKIP_NOTARIZE=1 scripts/release-macos.sh     local layout check, no Apple round-trip
#   PREBUILT_APP=path/SubCast.app TARGET=x86_64-apple-darwin scripts/release-macos.sh
#                                                re-sign an existing build (e.g. CI's Intel app) instead of building
# Notary credentials: keychain profile NOTARY_PROFILE (default "notary"), created once with
#   xcrun notarytool store-credentials notary --apple-id <id> --team-id <team>
# Output: dist-mac/SubCast_<version>_<arch>.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${TARGET:-aarch64-apple-darwin}"
case "$TARGET" in
  aarch64-apple-darwin) ARCH=aarch64 ;;
  x86_64-apple-darwin) ARCH=x64 ;;
  *) echo "unsupported TARGET $TARGET"; exit 1 ;;
esac
NAME="SubCast"
VOLUME="SubCast 声渡"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
PROFILE="${NOTARY_PROFILE:-notary}"
APP="src-tauri/target/$TARGET/release/bundle/macos/$NAME.app"
OUT="dist-mac"
DMG="$OUT/${NAME}_${VERSION}_${ARCH}.dmg"

IDENTITY="${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | grep -m1 "Developer ID Application" | sed -E 's/.*"(.*)"/\1/')}"
[ -n "$IDENTITY" ] || { echo "需要 Developer ID Application 证书"; exit 1; }
if [ "${SKIP_NOTARIZE:-0}" != "1" ]; then
  # The profile lives in this Mac's keychain and can be unreadable while the screen is locked (TN3147).
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null || { echo "notarytool profile '$PROFILE' unreadable"; exit 1; }
fi

if [ -n "${PREBUILT_APP:-}" ]; then
  echo "==> re-sign $PREBUILT_APP with: $IDENTITY"
  APP="build/prebuilt-$ARCH/$NAME.app"
  rm -rf "build/prebuilt-$ARCH"; mkdir -p "build/prebuilt-$ARCH"
  ditto "$PREBUILT_APP" "$APP"
  lipo "$APP/Contents/MacOS/subcast" -verify_arch "${TARGET%%-*}"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
else
  echo "==> tauri build ($TARGET) signed by: $IDENTITY"
  # Only the .app: the DMG is built below with dmgbuild (no Finder scripting). Tauri signs with
  # hardened runtime + secure timestamp. Notarization happens on the DMG, so no APPLE_ID here.
  env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_KEY -u APPLE_API_ISSUER \
    APPLE_SIGNING_IDENTITY="$IDENTITY" npx tauri build --target "$TARGET" --bundles app
fi

codesign --verify --strict --deep --verbose=2 "$APP"
SIGINFO=$(codesign -dv --verbose=4 "$APP" 2>&1)
for want in "Authority=Developer ID Application" "flags=0x10000(runtime)" "Timestamp="; do
  grep -qF "$want" <<<"$SIGINFO" || { echo "app signature lacks: $want"; echo "$SIGINFO"; exit 1; }
done

if [ ! -x build/.venv/bin/dmgbuild ]; then
  python3 -m venv build/.venv
  build/.venv/bin/pip install --quiet "dmgbuild==1.6.5"
fi
mkdir -p build "$OUT"
swift scripts/dmg-background.swift build/dmg-bg.png build/dmg-bg@2x.png
tiffutil -cathidpicheck build/dmg-bg.png build/dmg-bg@2x.png -out build/dmg-background.tiff >/dev/null

rm -f "$DMG"
build/.venv/bin/dmgbuild -s scripts/dmg-settings.py -D app="$APP" -D background=build/dmg-background.tiff "$VOLUME" "$DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then echo "DMG (not notarized): $DMG"; exit 0; fi

echo "==> notarize $DMG"
LOG="build/notarize-$ARCH.json"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait --output-format json | tee "$LOG"
STATUS=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('status',''))" "$LOG")
if [ "$STATUS" != "Accepted" ]; then
  ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('id',''))" "$LOG")
  echo "notarization status: $STATUS"; [ -n "$ID" ] && xcrun notarytool log "$ID" --keychain-profile "$PROFILE"
  exit 1
fi
for i in 1 2 3; do xcrun stapler staple "$DMG" && break; sleep 30; done
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature -vv "$DMG"

# The app as a user gets it: copied out of the mounted DMG.
MNT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null
TMPAPP=$(mktemp -d)
ditto "$MNT/$NAME.app" "$TMPAPP/$NAME.app"
hdiutil detach "$MNT" >/dev/null
codesign --verify --strict --deep --verbose=2 "$TMPAPP/$NAME.app"
spctl --assess --type execute -vv "$TMPAPP/$NAME.app"
rm -rf "$TMPAPP"
shasum -a 256 "$DMG" | tee "$DMG.sha256"
echo "DMG: $DMG"
