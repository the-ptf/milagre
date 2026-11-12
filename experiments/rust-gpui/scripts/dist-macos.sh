#!/usr/bin/env bash
# Make a distributable zip from a built "Milagre GPUI.app" (macOS only).
#
#   scripts/dist-macos.sh --app <path.app> --out <dir> [--extra-binary <path>] [--cert <devid.cer>]
#
# Ad hoc mode (no --cert): signs ad hoc, zips, writes OPEN-ME-FIRST.txt beside the zip.
# Developer ID mode (--cert): imports ~/.private_keys/gpui-devid/devid.key + the .cer into a dedicated keychain,
# signs with the hardened runtime, notarizes with the App Store Connect key from ~/.private_keys/asc.env, staples, re-zips.
# Both modes sign inside out (scripts/macos-sign.sh): every nested Mach-O (the Preview's chat-runtime and its bundled
# Node daemon: bin/node, .node modules, .dylib, spawn-helper and other helpers) and nested bundle, deepest first, then
# the app. With --cert the daemon's Node gets packaging/node-entitlements.plist (JIT for V8), the app
# packaging/entitlements.plist, everything else none.
# Key material and the asc.env values are read at run time only and never printed.
#
# --no-notarize         Developer ID mode only: sign and verify, skip notarize/staple (dry runs).
# --extra-binary <path>  copied into Contents/MacOS/ (as its own name) before signing; repeatable.
set -euo pipefail

app="" out="" cert="" notarize=1
extras=()
while [ $# -gt 0 ]; do
  case "$1" in
    --app) shift; app="${1:?--app needs a path}" ;;
    --out) shift; out="${1:?--out needs a directory}" ;;
    --cert) shift; cert="${1:?--cert needs a .cer path}" ;;
    --no-notarize) notarize=0 ;;
    --extra-binary) shift; extras+=("${1:?--extra-binary needs a path}") ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = "Darwin" ] || { echo "dist-macos.sh runs on macOS only" >&2; exit 1; }
[ -d "$app" ] || { echo "--app must be an existing .app" >&2; exit 2; }
[ -n "$out" ] || { echo "--out is required" >&2; exit 2; }

crate="$(cd "$(dirname "$0")/.." && pwd)"
ent="$crate/packaging/entitlements.plist"
node_ent="$crate/packaging/node-entitlements.plist"
# shellcheck source=macos-sign.sh
. "$crate/scripts/macos-sign.sh"
keydir="${GPUI_DEVID_DIR:-$HOME/.private_keys/gpui-devid}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
app="$(cd "$(dirname "$app")" && pwd)/$(basename "$app")"
name="$(basename "$app" .app)"
zip="$out/${name// /-}.zip"

# Work on a copy so the input bundle stays as built.
work="$(mktemp -d "${TMPDIR:-/tmp}/milagre-gpui-dist.XXXXXX")"
trap 'rm -rf "$work"' EXIT
stage="$work/$(basename "$app")"
ditto "$app" "$stage"

for b in ${extras[@]+"${extras[@]}"}; do
  [ -f "$b" ] || { echo "--extra-binary not found: $b" >&2; exit 2; }
  cp "$b" "$stage/Contents/MacOS/$(basename "$b")"
  chmod 755 "$stage/Contents/MacOS/$(basename "$b")"
  echo "==> added $(basename "$b") to Contents/MacOS"
done

zip_app() { rm -f "$zip"; ditto -c -k --keepParent "$stage" "$zip"; }

if [ -z "$cert" ]; then
  echo "==> ad-hoc signing"
  sign_inside_out "$stage" "" "" codesign --force -s -
  codesign --verify --deep --strict "$stage"
  zip_app
  cat > "$out/OPEN-ME-FIRST.txt" <<TXT
$name is signed ad hoc, not notarized, so macOS Gatekeeper blocks it the first time.

1. Unzip and drag "$name.app" into /Applications.
2. Open Terminal and run this once:

     xattr -dr com.apple.quarantine "/Applications/$name.app"

   Then open the app normally.

Without Terminal: try to open the app, then go to System Settings > Privacy & Security,
scroll to the message about "$name" and click Open Anyway.
TXT
  echo "done (ad hoc): $zip"
  exit 0
fi

# ---------------------------------------------------------------- Developer ID
[ -f "$cert" ] || { echo "--cert not found: $cert" >&2; exit 2; }
[ -f "$keydir/devid.key" ] || { echo "missing $keydir/devid.key" >&2; exit 1; }
asc_env="${GPUI_ASC_ENV:-$HOME/.private_keys/asc.env}"
[ "$notarize" = 0 ] || [ -f "$asc_env" ] || { echo "missing $asc_env" >&2; exit 1; }

kc="${GPUI_KEYCHAIN:-$keydir/gpui-signing.keychain-db}"
kcpw="${kc%.keychain-db}.password"
umask 077
if [ ! -f "$kcpw" ]; then openssl rand -base64 24 | tr -d '\n' > "$kcpw"; chmod 600 "$kcpw"; fi
pw="$(cat "$kcpw")"
[ -f "$kc" ] || security create-keychain -p "$pw" "$kc"
security set-keychain-settings -t 3600 "$kc"
security unlock-keychain -p "$pw" "$kc"

# Convert the DER .cer to PEM if needed, then import cert and private key.
certpem="$work/cert.pem"
if grep -q 'BEGIN CERTIFICATE' "$cert"; then cp "$cert" "$certpem"; else openssl x509 -inform DER -in "$cert" -out "$certpem"; fi
security import "$certpem" -k "$kc" -T /usr/bin/codesign >/dev/null 2>&1 || true
security import "$keydir/devid.key" -k "$kc" -T /usr/bin/codesign >/dev/null 2>&1 || true
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pw" "$kc" >/dev/null

# Put the keychain first in the search list (keeping the existing ones).
existing="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
# shellcheck disable=SC2086
if ! echo "$existing" | grep -qxF "$kc"; then
  security list-keychains -d user -s "$kc" $(echo "$existing" | tr '\n' ' ')
fi

line="$(security find-identity -p codesigning "$kc" | grep 'Developer ID Application:' | head -1 || true)"
identity="$(printf '%s' "$line" | awk '{print $2}')"
[ -n "$identity" ] || { echo "no Developer ID Application identity in $kc (cert and key must match the CSR)" >&2; exit 1; }
echo "==> signing as: $(printf '%s' "$line" | sed -e 's/^[^"]*"//' -e 's/".*$//')"

sign_inside_out "$stage" "$ent" "$node_ent" codesign --force --options runtime --timestamp --keychain "$kc" -s "$identity"
codesign --verify --deep --strict "$stage"
spctl -a -vv -t exec "$stage" 2>&1 | head -3 || true

if [ "$notarize" = 0 ]; then zip_app; echo "done (Developer ID signed, NOT notarized): $zip"; exit 0; fi
echo "==> notarizing"
zip_app
# shellcheck disable=SC1090
set -a; . "$asc_env"; set +a
result="$(xcrun notarytool submit "$zip" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait --output-format json)"
status="$(printf '%s' "$result" | plutil -extract status raw -o - - 2>/dev/null || echo unknown)"
echo "notarization status: $status"
[ "$status" = "Accepted" ] || { echo "not accepted; run notarytool log with the submission id" >&2; exit 1; }
xcrun stapler staple "$stage"
zip_app
spctl -a -vv -t exec "$stage" 2>&1 | head -3 || true
echo "done (Developer ID, notarized, stapled): $zip"
