#!/usr/bin/env bash
# A few real Claude turns through the Milagre GPUI Preview app, on a new dedicated root, for evidence.
# Spends usage on the selected account: run it only with the account owner's go-ahead.
#
#   scripts/live-real.sh --base DIR --account-id ID --config-dir DIR [--account-label L] [--model sonnet]
#                        [--app "…/Milagre GPUI Preview.app"] [--claude PATH]
#
# --base         a NEW folder (it must not exist), outside ~/.milagre and ~/Library/Application Support/Milagre;
#                it gets launch.json (0600), root/ (the dedicated data root) and the two run reports
# --account-id   the Claude account's id as Milagre's account metadata names it (or `default` for ~/.claude)
# --config-dir   that account's signed-in Claude config folder (CLAUDE_CONFIG_DIR); no credential is read here
# --model        fixed for the root (default sonnet)
#
# Run 1 creates the root and sends two turns: a marker reply, then a one-command Bash turn whose approval card is
# answered Allow once. The app quits (stopping the runtime). Run 2 opens the same root again (a new runtime process
# resuming the saved native session) and asks for the first marker back. Three turns in all; no retry. Each run writes
# a JSON report (shown items, receipts, permission answers, errors) and the app's log beside it.
set -euo pipefail

base="" account="" config="" label="Selected Claude account" model="sonnet" claude=""
app="/tmp/milagre-gpui-preview-bundle/Milagre GPUI Preview.app"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) shift; base="${1:?}" ;;
    --account-id) shift; account="${1:?}" ;;
    --config-dir) shift; config="${1:?}" ;;
    --account-label) shift; label="${1:?}" ;;
    --model) shift; model="${1:?}" ;;
    --app) shift; app="${1:?}" ;;
    --claude) shift; claude="${1:?}" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$base" ] && [ -n "$account" ] && [ -n "$config" ] || { echo "--base, --account-id and --config-dir are required" >&2; exit 2; }
[ ! -e "$base" ] || { echo "$base exists: give a new folder" >&2; exit 2; }
[ -d "$config" ] || { echo "$config is not a folder" >&2; exit 2; }
exe="$app/Contents/MacOS/milagre-gpui-preview"
[ -x "$exe" ] || { echo "no app at $app (build it with scripts/bundle-preview-macos.sh)" >&2; exit 2; }
claude="${claude:-$HOME/.local/bin/claude}"
[ -x "$claude" ] || { echo "Claude Code not found at $claude: pass --claude" >&2; exit 2; }

skills="$app/Contents/Resources/bundled-skills"
"$exe" setup --base "$base" --claude "$claude" --config-dir "$config" --account-id "$account" \
  --account-label "$label" --model "$model" --skills "$skills" >/dev/null
marker="GPUI_REAL_$(date +%H%M%S)"
export MILAGRE_GPUI_NO_ACTIVATE=1

echo "==> run 1: create the root, two turns (marker, one approved command)"
"$exe" --root "$base/root" --create "$base/launch.json" \
  --smoke "This is a short transport check. Reply with exactly this text and nothing else: $marker" \
  --smoke "Run the shell command: echo gpui-approval-ok — then reply with its output only." \
  --approve --smoke-report "$base/run1.json" 2> "$base/run1.log" || true
echo "==> run 2: reopen the same root, one turn"
"$exe" --root "$base/root" \
  --smoke "What exact text did you reply with in your first answer in this chat? Reply with only that text." \
  --smoke-report "$base/run2.json" 2> "$base/run2.log" || true

for run in run1 run2; do
  echo "----- $run"
  grep -E '^live: (created|opened|shutdown)' "$base/$run.log" || true
  cat "$base/$run.json" 2>/dev/null || echo "(no report)"
done
echo "marker: $marker"
echo "evidence: $base"
