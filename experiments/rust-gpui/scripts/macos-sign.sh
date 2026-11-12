# Inside-out code signing for a macOS .app, sourced by bundle-preview-macos.sh and dist-macos.sh (bash).
#
# The Preview carries nested code beyond its executable: Contents/MacOS/chat-runtime and the Node daemon in
# Contents/Resources/milagre-daemon (bin/node, native modules such as node-pty's pty.node and spawn-helper,
# agent-desktop's and expo-device-hub's helpers, a nested .framework and .app). Each is signed on its own, deepest
# first, nested bundles after the files inside them, and the app last, so `codesign --verify --deep --strict` holds
# and a Developer ID signature reaches every Mach-O (notarization rejects any it does not cover).

# Every Mach-O file under Contents except the main executable, and every nested bundle (.framework, .app, .bundle,
# .xpc), deepest first.
nested_code() {
  local app="$1" main
  main="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
  {
    find "$app/Contents" -type f ! -path "$app/Contents/MacOS/$main" -print0 \
      | xargs -0 file --no-pad -F $'\t' | awk -F'\t' '$2 ~ /Mach-O/ { print $1 }'
    find "$app/Contents" -mindepth 2 -type d \( -name '*.framework' -o -name '*.app' -o -name '*.bundle' -o -name '*.xpc' \)
  } | awk -F/ '{ print NF "\t" $0 }' | sort -t $'\t' -k1,1nr -s | cut -f2-
}

# sign_inside_out <app> <app entitlements or ""> <node entitlements or ""> <codesign command...>
# The Preview's Node (Contents/Resources/milagre-daemon/bin/node) gets the node entitlements, the app its own; every
# other nested item none.
sign_inside_out() {
  local app="$1" app_ent="$2" node_ent="$3" f
  shift 3
  local node="$app/Contents/Resources/milagre-daemon/bin/node"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -n "$node_ent" ] && [ "$f" = "$node" ]; then
      "$@" --entitlements "$node_ent" "$f"
    else
      "$@" "$f"
    fi
  done < <(nested_code "$app")
  if [ -n "$app_ent" ]; then "$@" --entitlements "$app_ent" "$app"; else "$@" "$app"; fi
}
