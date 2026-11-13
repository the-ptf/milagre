#!/bin/bash
# Live loop for the GPUI port: whenever the branch gets a new commit, rebuild the
# app from a clean export of HEAD, reinstall it and reopen it. A HEAD that does not
# build is skipped and the running app is left alone. Ctrl-C stops the loop.
#   scripts/live-macos.sh            # poll every 5s
#   LIVE_INTERVAL=2 scripts/live-macos.sh
set -u
cd "$(dirname "$0")/.."
interval="${LIVE_INTERVAL:-5}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/agent-release}"
app="$HOME/Applications/Milagre GPUI.app"
last=""
while true; do
  head=$(git rev-parse --short=8 HEAD 2>/dev/null)
  if [ -n "$head" ] && [ "$head" != "$last" ]; then
    echo "[$(date +%H:%M:%S)] building $head"
    if scripts/bundle-macos.sh --install >/tmp/milagre-gpui-live.log 2>&1; then
      open "$app"
      echo "[$(date +%H:%M:%S)] running $head"
    else
      echo "[$(date +%H:%M:%S)] $head did not build; see /tmp/milagre-gpui-live.log"
    fi
    last="$head"
  fi
  sleep "$interval"
done
