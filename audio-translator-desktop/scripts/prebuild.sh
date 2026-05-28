#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Prebuild: bundling audio tools ==="

# 1. Compile Swift aggregate device helper
echo "[1/3] Compiling create-aggregate-device..."
swiftc -o "$SCRIPT_DIR/create-aggregate-device" "$SCRIPT_DIR/create-aggregate-device.swift"
echo "  -> create-aggregate-device compiled"

# 2. Get SwitchAudioSource binary
echo "[2/3] Getting SwitchAudioSource..."
if [ -f "$SCRIPT_DIR/SwitchAudioSource" ]; then
  echo "  -> SwitchAudioSource already present, skipping"
elif command -v SwitchAudioSource &>/dev/null; then
  # Find the real binary (not the wrapper script)
  REAL=$(grep -oP '(?<=exec ")[^"]+' "$(command -v SwitchAudioSource)" 2>/dev/null || echo "")
  if [ -n "$REAL" ] && [ -f "$REAL" ]; then
    cp "$REAL" "$SCRIPT_DIR/SwitchAudioSource"
    echo "  -> SwitchAudioSource copied from Homebrew"
  else
    cp "$(command -v SwitchAudioSource)" "$SCRIPT_DIR/SwitchAudioSource"
    echo "  -> SwitchAudioSource copied from PATH"
  fi
elif command -v brew &>/dev/null; then
  brew install switchaudio-osx
  REAL=$(grep -oP '(?<=exec ")[^"]+' "$(brew --prefix)/bin/SwitchAudioSource" 2>/dev/null || echo "")
  if [ -n "$REAL" ] && [ -f "$REAL" ]; then
    cp "$REAL" "$SCRIPT_DIR/SwitchAudioSource"
  else
    cp "$(brew --prefix)/Cellar/switchaudio-osx/"*"/SwitchAudioSource" "$SCRIPT_DIR/SwitchAudioSource" 2>/dev/null
  fi
  echo "  -> SwitchAudioSource installed and copied"
else
  echo "  -> Downloading SwitchAudioSource from GitHub..."
  SAS_VERSION="1.2.2"
  SAS_URL="https://github.com/deweller/switchaudio-osx/releases/download/${SAS_VERSION}/SwitchAudioSource.zip"
  curl -L -o /tmp/SwitchAudioSource.zip "$SAS_URL"
  unzip -o /tmp/SwitchAudioSource.zip -d /tmp/sas
  cp /tmp/sas/SwitchAudioSource "$SCRIPT_DIR/SwitchAudioSource"
  rm -rf /tmp/SwitchAudioSource.zip /tmp/sas
  echo "  -> SwitchAudioSource downloaded"
fi
chmod +x "$SCRIPT_DIR/SwitchAudioSource"

# 3. Download BlackHole .pkg
echo "[3/3] Getting BlackHole .pkg..."
BH_PKG="$SCRIPT_DIR/blackhole-2ch.pkg"
if [ -f "$BH_PKG" ]; then
  echo "  -> BlackHole .pkg already present, skipping"
else
  BH_VERSION="0.6.1"
  BH_URL="https://github.com/ExistentialAudio/BlackHole/releases/download/v${BH_VERSION}/BlackHole-2ch-${BH_VERSION}.pkg"
  echo "  -> Downloading from $BH_URL ..."
  curl -L -o "$BH_PKG" "$BH_URL"
  echo "  -> BlackHole .pkg downloaded"
fi

echo "=== Prebuild complete ==="
echo ""
echo "Bundled tools:"
ls -lh "$SCRIPT_DIR/create-aggregate-device" "$SCRIPT_DIR/SwitchAudioSource" "$BH_PKG"
