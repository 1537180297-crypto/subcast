#!/bin/bash
# One-time: give GitHub Actions what tauri-action needs to sign + notarize the macOS builds.
# Run it yourself in a terminal; it prompts for every secret and sends values straight to `gh secret set`.
#   1. In Keychain Access, export "Developer ID Application: …" (certificate + private key) as a .p12
#      with an export password.
#   2. scripts/set-ci-signing-secrets.sh path/to/DeveloperID.p12
# Needs an app-specific password for your Apple ID (appleid.apple.com → Sign-In and Security).
set -euo pipefail
REPO="${REPO:-joeseesun/subcast}"
P12="${1:?usage: $0 DeveloperID.p12}"
[ -f "$P12" ] || { echo "no such file: $P12"; exit 1; }

IDENTITY=$(security find-identity -v -p codesigning | grep -m1 "Developer ID Application" | sed -E 's/.*"(.*)"/\1/')
TEAM=$(echo "$IDENTITY" | sed -E 's/.*\(([A-Z0-9]+)\)$/\1/')
echo "Repo:     $REPO"
echo "Identity: $IDENTITY"
echo "Team:     $TEAM"

base64 -i "$P12" | gh secret set APPLE_CERTIFICATE --repo "$REPO"
read -rsp "p12 export password: " P; echo
printf '%s' "$P" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$REPO"; unset P
printf '%s' "$IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY --repo "$REPO"
printf '%s' "$TEAM" | gh secret set APPLE_TEAM_ID --repo "$REPO"
read -rp "Apple ID email: " AID
printf '%s' "$AID" | gh secret set APPLE_ID --repo "$REPO"; unset AID
read -rsp "App-specific password: " AP; echo
printf '%s' "$AP" | gh secret set APPLE_PASSWORD --repo "$REPO"; unset AP
# Temporary keychain on the runner; any random value works.
openssl rand -hex 24 | gh secret set KEYCHAIN_PASSWORD --repo "$REPO"
gh secret list --repo "$REPO"
