#!/bin/bash
# BetterClaude installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/ara-mkr/betterclaude/main/scripts/install.sh | bash
#
# Downloads the latest release for this Mac (Apple Silicon or Intel) straight
# from GitHub Releases and puts BetterClaude.app in /Applications. The builds
# are ad-hoc signed but not notarized, so a copy downloaded through a browser
# trips Gatekeeper ("Apple could not verify…"). A copy fetched with curl isn't
# quarantined, so this way it simply opens. Running it again updates in place.
set -euo pipefail

REPO="ara-mkr/betterclaude"
APP="BetterClaude.app"
# BETTERCLAUDE_DIR installs somewhere else (testing): no quitting, no opening.
DEST="${BETTERCLAUDE_DIR:-/Applications}"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows, run in PowerShell: irm https://raw.githubusercontent.com/$REPO/main/scripts/install.ps1 | iex"

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64)
    # An Intel shell under Rosetta on Apple Silicon still wants the arm64 build.
    if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = "1" ]; then ARCH="arm64"; else ARCH="x64"; fi ;;
  *) die "Unsupported Mac architecture: $(uname -m)" ;;
esac

say "Finding the latest BetterClaude release…"
API="https://api.github.com/repos/$REPO/releases/latest"
URL=$(curl -fsSL "$API" | grep -o "\"browser_download_url\": *\"[^\"]*-$ARCH\.zip\"" | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/') || true
[ -n "${URL:-}" ] || die "Couldn't find a macOS $ARCH download in the latest release. Get it from https://github.com/$REPO/releases/latest"
VERSION=$(printf '%s' "$URL" | sed -E 's/.*BetterClaude-([^-]+)-.*/\1/')

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "Downloading BetterClaude $VERSION ($ARCH)…"
curl -fL --progress-bar -o "$TMP/BetterClaude.zip" "$URL"

say "Unpacking…"
ditto -x -k "$TMP/BetterClaude.zip" "$TMP/unzipped"
[ -d "$TMP/unzipped/$APP" ] || die "The download didn't contain $APP."

if [ "$DEST" = "/Applications" ] && pgrep -x BetterClaude >/dev/null 2>&1; then
  say "Quitting the running BetterClaude…"
  osascript -e 'tell application "BetterClaude" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x BetterClaude >/dev/null 2>&1 || break; sleep 1; done
  pkill -x BetterClaude >/dev/null 2>&1 || true
fi

SUDO=""
if [ ! -w "$DEST" ] || { [ -e "$DEST/$APP" ] && [ ! -w "$DEST/$APP" ]; }; then
  say "Installing to $DEST needs your password."
  SUDO="sudo"
fi

say "Installing to $DEST/$APP…"
$SUDO rm -rf "$DEST/$APP"
$SUDO ditto "$TMP/unzipped/$APP" "$DEST/$APP"
# Belt and braces: nothing fetched by curl is quarantined, but clear it anyway
# in case this Mac's settings add the flag to every new file.
$SUDO xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

if [ "$DEST" = "/Applications" ]; then
  say "BetterClaude $VERSION is installed. Opening it…"
  open "$DEST/$APP"
else
  say "BetterClaude $VERSION is installed in $DEST."
fi
