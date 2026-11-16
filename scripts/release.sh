#!/usr/bin/env bash
# Release SubCast.
#   1. Build, sign and notarize the macOS app for Apple Silicon and Intel on this Mac.
#   2. Pull the Windows and Linux builds from the GitHub Actions draft release for the same tag.
#   3. Write latest.json (the in-app updater manifest, plus installer links for the website).
#   4. With --publish: upload everything to subcast.qiaomu.ai/download/ and attach the Mac files to the GitHub release.
#
# Usage: scripts/release.sh [--skip-mac] [--publish] [--notes "text"]
# Needs: ~/.tauri/subcast-updater.key, the Developer ID certificate in the keychain,
#        a notarytool keychain profile named "notary", gh logged in, ssh access to myvps.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

SKIP_MAC=0; PUBLISH=0; NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-mac) SKIP_MAC=1 ;;
    --publish) PUBLISH=1 ;;
    --notes) NOTES="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION=$(node -p 'require("./src-tauri/tauri.conf.json").version')
TAG="v$VERSION"
OUT="release/$VERSION"
KEY="$HOME/.tauri/subcast-updater.key"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: xiangyang qiao (BRCU3DPFH4)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-notary}"
SSH_HOST="${SSH_HOST:-myvps}"
SITE_ROOT="${SITE_ROOT:-/var/www/subcast.qiaomu.ai}"
BASE_URL="https://subcast.qiaomu.ai/download/$VERSION"
mkdir -p "$OUT"

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

notarize() { # file
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait | tee /dev/stderr | grep -q "status: Accepted"
}

if [ "$SKIP_MAC" = 0 ]; then
  for TARGET in aarch64-apple-darwin x86_64-apple-darwin; do
    ARCH=$([ "$TARGET" = aarch64-apple-darwin ] && echo aarch64 || echo x64)
    rustup target add "$TARGET" >/dev/null
    echo "==> building $TARGET"
    APPLE_SIGNING_IDENTITY="$IDENTITY" npm run tauri build -- --target "$TARGET" --bundles app
    APP="src-tauri/target/$TARGET/release/bundle/macos/SubCast.app"
    codesign --verify --deep --strict "$APP"

    echo "==> notarizing the app ($ARCH)"
    ZIP="$(mktemp -d)/SubCast.zip"
    ditto -c -k --keepParent "$APP" "$ZIP"
    notarize "$ZIP"
    xcrun stapler staple "$APP"

    # The updater package has to be made after stapling, so Tauri's own tarball is replaced.
    TGZ="$OUT/SubCast_${VERSION}_${ARCH}.app.tar.gz"
    COPYFILE_DISABLE=1 tar -czf "$TGZ" -C "$(dirname "$APP")" SubCast.app
    rm -f "$TGZ.sig"
    npx tauri signer sign -f "$KEY" -p "" "$TGZ" >/dev/null

    echo "==> disk image ($ARCH)"
    DMG="$OUT/SubCast_${VERSION}_${ARCH}.dmg"
    STAGE="$(mktemp -d)"
    cp -R "$APP" "$STAGE/"
    ln -s /Applications "$STAGE/Applications"
    rm -f "$DMG"
    hdiutil create -volname "SubCast" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
    codesign --sign "$IDENTITY" --timestamp "$DMG"
    notarize "$DMG"
    xcrun stapler staple "$DMG"
    spctl -a -t open --context context:primary-signature -v "$DMG"
  done
fi

echo "==> Windows and Linux builds from the $TAG GitHub release"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release download "$TAG" -D "$OUT" --clobber \
    -p '*-setup.exe' -p '*-setup.exe.sig' -p '*.msi' -p '*.AppImage' -p '*.AppImage.sig' -p '*.deb' -p '*.rpm' || true
else
  echo "   no release $TAG yet; push the tag and let Actions finish to include Windows and Linux" >&2
fi

echo "==> latest.json"
VERSION="$VERSION" BASE_URL="$BASE_URL" NOTES="$NOTES" OUT="$OUT" node <<'JS'
const fs = require("fs"), path = require("path");
const { VERSION, BASE_URL, NOTES, OUT } = process.env;
const files = fs.readdirSync(OUT);
const find = (re) => files.find((f) => re.test(f));
const url = (f) => `${BASE_URL}/${encodeURIComponent(f)}`;
const platforms = {};
const add = (key, re) => {
  const f = find(re);
  if (f && files.includes(f + ".sig")) platforms[key] = { signature: fs.readFileSync(path.join(OUT, f + ".sig"), "utf8").trim(), url: url(f) };
};
add("darwin-aarch64", /_aarch64\.app\.tar\.gz$/);
add("darwin-x86_64", /_x64\.app\.tar\.gz$/);
add("windows-x86_64", /-setup\.exe$/);
add("linux-x86_64", /\.AppImage$/);
const dl = {};
const link = (key, re) => { const f = find(re); if (f) dl[key] = { url: url(f), size: fs.statSync(path.join(OUT, f)).size }; };
link("mac-arm", /_aarch64\.dmg$/);
link("mac-intel", /_x64\.dmg$/);
link("windows", /-setup\.exe$/);
link("windows-msi", /\.msi$/);
link("linux-appimage", /\.AppImage$/);
link("linux-deb", /\.deb$/);
link("linux-rpm", /\.rpm$/);
const manifest = { version: VERSION, notes: NOTES || `SubCast ${VERSION}`, pub_date: new Date().toISOString(), platforms, downloads: dl };
fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("platforms:", Object.keys(platforms).join(", ") || "(none)");
console.log("downloads:", Object.keys(dl).join(", ") || "(none)");
JS

if [ "$PUBLISH" = 1 ]; then
  echo "==> uploading to $SSH_HOST:$SITE_ROOT/download/"
  ssh "$SSH_HOST" "mkdir -p '$SITE_ROOT/download/$VERSION'"
  rsync -av --progress "$OUT/" "$SSH_HOST:$SITE_ROOT/download/$VERSION/"
  # latest.json goes last so clients never see a manifest whose files are not there yet.
  rsync -av "$OUT/latest.json" "$SSH_HOST:$SITE_ROOT/download/latest.json"
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" --clobber "$OUT"/*.dmg "$OUT"/*.app.tar.gz "$OUT"/*.app.tar.gz.sig "$OUT/latest.json"
  fi
  echo "published $VERSION"
else
  echo "built into $OUT (run again with --skip-mac --publish to upload)"
fi
