#!/bin/bash
# PersoDub one-command installer (Apple Silicon Macs only)
# Usage:  bash install.sh
# What it does: fetch the code -> install prerequisites (including Node.js)
#               -> build -> install -> launch
set -e

REPO="stronghamjji/PersoDub"
REPO_URL="https://github.com/${REPO}.git"
CODE_DIR="$HOME/00_desktop_app"
MODEL_URL="https://github.com/${REPO}/releases/download/models-v1/campplus.onnx"
MODEL_SHA256="dd1740aa1e1ffa3895f96aef2166b8af2bb2ad09c00769dd275ee36aef6a2a7f"
NODE_VER="v22.12.0"
NODE_DIR="$HOME/.persodub/node"

fail() { echo ""; echo "❌ $1"; echo "   Fix the problem above, then run this script again. (Completed steps are skipped.)"; exit 1; }

echo "=== [1/7] Checking this machine ==="
[ "$(uname -m)" = "arm64" ] || fail "This script is for Apple Silicon (M1-M4) Macs only."
echo "✅ Apple Silicon confirmed"

echo ""
echo "=== [2/7] Getting the code ==="
# If this script is already inside a checked-out copy, use that folder as is
# (e.g. cloned with GitHub Desktop -- any location works).
if [ -f "$0" ]; then
  SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
  [ -f "$SELF_DIR/desktop/package.json" ] && CODE_DIR="$SELF_DIR"
fi
# No git on PATH? Fall back to the one bundled with GitHub Desktop.
GIT_BIN="$(command -v git || true)"
if [ -z "$GIT_BIN" ]; then
  for g in "/Applications/GitHub Desktop.app/Contents/Resources/app/git/bin/git"; do
    [ -x "$g" ] && GIT_BIN="$g" && break
  done
fi
if [ ! -f "$CODE_DIR/desktop/package.json" ]; then
  [ -n "$GIT_BIN" ] || fail "git is required to fetch the code. Install it with:
   xcode-select --install
   (Or clone the repository with the GitHub Desktop app, then run bash install.sh inside that folder.)"
  echo "Cloning the repository from GitHub..."
  "$GIT_BIN" clone "$REPO_URL" "$CODE_DIR" || fail "Could not fetch the code.
   - Check your internet connection.
   - Check that the repository address is reachable: $REPO_URL"
elif [ -d "$CODE_DIR/.git" ] && [ -n "$GIT_BIN" ]; then
  # Update an existing checkout. If that fails (e.g. auth), continue with what we have.
  GIT_TERMINAL_PROMPT=0 "$GIT_BIN" -C "$CODE_DIR" pull 2>/dev/null \
    || echo "⚠️ Skipping code update (continuing with the copy already on disk)"
fi
echo "✅ Code location: $CODE_DIR"

echo ""
echo "=== [3/7] Preparing Node.js (auto-installed if missing) ==="
if ! command -v npm >/dev/null; then
  if [ ! -x "$NODE_DIR/bin/npm" ]; then
    echo "Downloading Node.js (about 45MB, no administrator password needed)..."
    mkdir -p "$NODE_DIR"
    TGZ="/tmp/node-${NODE_VER}-darwin-arm64.tar.gz"
    curl -fL --retry 3 -o "$TGZ" "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-arm64.tar.gz" \
      || fail "Node.js download failed. Check your internet connection."
    ( cd /tmp && curl -fsSL "https://nodejs.org/dist/${NODE_VER}/SHASUMS256.txt" \
        | grep " node-${NODE_VER}-darwin-arm64.tar.gz$" | shasum -a 256 -c - >/dev/null ) \
      || fail "The downloaded Node.js file is corrupted. Try running this script again."
    tar -xzf "$TGZ" -C "$NODE_DIR" --strip-components 1
    rm -f "$TGZ"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi
echo "✅ Node $(node -v) / npm $(npm -v)"

echo ""
echo "=== [4/7] Downloading build dependencies ==="
cd "$CODE_DIR/desktop"
npm install || fail "npm install failed. Check your internet connection."

echo ""
echo "=== [5/7] Preparing the speaker-diarization model (campplus.onnx) ==="
MODEL_DIR="$CODE_DIR/desktop/vendor/models"
MODEL_PATH="$MODEL_DIR/campplus.onnx"
mkdir -p "$MODEL_DIR"
# Reuse an existing verified copy if one is already on this machine.
for c in \
  "$MODEL_PATH" \
  "$HOME/Library/Application Support/persodub-desktop-shell/kit/models/campplus/campplus.onnx" \
  "/Applications/PersoDub.app/Contents/Resources/payload/campplus.onnx"; do
  if [ -f "$c" ]; then
    echo "$MODEL_SHA256  $c" | shasum -a 256 -c - >/dev/null 2>&1 && { MODEL_PATH="$c"; FOUND=1; break; }
  fi
done
if [ -z "$FOUND" ]; then
  echo "Downloading the model (27MB)..."
  if ! curl -fL --retry 3 -o "$MODEL_PATH" "$MODEL_URL" 2>/dev/null; then
    # Fallback: the gh CLI can fetch release assets when plain curl cannot.
    command -v gh >/dev/null && gh release download models-v1 --repo "$REPO" --pattern campplus.onnx --output "$MODEL_PATH" --clobber \
      || fail "Model download failed. Download campplus.onnx manually from
   https://github.com/${REPO}/releases/tag/models-v1
   put it in $MODEL_DIR and run this script again."
  fi
  echo "$MODEL_SHA256  $MODEL_PATH" | shasum -a 256 -c - >/dev/null || fail "The downloaded model file is corrupted. Try running this script again."
fi
echo "✅ Model ready: $MODEL_PATH"

echo ""
echo "=== [6/7] Building the app (keep this window open) ==="
CAMPPLUS_SRC="$MODEL_PATH" npm run dist || fail "Build failed. Please report the error message above as a GitHub issue."
[ -d "dist/mac-arm64/PersoDub.app" ] || fail "Build produced no app. Please report the error message above as a GitHub issue."

echo ""
echo "=== [7/7] Installing into Applications and launching ==="
rm -rf /Applications/PersoDub.app
ditto dist/mac-arm64/PersoDub.app /Applications/PersoDub.app
# A freshly copied app is not registered with LaunchServices yet, so opening it
# by name (open -a) can fail. Register it first, then open it by path.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f /Applications/PersoDub.app >/dev/null 2>&1 || true
open /Applications/PersoDub.app || fail "Could not launch the app. Open Applications > PersoDub in Finder manually."
echo ""
echo "🎉 Installation complete!"
echo " - On first launch the app installs its engines automatically (a progress screen will appear)."
echo " - To enable cloud engines, add your API keys in the app's Settings."
