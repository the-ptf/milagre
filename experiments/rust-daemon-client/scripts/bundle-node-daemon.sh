#!/bin/sh
# Build a self-contained Milagre daemon for a computer without Milagre.app:
#   <out>/bin/node                                   Node 24+ (node:sqlite), copied from --node or PATH
#   <out>/app/node_modules/@milagre/daemon/...       daemon + core + shared and their production deps
#   <out>/manifest.json                              {schema, version, node, entry} for DaemonLaunch::bundle
# Dependencies come from the npm cache (--prefer-offline); install scripts don't run. node-pty ships Node-API
# prebuilds, so the same build works under plain Node. Electron-only native modules (dictation) are not included.
# Usage: bundle-node-daemon.sh <out-dir> --version <app-version> [--node /path/to/node]
set -eu
out=""; version=""; node="$(command -v node || true)"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --node) node="$2"; shift 2 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) out="$1"; shift ;;
  esac
done
[ -n "$out" ] && [ -n "$version" ] || { echo "usage: $0 <out-dir> --version <app-version> [--node path]" >&2; exit 2; }
case "$version" in *[[:space:]/]*|"") echo "invalid version" >&2; exit 2 ;; esac
[ -x "$node" ] || { echo "no node executable" >&2; exit 2; }
major=$(env -u ELECTRON_RUN_AS_NODE "$node" -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "Node 24 or newer is required (node:sqlite); got $major" >&2; exit 2; }
[ ! -e "$out" ] || { echo "$out exists; choose a new directory" >&2; exit 2; }

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
packs=$(mktemp -d)
trap 'rm -rf "$packs"' EXIT
( cd "$root" && npm pack --silent -w apps/daemon -w packages/core -w packages/shared --pack-destination "$packs" >/dev/null )

mkdir -p "$out/bin" "$out/app"
echo '{"name":"milagre-daemon-bundle","private":true}' > "$out/app/package.json"
( cd "$out/app" && env -u ELECTRON_RUN_AS_NODE npm install --omit=dev --ignore-scripts --prefer-offline \
    --no-audit --no-fund --no-package-lock "$packs"/*.tgz >/dev/null )
# Milagre runs the user's installed claude (pathToClaudeCodeExecutable), never the SDK's bundled binary; Milagre.app
# doesn't ship it either. node-pty keeps only its macOS prebuilds.
rm -rf "$out"/app/node_modules/@anthropic-ai/claude-agent-sdk-*-*
# The bundle carries this Mac's Node, so it runs on this architecture only: drop other platforms' binaries.
case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo "unsupported architecture" >&2; exit 2 ;; esac
for dir in "$out"/app/node_modules/node-pty/prebuilds/*; do
  [ "$(basename "$dir")" = "darwin-$arch" ] || rm -rf "$dir"
done
rm -rf "$out"/app/node_modules/node-pty/third_party/conpty
for bin in "$out"/app/node_modules/agent-desktop/bin/agent-desktop-*; do
  case "$(basename "$bin")" in *-darwin-"$arch") ;; *) rm -f "$bin" ;; esac
done
# node-pty's own post-install marks spawn-helper executable; with install scripts off it stays 0644 and every
# terminal fails with "posix_spawnp failed".
chmod 755 "$out"/app/node_modules/node-pty/prebuilds/darwin-"$arch"/spawn-helper
cp "$node" "$out/bin/node"
chmod 755 "$out/bin/node"
entry="app/node_modules/@milagre/daemon/src/cli.cjs"
[ -f "$out/$entry" ] || { echo "daemon entry missing after install" >&2; exit 1; }
# The daemon's one native module must load and open a real pseudo-terminal under this Node.
( cd "$out/app" && env -u ELECTRON_RUN_AS_NODE "$out/bin/node" -e '
const p = require("node-pty").spawn("/bin/sh", ["-c", "echo pty-ok"], { cols: 80, rows: 24 });
let out = ""; p.onData((d) => (out += d));
p.onExit(() => process.exit(out.includes("pty-ok") ? 0 : 1));
setTimeout(() => process.exit(1), 5000);' ) || { echo "node-pty can't open a terminal under this Node" >&2; exit 1; }
nodev=$(env -u ELECTRON_RUN_AS_NODE "$out/bin/node" -p process.version)
printf '{"schema":1,"version":"%s","node":"bin/node","nodeVersion":"%s","entry":"%s"}\n' "$version" "$nodev" "$entry" > "$out/manifest.json"
du -sh "$out" | cut -f1
