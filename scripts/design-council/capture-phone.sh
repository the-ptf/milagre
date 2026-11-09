#!/usr/bin/env bash
# Captures the design council's fixed set of phone screenshots, light and dark, from the running Milagre debug app.
#
#   scripts/design-council/capture-phone.sh <outDir>
#
# Needs (see README.md): the slim iPhone simulator booted with the debug build installed, and start-services.sh's
# fixture + Metro running. Settings come from /tmp/council/phone-env.txt (override with COUNCIL_ENV).
#
# Every screen starts from a fresh app launch and is reached by route through expo-router (the same routes the
# milagre:// deep links open), then waited on by route name: no taps, no coordinates. So it keeps working while the
# UI changes, as long as the routes and their params stay.
#
# Env: COUNCIL_SCREENS="p01 p03" captures a subset; COUNCIL_THEMES="dark" one theme; COUNCIL_RENDER_WAIT (seconds,
# default 2.5) is the pause after a screen's route settles, for data and animations to land.
set -euo pipefail
out="${1:?usage: capture-phone.sh <outDir>}"
here="$(cd "$(dirname "$0")" && pwd)"
envfile="${COUNCIL_ENV:-/tmp/council/phone-env.txt}"
[ -f "$envfile" ] || { echo "No $envfile: run scripts/design-council/start-services.sh first." >&2; exit 1; }
get() { sed -n "s/^$1=//p" "$envfile" | tail -1; }
UDID="$(get UDID)"
METRO_PORT="$(get METRO_PORT)"
BUNDLE="$(get BUNDLE_ID)"
CONNECTION="$(get CONNECTION)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
SCREENS="${COUNCIL_SCREENS:-p01 p02 p03 p04 p05 p06}"
THEMES="${COUNCIL_THEMES:-light dark}"
RENDER_WAIT="${COUNCIL_RENDER_WAIT:-2.5}"
app() { node "$here/app-eval.cjs" "$METRO_PORT" "$@"; }
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

# --- Preflight: fail fast with the fix, never boot or start anything here.
xcrun simctl list devices booted | grep -q "$UDID" || { echo "Simulator $UDID is not booted. See README.md (simslim boot + verify)." >&2; exit 1; }
if ! simslim verify "$UDID" --except widgets,icloud,web >/dev/null 2>&1; then
  echo "Simulator $UDID is not slim. Run: simslim on $UDID --except widgets,icloud,web" >&2
  exit 1
fi
xcrun simctl get_app_container "$UDID" "$BUNDLE" >/dev/null 2>&1 || { echo "$BUNDLE is not installed on $UDID. See README.md (build)." >&2; exit 1; }
curl -fsS "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null | grep -q running || { echo "Metro is not running on $METRO_PORT. Run start-services.sh." >&2; exit 1; }
[ -f "$CONNECTION" ] || { echo "No fixture connection file $CONNECTION. Run start-services.sh." >&2; exit 1; }
FIXTURE_URL="$(node -p "require('$CONNECTION').url")"
curl -s -o /dev/null "$FIXTURE_URL" || { echo "Fixture host $FIXTURE_URL is not answering. Run start-services.sh." >&2; exit 1; }

PROJECT="$(node -p "require('$CONNECTION').project")"
TOKEN="$(node -p "require('$CONNECTION').token")"
MAIN="$(node -p "require('$CONNECTION').mainChatId")"
WORKTREE="$(node -p "require('$CONNECTION').worktreeId")"
PROVIDER="$(node -p "require('$CONNECTION').mainProvider")"
MODEL="$(node -p "require('$CONNECTION').mainModel")"
enc() { node -p 'encodeURIComponent(process.argv[1])' "$1"; }
P="$(enc "$PROJECT")"
CHAT_KEY="$(enc "$PROJECT#$MAIN")"
mkdir -p "$out"

xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 >/dev/null

# A fresh launch: the app reopens its one paired computer (the fixture), may restore the last Chat, then holds still.
# A phone not paired yet (first run, or after an erase) stays on Computers ("index"): pair it through the same /pair
# route the QR code's milagre://pair link opens.
launch() {
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null
  local route
  route="$(app settle index,projects,chat)"
  case "$route" in
    *'"name":"index"'*)
      app replace "/pair?address=$(enc "$FIXTURE_URL")&token=$TOKEN&name=$(enc "Design Council Mac")" >/dev/null
      app settle projects,chat >/dev/null
      ;;
  esac
  app quiet >/dev/null
}

# Each screen: how to reach it, and the route name that proves it is showing.
go() {
  case "$1" in
    p01) app replace "/projects" >/dev/null; app settle projects ;;
    p02) app replace "/chat?id=$MAIN&projectPath=$P" >/dev/null; app settle chat ;;
    p03)
      app replace "/chat?id=$MAIN&projectPath=$P" >/dev/null
      app settle chat >/dev/null
      sleep 1
      app push "/model-sheet?chatId=$CHAT_KEY&provider=$PROVIDER&model=$MODEL&on=$PROVIDER" >/dev/null
      app settle model-sheet
      ;;
    p04) app replace "/projects" >/dev/null; app settle projects >/dev/null; app push "/settings" >/dev/null; app settle settings ;;
    p05)
      app replace "/chat?id=$MAIN&projectPath=$P" >/dev/null
      app settle chat >/dev/null
      app push "/changes?worktreeId=$WORKTREE" >/dev/null
      app settle changes
      ;;
    p06) app replace "/chat?worktreeId=$WORKTREE&projectPath=$P" >/dev/null; app settle chat ;;
    *) echo "Unknown screen $1" >&2; return 1 ;;
  esac
}
name_of() {
  case "$1" in
    p01) echo chats ;; p02) echo chat ;; p03) echo model-picker ;; p04) echo settings ;; p05) echo changes ;; p06) echo new-chat ;;
  esac
}

start=$(date +%s)
# Warm-up: pair if needed and open the main Chat once. The Chats list switches from per-Project groups to One list
# once the phone has a last Chat, so without this the very first p01 of a fresh install would differ from the rest.
launch
app replace "/chat?id=$MAIN&projectPath=$P" >/dev/null
app settle chat >/dev/null
for theme in $THEMES; do
  xcrun simctl ui "$UDID" appearance "$theme"
  for screen in $SCREENS; do
    file="$out/$screen-$(name_of "$screen")-$theme.png"
    launch
    route="$(go "$screen")"
    sleep "$RENDER_WAIT"
    app quiet >/dev/null
    xcrun simctl io "$UDID" screenshot --type=png "$file" >/dev/null 2>&1
    log "$(basename "$file")  $route"
  done
done
xcrun simctl ui "$UDID" appearance light
log "Captured into $out in $(( $(date +%s) - start ))s"
