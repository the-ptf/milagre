#!/usr/bin/env bash
# Build, or reuse from the cache, the Node daemon the GPUI "Milagre.app" ships in Contents/Resources/milagre-daemon,
# so the Preview runs on a Mac without Milagre.app (the client's `DaemonLaunch::bundle`). Prints the bundle's folder.
#
#   scripts/preview-daemon-macos.sh --backend <backend worktree> --version <app version> [--node /path/to/node]
#
# The daemon is the backend's own `experiments/rust-daemon-client/scripts/bundle-node-daemon.sh`, run unchanged on a
# `git archive` of the pinned client commit (check-gpui-live.py CLIENT_COMMIT): package.json, package-lock.json,
# apps/daemon, packages/core, packages/shared and the script itself, in a temporary folder (never in the backend's
# checkout). It packs the three workspaces, installs their production dependencies from the npm cache, copies Node and
# refuses to finish unless node-pty opens a real terminal under that Node.
#
# Cache: target/preview-daemon/<commit8>-<version>-node<version>/ in this crate (ignored by Git; delete it to rebuild).
# A build lands there only when complete (written to a .partial folder, then renamed). About 258 MB each (only this
# Mac's architecture since the client's 901e2fd1; 285 MB before).
#
# Node: the first `node` on PATH unless --node; it must be Node 24+, arm64, and self-contained (linking only system
# libraries, as nodejs.org's and nvm's builds do; Homebrew's links its own dylibs and is refused).
set -euo pipefail

backend="" version="" node="$(command -v node || true)"
while [ $# -gt 0 ]; do
  case "$1" in
    --backend) shift; backend="${1:?--backend needs the backend worktree}" ;;
    --version) shift; version="${1:?--version needs a version}" ;;
    --node) shift; node="${1:?--node needs a path}" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$backend" ] || { echo "--backend is required" >&2; exit 2; }
case "$version" in ""|*[!A-Za-z0-9.+-]*) echo "--version must be a plain version like 0.232.0-beta.31" >&2; exit 2 ;; esac
[ -n "$node" ] && [ -x "$node" ] || { echo "no node executable (pass --node)" >&2; exit 2; }
node="$(cd "$(dirname "$node")" && pwd -P)/$(basename "$node")"
node="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$node")"

nodev="$(env -u ELECTRON_RUN_AS_NODE "$node" -p process.versions.node)"
[ "${nodev%%.*}" -ge 24 ] || { echo "Node 24 or newer is required (node:sqlite); $node is $nodev" >&2; exit 2; }
lipo -archs "$node" | tr ' ' '\n' | grep -qx arm64 || { echo "$node has no arm64 slice" >&2; exit 2; }
foreign="$(otool -L "$node" | tail -n +2 | awk '{print $1}' | grep -v -e '^/System/' -e '^/usr/lib/' || true)"
[ -z "$foreign" ] || { echo "$node links libraries outside the system ($foreign): use a nodejs.org or nvm build" >&2; exit 2; }

crate="$(cd "$(dirname "$0")/.." && pwd)"
check="$crate/daemon-check/scripts/check-gpui-live.py"
commit="$(python3 -c "import importlib.util as u,sys; s=u.spec_from_file_location('c',sys.argv[1]); m=u.module_from_spec(s); s.loader.exec_module(m); print(m.CLIENT_COMMIT)" "$check")"
[ "$(git -C "$backend" rev-parse "$commit^{commit}" 2>/dev/null)" = "$commit" ] || { echo "the backend has no $commit" >&2; exit 1; }
script_path="experiments/rust-daemon-client/scripts/bundle-node-daemon.sh"
git -C "$backend" cat-file -e "$commit:$script_path" || { echo "$commit has no $script_path" >&2; exit 1; }

cache="$crate/target/preview-daemon"
dir="$cache/${commit:0:8}-$version-node$nodev"
if [ -f "$dir/manifest.json" ] && [ -x "$dir/bin/node" ]; then
  echo "==> reusing the daemon cached in $dir" >&2
  echo "$dir"
  exit 0
fi

mkdir -p "$cache"
partial="$dir.partial-$$"
work="$(mktemp -d "${TMPDIR:-/tmp}/milagre-preview-daemon.XXXXXX")"
trap 'rm -rf "$work" "$partial"' EXIT
echo "==> building the daemon from ${commit:0:8} (Milagre $version, Node $nodev) into $dir" >&2
git -C "$backend" archive "$commit" -- package.json package-lock.json apps/daemon packages/core packages/shared "$script_path" \
  | tar -x -C "$work"
# The script finds its repository with `git rev-parse --show-toplevel`: an empty repository at the export's root.
git -C "$work" init -q
PATH="$(dirname "$node"):$PATH" sh "$work/$script_path" "$partial" --version "$version" --node "$node" >&2
[ -f "$partial/manifest.json" ] || { echo "the daemon build wrote no manifest" >&2; exit 1; }
rm -rf "$dir"
mv "$partial" "$dir"
echo "$dir"
