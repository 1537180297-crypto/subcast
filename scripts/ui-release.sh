#!/usr/bin/env bash
# Hot update of the interface (HTML/JS/CSS): ships a front-end fix to everyone on the current app version
# without a signed, notarized release. The app checks https://subcast.qiaomu.ai/tools/ui/manifest.json and uses
# the new interface from the next launch (src-tauri/src/ota.rs). Read docs/RELEASING.md first.
#
# Usage: scripts/ui-release.sh [--rollout N] [--notes "text"] [--dry-run]
#        scripts/ui-release.sh --rollback        # everyone on this app version back to the built-in interface
#
# Refuses when src-tauri/ changed since the v<version> tag: a change on the Rust side needs an app release.
set -euo pipefail
cd "$(dirname "$0")/.."

ROLLOUT=100; NOTES=""; DRY=0; ROLLBACK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rollout) ROLLOUT="$2"; shift ;;
    --notes) NOTES="$2"; shift ;;
    --dry-run) DRY=1 ;;
    --rollback) ROLLBACK=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION=$(node -p 'require("./src-tauri/tauri.conf.json").version')
KEY="$HOME/.tauri/subcast-updater.key"
SSH_HOST="${SSH_HOST:-myvps}"
REMOTE="/www/wwwroot/subcast-tools/ui"   # served at https://subcast.qiaomu.ai/tools/ui/ (outside the site root)
BASE_URL="https://subcast.qiaomu.ai/tools/ui"
OUT="release/ui/$VERSION"
mkdir -p "$OUT"

git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || { echo "no tag v$VERSION: release the app first" >&2; exit 1; }
if [ "$ROLLBACK" = 0 ]; then
  if ! git diff --quiet "v$VERSION" -- src-tauri; then
    echo "src-tauri/ changed since v$VERSION; that needs an app release, not a hot update:" >&2
    git diff --stat "v$VERSION" -- src-tauri >&2
    exit 1
  fi
  [ -z "$(git status --porcelain -- src)" ] || { echo "uncommitted changes in src/; commit them first" >&2; exit 1; }
fi

# The next build number: one above what the server has for this app version (builds start at 1).
# No manifest yet (the first hot update) counts as 0; `|| true` keeps pipefail from printing a second 0.
CURRENT=$({ curl -fsS "$BASE_URL/manifest.json" 2>/dev/null || true; } | VERSION="$VERSION" node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const m = JSON.parse(s); console.log(m.shell === process.env.VERSION ? m.build : 0); } catch { console.log(0); }
  });')
BUILD=$((CURRENT + 1))
echo "==> app $VERSION, interface build $BUILD (server has ${CURRENT})"

if [ "$ROLLBACK" = 1 ]; then
  VERSION="$VERSION" BUILD="$BUILD" node -e '
    const { VERSION, BUILD } = process.env;
    require("fs").writeFileSync(process.argv[1], JSON.stringify({ build: +BUILD, shell: VERSION, rollback: true, notes: "rollback" }, null, 2) + "\n");' "$OUT/manifest.json"
else
  npx vite build >/dev/null
  ARCHIVE="subcast-ui-$VERSION-$BUILD.tar.gz"
  COPYFILE_DISABLE=1 tar -czf "$OUT/$ARCHIVE" -C dist .
  SHA=$(shasum -a 256 "$OUT/$ARCHIVE" | cut -d' ' -f1)
  SIZE=$(wc -c < "$OUT/$ARCHIVE" | tr -d ' ')
  VERSION="$VERSION" BUILD="$BUILD" URL="$BASE_URL/$ARCHIVE" SHA="$SHA" SIZE="$SIZE" ROLLOUT="$ROLLOUT" NOTES="$NOTES" node -e '
    const e = process.env;
    const m = { build: +e.BUILD, shell: e.VERSION, url: e.URL, sha256: e.SHA, size: +e.SIZE, rollout: +e.ROLLOUT, rollback: false, notes: e.NOTES, created: new Date().toISOString() };
    require("fs").writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");' "$OUT/manifest.json"
fi
rm -f "$OUT/manifest.json.sig"
# The build exports no key here, but a shell might: the signer refuses -f together with the env key.
env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD npx tauri signer sign -f "$KEY" -p "" "$OUT/manifest.json" >/dev/null
cat "$OUT/manifest.json"

if [ "$DRY" = 1 ]; then echo "dry run: built into $OUT, nothing uploaded"; exit 0; fi
ssh "$SSH_HOST" "mkdir -p '$REMOTE'"
# The archive first, then the signature and manifest together: a client never sees a manifest whose archive is missing.
[ "$ROLLBACK" = 1 ] || rsync -a "$OUT/$ARCHIVE" "$SSH_HOST:$REMOTE/"
rsync -a "$OUT/manifest.json.sig" "$SSH_HOST:$REMOTE/manifest.json.sig.new"
rsync -a "$OUT/manifest.json" "$SSH_HOST:$REMOTE/manifest.json.new"
ssh "$SSH_HOST" "cd '$REMOTE' && mv -f manifest.json.sig.new manifest.json.sig && mv -f manifest.json.new manifest.json"
# Captured first: `curl | grep -q` under pipefail can die of SIGPIPE (141) after grep matches.
LIVE=$(curl -fsS "$BASE_URL/manifest.json")
grep -q "\"build\": $BUILD" <<<"$LIVE" && echo "published interface build $BUILD for app $VERSION"
