#!/usr/bin/env bash
# Package the GPUI port as "Milagre GPUI.app" (macOS only).
#
#   scripts/bundle-macos.sh [--install] [--out DIR]
#
# Builds a release binary from a clean `git archive` of HEAD (uncommitted changes are never in the bundle, and a HEAD
# that does not build fails here), writes the .app, signs it ad hoc, and with --install replaces
# ~/Applications/"Milagre GPUI.app" after quitting a running copy by bundle id.
#
# --out DIR   where the .app is written (default: /tmp/milagre-gpui-bundle)
# Env: CARGO_TARGET_DIR  build cache (default: ~/.cache/milagre-gpui-bundle/target, so deps build once)
set -euo pipefail

BUNDLE_ID="com.milagre.gpui-poc"
APP_NAME="Milagre GPUI.app"
EXEC_NAME="milagre-gpui"
CARGO_BIN="milagre-gpui-spike"

install=0
out="/tmp/milagre-gpui-bundle"
while [ $# -gt 0 ]; do
  case "$1" in
    --install) install=1 ;;
    --out) shift; out="${1:?--out needs a directory}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || { echo "bundle-macos.sh runs on macOS only" >&2; exit 1; }

crate="$(cd "$(dirname "$0")/.." && pwd)"
sha="$(git -C "$crate" rev-parse --short=8 HEAD)"

if [ -n "$(git -C "$crate" status --porcelain -- "$crate" 2>/dev/null)" ]; then
  echo "note: uncommitted changes in the crate are NOT in the bundle (building HEAD $sha)" >&2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/milagre-gpui-pack.XXXXXX")"
trap 'rm -rf "$work"' EXIT
src="$work/src"
mkdir -p "$src"
echo "==> archiving HEAD $sha"
git -C "$crate" archive HEAD -- . | tar -x -C "$src"
[ -f "$src/Cargo.toml" ] || { echo "git archive of HEAD is empty" >&2; exit 1; }

version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$src/Cargo.toml" | head -1)"
[ -n "$version" ] || { echo "no version in Cargo.toml" >&2; exit 1; }

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/milagre-gpui-bundle/target}"
export MILAGRE_GPUI_SHA="$sha"
echo "==> cargo build --release (target $CARGO_TARGET_DIR)"
(cd "$src" && cargo build --release --locked --bin "$CARGO_BIN")
binary="$CARGO_TARGET_DIR/release/$CARGO_BIN"
[ -x "$binary" ] || { echo "build produced no $binary" >&2; exit 1; }

app="$out/$APP_NAME"
echo "==> writing $app ($version, $sha)"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/$EXEC_NAME"
cp "$src/packaging/icon.icns" "$app/Contents/Resources/icon.icns"
sed -e "s/@VERSION@/$version/" -e "s/@SHA@/$sha/" "$src/packaging/Info.plist.in" > "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist" >/dev/null
echo -n "APPL????" > "$app/Contents/PkgInfo"

echo "==> ad-hoc signing"
codesign --force --deep -s - "$app"
codesign --verify --deep --strict "$app"

if [ "$install" = 1 ]; then
  dest="$HOME/Applications"
  running() { osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null | grep -q true; }
  if running; then
    echo "==> quitting running $BUNDLE_ID"
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do running || break; sleep 0.2; done
    if running; then echo "still running after 10 s; quit it and retry" >&2; exit 1; fi
  fi
  mkdir -p "$dest"
  rm -rf "${dest:?}/$APP_NAME"
  ditto "$app" "$dest/$APP_NAME"
  echo "==> installed $dest/$APP_NAME"
fi
echo "done: $app"
