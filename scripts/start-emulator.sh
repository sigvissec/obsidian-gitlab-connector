#!/usr/bin/env bash
# Start the Pixel_10 Android emulator, build the plugin, install it into
# Obsidian, and leave Obsidian open for manual testing.
#
# Android Studio will detect the running emulator automatically via the gRPC
# advertisement file written to /run/user/$UID/avd/running/.
#
# Usage: ./scripts/start-emulator.sh [AVD_NAME]
#   AVD_NAME defaults to Pixel_10.

set -euo pipefail

AVD="${1:-Pixel_10}"

# ---------------------------------------------------------------------------
# Resolve SDK paths
# ---------------------------------------------------------------------------
ANDROID_SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
EMULATOR="$ANDROID_SDK/emulator/emulator"
ADB="$ANDROID_SDK/platform-tools/adb"

if [[ ! -x "$EMULATOR" ]]; then
  echo "ERROR: emulator not found at $EMULATOR"
  echo "Set ANDROID_HOME or install Android SDK."
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate AVD
# ---------------------------------------------------------------------------
if ! "$EMULATOR" -list-avds 2>/dev/null | grep -qx "$AVD"; then
  echo "ERROR: AVD '$AVD' not found. Available AVDs:"
  "$EMULATOR" -list-avds 2>/dev/null
  exit 1
fi

# ---------------------------------------------------------------------------
# Kill any existing emulator instance
# ---------------------------------------------------------------------------
EXISTING=$("$ADB" devices 2>/dev/null | awk '/emulator-/{print $1}')
if [[ -n "$EXISTING" ]]; then
  echo "Killing existing emulator: $EXISTING"
  for SER in $EXISTING; do
    "$ADB" -s "$SER" emu kill 2>/dev/null || true
  done
fi

# Also kill by process name to catch emulators that are offline/unresponsive to ADB.
pkill -f "qemu-system.*avd\|emulator.*-avd" 2>/dev/null || true

# Reset ADB so it has a clean slate.
"$ADB" kill-server 2>/dev/null || true
sleep 2
"$ADB" start-server &>/dev/null

# ---------------------------------------------------------------------------
# Build the plugin so the latest main.js is ready to install
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Building plugin..."
(cd "$PROJECT_DIR" && npm run build 2>&1) || {
  echo "ERROR: Plugin build failed."
  exit 1
}

# ---------------------------------------------------------------------------
# Start emulator (with window, so it is visible in Android Studio)
# ---------------------------------------------------------------------------
"$ADB" start-server &>/dev/null

echo "Starting AVD: $AVD"
"$EMULATOR" -avd "$AVD" -no-audio >"$PROJECT_DIR/tmp/emulator-$AVD.log" 2>&1 &
EMU_PID=$!
echo "Emulator PID: $EMU_PID  (log: $PROJECT_DIR/tmp/emulator-$AVD.log)"

# ---------------------------------------------------------------------------
# Wait for full boot
# ---------------------------------------------------------------------------
echo -n "Waiting for device"
TIMEOUT=60
ELAPSED=0
SERIAL=""
BOOTED=""

# Disable pipefail inside the poll loop — adb pipelines can produce spurious
# SIGPIPE / non-zero exits while the emulator is in the "offline" transient state.
set +o pipefail
while [[ $ELAPSED -lt $TIMEOUT ]]; do
  # Match only lines where ADB reports state "device" (not "offline"/"unauthorized")
  SERIAL=$("$ADB" devices 2>/dev/null | awk '$1~/^emulator-/ && $2=="device"{print $1; exit}')
  if [[ -n "$SERIAL" ]]; then
    BOOTED=$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
    [[ "$BOOTED" == "1" ]] && break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
  echo -n "."
done
set -o pipefail
echo ""

if [[ -z "$SERIAL" || "$BOOTED" != "1" ]]; then
  echo "ERROR: Emulator did not become ready within ${TIMEOUT}s."
  echo "Check $PROJECT_DIR/tmp/emulator-$AVD.log for details."
  kill "$EMU_PID" 2>/dev/null || true
  exit 1
fi

ANDROID_VER=$("$ADB" -s "$SERIAL" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
ANDROID_API=$("$ADB" -s "$SERIAL" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
echo "Device ready: $SERIAL (Android $ANDROID_VER, API $ANDROID_API)"

# Give Android's PackageManager a few seconds to finish initializing after
# sys.boot_completed=1 — otherwise Appium may fail to launch Obsidian.
echo "Waiting for Android to settle..."
sleep 8

# ---------------------------------------------------------------------------
# Install plugin into Obsidian via wdio-obsidian-service
# ---------------------------------------------------------------------------
echo ""
echo "Installing plugin into Obsidian..."
(cd "$PROJECT_DIR" && npx wdio run ./wdio.manual-setup.conf.mts 2>&1) && SETUP_OK=1 || SETUP_OK=0

if [[ $SETUP_OK -eq 0 ]]; then
  echo ""
  echo "WARNING: Automatic plugin install failed (Obsidian may need manual setup)."
  echo "You can still use the emulator — open Obsidian and install the plugin manually."
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Obsidian is running on $SERIAL with the gitlab-connector plugin installed."
echo ""
echo "Android Studio: open Device Manager — the emulator should appear automatically."
echo ""
echo "When finished:  adb emu kill"
