#!/usr/bin/env bash
# Starts (or restarts) the two processes the phone capture needs, detached, and records them in /tmp/council/phone-env.txt:
#   - the fixture host (scripts/design-council/fixture.cjs) on 127.0.0.1:$COUNCIL_FIXTURE_PORT (8901)
#   - Metro for apps/mobile on $COUNCIL_METRO_PORT (8899), serving the worktree's JS to the installed debug build
#
#   scripts/design-council/start-services.sh            # start whatever is not running
#   scripts/design-council/start-services.sh --restart  # restart both (only processes this script started: PIDs from the env file)
#   scripts/design-council/start-services.sh --metro    # restart Metro only, with --clear (pick up UI edits Metro missed)
#
# It never touches a process it did not start: it only kills PIDs it wrote itself, and refuses ports someone else holds.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
state=/tmp/council
envfile="$state/phone-env.txt"
mkdir -p "$state"
FIXTURE_PORT="${COUNCIL_FIXTURE_PORT:-8901}"
METRO_PORT="${COUNCIL_METRO_PORT:-8899}"
UDID="${COUNCIL_UDID:-F9224DDB-068D-4097-9DBC-0199CCBE07C0}"
FIXTURE_ROOT="${COUNCIL_FIXTURE_ROOT:-$state/fixture}"

restart_fixture=0
restart_metro=0
case "${1:-}" in
  --restart) restart_fixture=1; restart_metro=1 ;;
  --metro) restart_metro=1 ;;
  "") ;;
  *) echo "usage: $0 [--restart|--metro]" >&2; exit 2 ;;
esac

read_var() { [ -f "$envfile" ] && sed -n "s/^$1=//p" "$envfile" | tail -1 || true; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
# Stops one of our own processes (and its children), by the PID this script recorded.
stop_own() {
  local pid="$1"
  alive "$pid" || return 0
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do alive "$pid" || return 0; sleep 0.1; done
  kill -KILL "$pid" 2>/dev/null || true
}

FIXTURE_PID="$(read_var FIXTURE_PID)"
METRO_PID="$(read_var METRO_PID)"

if [ "$restart_fixture" = 1 ]; then stop_own "$FIXTURE_PID"; FIXTURE_PID=""; fi
if [ "$restart_metro" = 1 ]; then stop_own "$METRO_PID"; METRO_PID=""; fi

if ! alive "$FIXTURE_PID"; then
  holder="$(listening "$FIXTURE_PORT")"
  if [ -n "$holder" ]; then echo "Port $FIXTURE_PORT is held by PID $holder, which this script did not start." >&2; exit 1; fi
  rm -f "$FIXTURE_ROOT/connection.json"
  COUNCIL_FIXTURE_PORT="$FIXTURE_PORT" COUNCIL_FIXTURE_ROOT="$FIXTURE_ROOT" \
    nohup node "$here/fixture.cjs" >"$state/fixture.log" 2>&1 </dev/null &
  FIXTURE_PID=$!
  for _ in $(seq 1 300); do [ -f "$FIXTURE_ROOT/connection.json" ] && break; alive "$FIXTURE_PID" || break; sleep 0.2; done
  [ -f "$FIXTURE_ROOT/connection.json" ] || { echo "Fixture did not start:" >&2; cat "$state/fixture.log" >&2; exit 1; }
  echo "Fixture up: PID $FIXTURE_PID on $FIXTURE_PORT"
fi
URL="$(node -p "require('$FIXTURE_ROOT/connection.json').url")"

if ! alive "$METRO_PID"; then
  holder="$(listening "$METRO_PORT")"
  if [ -n "$holder" ]; then echo "Port $METRO_PORT is held by PID $holder, which this script did not start." >&2; exit 1; fi
  clear=()
  if [ "$restart_metro" = 1 ]; then clear=(--clear); fi
  # Run the worktree's own Expo CLI (npx expo may resolve the main checkout's). No CI=1, so Metro watches files.
  # One simple background command, so $! is Metro's own PID and nothing else holds this script's stdout.
  pushd "$repo/apps/mobile" >/dev/null
  # Not EXPO_PUBLIC_DEMO: demo mode adds a "Demo agent" caption, names the Mac "Demo host" and skips reading the
  # host's models. capture-phone.sh pairs the app with the fixture through the /pair route instead, like a QR scan.
  EXPO_NO_TELEMETRY=1 \
    DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
    nohup node --dns-result-order=ipv4first "$repo/node_modules/expo/bin/cli" start \
    --port "$METRO_PORT" --dev-client --localhost ${clear[@]+"${clear[@]}"} >"$state/metro.log" 2>&1 </dev/null &
  METRO_PID=$!
  popd >/dev/null
  for _ in $(seq 1 300); do curl -fsS "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null | grep -q running && break; sleep 0.2; done
  curl -fsS "http://127.0.0.1:$METRO_PORT/status" | grep -q running || { echo "Metro did not start:" >&2; tail -40 "$state/metro.log" >&2; exit 1; }
  echo "Metro up: PID $METRO_PID on $METRO_PORT"
fi

cat >"$envfile" <<EOF
# Design council phone harness. Written by scripts/design-council/start-services.sh; read by capture-phone.sh.
UDID=$UDID
SIMULATOR=iPhone 17 (slim: simslim --except widgets,icloud,web)
BUNDLE_ID=com.victorlucas.milagre
METRO_PORT=$METRO_PORT
METRO_PID=$METRO_PID
METRO_LOG=$state/metro.log
FIXTURE_PORT=$FIXTURE_PORT
FIXTURE_PID=$FIXTURE_PID
FIXTURE_URL=$URL
FIXTURE_ROOT=$FIXTURE_ROOT
FIXTURE_LOG=$state/fixture.log
CONNECTION=$FIXTURE_ROOT/connection.json
EOF
echo "Wrote $envfile"
