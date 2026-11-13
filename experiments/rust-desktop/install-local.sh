#!/bin/sh
set -eu
cd "$(dirname "$0")"
node build-renderer.mjs
cargo build --release --locked
app="$HOME/Applications/Milagre Rust.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
# Refuse to overwrite a running binary. Quit only Milagre Rust before reinstalling.
if pgrep -f "^$app/Contents/MacOS/milagre-rust$" >/dev/null; then
  echo 'Quit Milagre Rust before reinstalling.' >&2
  exit 1
fi
cp target/release/milagre-rust "$app/Contents/MacOS/"
cp icon.icns "$app/Contents/Resources/"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --deep --sign - "$app"
echo "$app"
