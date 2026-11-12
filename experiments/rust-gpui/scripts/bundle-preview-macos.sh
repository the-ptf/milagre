#!/usr/bin/env bash
# Package the live GPUI app as "Milagre GPUI Preview.app" (macOS, arm64): the GPUI UI on the installed Milagre's
# running Node daemon by default (its Projects and Chats; never launched, stopped or signalled from here), or with
# --owned / --root on the backend's owned Chat runtime, shipped inside the bundle.
#
#   scripts/bundle-preview-macos.sh --backend <backend worktree> [--out DIR] [--install] [--sha256 <runtime sha>]
#
# Builds `live/` (release, locked) from a clean `git archive` of HEAD plus the shared client exported at its pinned
# commit (daemon-check/scripts/check-gpui-live.py export), then writes:
#
#   Contents/MacOS/milagre-gpui-preview   the live executable
#   Contents/MacOS/chat-runtime           the hash-verified runtime (its fixed sibling; the client looks nowhere else)
#   Contents/Resources/bundled-skills     packages/core/src/bundled-skills at HEAD (the runtime's skill instructions)
#
# The runtime comes only from daemon-check/target/owned-runtime-<sha8>/ (staged and checked by check-gpui-live.py
# stage-runtime); default: the newest agreed one. Its hash is recorded before and after signing in
# Contents/Resources/runtime.json. Ad-hoc signed; scripts/dist-macos.sh re-signs for distribution.
# Owned mode keeps its data in ~/Library/Application Support/Milagre GPUI Preview/ (launch.json + root/), set up on its
# first launch; the default (daemon) mode keeps none and has no setup window. --install replaces ~/Applications/"Milagre GPUI Preview.app" after quitting a running copy by bundle id.
# Env: CARGO_TARGET_DIR  build cache (default: ~/.cache/milagre-gpui-preview/target)
set -euo pipefail

BUNDLE_ID="com.milagre.gpui-preview"
APP_NAME="Milagre GPUI Preview.app"
EXEC_NAME="milagre-gpui-preview"

install=0 out="/tmp/milagre-gpui-preview-bundle" backend="" sha=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) install=1 ;;
    --out) shift; out="${1:?--out needs a directory}" ;;
    --backend) shift; backend="${1:?--backend needs the backend worktree}" ;;
    --sha256) shift; sha="${1:?--sha256 needs a hash}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 1; }
[ -n "$backend" ] || { echo "--backend is required (for the client export)" >&2; exit 2; }

crate="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(git -C "$crate" rev-parse --show-toplevel)"
head="$(git -C "$crate" rev-parse --short=8 HEAD)"
check="$crate/daemon-check/scripts/check-gpui-live.py"
sha="${sha:-$(python3 -c "import importlib.util as u,sys; s=u.spec_from_file_location('c',sys.argv[1]); m=u.module_from_spec(s); s.loader.exec_module(m); print(m.RUNTIME_SHA256)" "$check")}"
runtime="$crate/daemon-check/target/owned-runtime-${sha:0:8}/chat-runtime"
[ -f "$runtime" ] || { echo "no staged runtime $runtime: run check-gpui-live.py stage-runtime first" >&2; exit 1; }
[ "$(shasum -a 256 "$runtime" | cut -d' ' -f1)" = "$sha" ] || { echo "$runtime is not $sha" >&2; exit 1; }
if [ -n "$(git -C "$crate" status --porcelain -- "$crate" 2>/dev/null)" ]; then
  echo "note: uncommitted changes are NOT in the bundle (building HEAD $head)" >&2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/milagre-gpui-preview.XXXXXX")"
trap 'rm -rf "$work"' EXIT
echo "==> archiving HEAD $head"
git -C "$repo" archive HEAD -- experiments/rust-gpui packages/core/src/bundled-skills | tar -x -C "$work"
src="$work/experiments/rust-gpui"
[ -f "$src/live/Cargo.toml" ] || { echo "HEAD has no live/ crate" >&2; exit 1; }
echo "==> exporting the shared client"
python3 "$check" export --backend "$backend" >/dev/null
mkdir -p "$src/target"
cp -R "$crate/target/daemon-client-dd499372" "$src/target/"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/milagre-gpui-preview/target}"
echo "==> cargo build --release (target $CARGO_TARGET_DIR)"
(cd "$src/live" && cargo build --release --locked --bin milagre-gpui-live)
binary="$CARGO_TARGET_DIR/release/milagre-gpui-live"
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$src/live/Cargo.toml" | head -1)"

app="$out/$APP_NAME"
echo "==> writing $app ($version, $head, runtime ${sha:0:8})"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/$EXEC_NAME"
cp "$runtime" "$app/Contents/MacOS/chat-runtime"
chmod 755 "$app/Contents/MacOS/$EXEC_NAME" "$app/Contents/MacOS/chat-runtime"
cp -R "$work/packages/core/src/bundled-skills" "$app/Contents/Resources/bundled-skills"
cp "$src/packaging/icon.icns" "$app/Contents/Resources/icon.icns"
sed -e "s/@VERSION@/$version/" -e "s/@SHA@/$head/" \
    -e "s/com.milagre.gpui-poc/$BUNDLE_ID/" \
    -e "s#<string>milagre-gpui</string>#<string>$EXEC_NAME</string>#" \
    -e "s#<string>Milagre GPUI</string>#<string>Milagre GPUI Preview</string>#g" \
    "$src/packaging/Info.plist.in" > "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist" >/dev/null
echo -n "APPL????" > "$app/Contents/PkgInfo"

echo "==> ad-hoc signing"
codesign --force -s - "$app/Contents/MacOS/chat-runtime"
codesign --force -s - "$app"
codesign --verify --deep --strict "$app"
signed="$(shasum -a 256 "$app/Contents/MacOS/chat-runtime" | cut -d' ' -f1)"
printf '{"runtimeSha256":"%s","signedRuntimeSha256":"%s","gpuiHead":"%s","client":"dd499372"}\n' "$sha" "$signed" "$head" \
  > "$app/Contents/Resources/runtime.json"
# The resource changed after signing the bundle: sign once more so the seal covers it.
codesign --force -s - "$app"
codesign --verify --deep --strict "$app"

if [ "$install" = 1 ]; then
  dest="$HOME/Applications"
  running() { osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null | grep -q true; }
  if running; then
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 100); do running || break; sleep 0.2; done
    if running; then echo "still running after 20 s; quit it and retry" >&2; exit 1; fi
  fi
  mkdir -p "$dest"
  rm -rf "${dest:?}/$APP_NAME"
  ditto "$app" "$dest/$APP_NAME"
  echo "==> installed $dest/$APP_NAME"
fi
echo "done: $app"
