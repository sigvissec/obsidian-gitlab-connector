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
# Kill any existing emulator instance and wait for it to fully exit.
#
# `adb emu kill` asks the emulator to shut down cleanly, which includes
# saving its snapshot — that can take 15+ seconds. Starting a new emulator
# before the old one releases the AVD lock produces a FATAL
# "Running multiple emulators with the same AVD" error, so we poll until
# both ADB and the qemu process are gone (or force-kill after a timeout).
# ---------------------------------------------------------------------------
EXISTING=$("$ADB" devices 2>/dev/null | awk '/emulator-/{print $1}')
if [[ -n "$EXISTING" ]]; then
  echo "Killing existing emulator: $EXISTING"
  for SER in $EXISTING; do
    "$ADB" -s "$SER" emu kill 2>/dev/null || true
  done
fi

echo -n "Waiting for emulator to exit"
SHUTDOWN_TIMEOUT=45
SHUTDOWN_ELAPSED=0
while [[ $SHUTDOWN_ELAPSED -lt $SHUTDOWN_TIMEOUT ]]; do
  STILL_LISTED=$("$ADB" devices 2>/dev/null | awk '/emulator-/{print}' || true)
  STILL_RUNNING=$(pgrep -f "qemu-system.*avd\|emulator.*-avd" 2>/dev/null || true)
  if [[ -z "$STILL_LISTED" && -z "$STILL_RUNNING" ]]; then
    break
  fi
  sleep 2
  SHUTDOWN_ELAPSED=$((SHUTDOWN_ELAPSED + 2))
  echo -n "."
done
echo ""

# Force-kill anything that refused to exit cleanly (stale process
# holding the AVD lock). Harmless if nothing matches.
if pgrep -f "qemu-system.*avd\|emulator.*-avd" &>/dev/null; then
  echo "Force-killing lingering emulator process(es)..."
  pkill -KILL -f "qemu-system.*avd\|emulator.*-avd" 2>/dev/null || true
  sleep 2
fi

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
#
# A cold-boot Pixel_10 on modest hardware can take well over a minute to
# report sys.boot_completed=1, especially after the previous emulator
# saved a fresh snapshot. 180 seconds is comfortable for that path while
# still failing fast if the emulator is truly stuck.
# ---------------------------------------------------------------------------
echo -n "Waiting for device"
TIMEOUT=180
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

# Give Android's PackageManager and runtime services time to finish
# initializing after sys.boot_completed=1 — otherwise Appium may fail to
# launch Obsidian. Poll for PackageManager readiness instead of a fixed
# sleep so we wait just as long as needed.
echo "Waiting for Android to settle..."
SETTLE_TIMEOUT=60
SETTLE_ELAPSED=0
while [[ $SETTLE_ELAPSED -lt $SETTLE_TIMEOUT ]]; do
  # PackageManager is ready once the boot animation is stopped AND
  # pm list packages can actually respond. These are common signals Appium
  # itself relies on before installing/launching the target app.
  BOOT_ANIM=$("$ADB" -s "$SERIAL" shell getprop init.svc.bootanim 2>/dev/null | tr -d '\r' || true)
  if [[ "$BOOT_ANIM" == "stopped" ]] && \
     "$ADB" -s "$SERIAL" shell pm list packages android &>/dev/null; then
    sleep 3
    break
  fi
  sleep 2
  SETTLE_ELAPSED=$((SETTLE_ELAPSED + 2))
done

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
