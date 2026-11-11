# Designs, Artifacts and media in the Rust host

The production React Designs and Artifacts panels stay in use. This module replaces their Electron custom protocols and preview registry, not the panels.

`content::install(builder)` registers `milagre-artifact` and `milagre-media`. `content::invoke` handles preview registration/release. Artifact asset bytes come from the existing daemon (`artifact:asset`), including routing to a paired computer when the Chat key is qualified. Designs document reads, edits, comments and exports continue through their original daemon methods.

Run `node experiments/rust-desktop/build-content.mjs` before Cargo. It embeds the exact shared Artifact document helpers, policy and Pele diagram script from the installed repository dependencies. The generated file is ignored; changing shared helpers and rebuilding updates both versions.

## Isolation

Artifact documents carry the production CSP plus `sandbox allow-scripts` in the response header. Their existing iframe also has `sandbox="allow-scripts"` and no same-origin access. They cannot read the parent UI or invoke its privileged bridge. Remote scripts, network fetches, form submission and object embeds are denied by the shared policy. Preview addresses use 24 random bytes; asset names and hashes are validated and responses are checked against the registered hash.

Tauri 2.12.5 initializes its IPC globals and invoke key only in the main frame. However, registered custom schemes count as local for Tauri's command ACL. `navigation.rs` wraps Wry's existing WebKit delegate to distinguish target frames: main-frame navigation remains restricted to the bundled app URL, while sandboxed Artifact and srcdoc child frames can load. Other callbacks still reach the original Wry delegate. An Artifact never becomes a privileged main webview. Keep the renderer's exact production script hashes. Do not add unsafe-inline to the main app's script policy.

## Bounds and differences

- Same HTML registry limits as Electron: 8 MiB source, 64 MiB combined generated documents, 128 live previews.
- Artifacts use the existing 95 MiB per-file maximum and at most 100 registered files.
- Byte-range requests are supported. Tauri's response API returns a completed byte buffer, unlike Electron's streamed response. Asset chunks are read from the daemon in 1 MiB increments. Ranged responses are capped at 8 MiB and return their actual Content-Range so a player requests the next chunk; whole non-range assets still require a complete buffer because Tauri's URI responder accepts a complete byte body.
- Local media validates both the requested extension and resolved symlink target. Whole non-range media responses above 256 MiB return 413. Open-ended and large byte ranges return bounded 8 MiB 206 chunks, so large videos can continue playback.
- Unknown/missing/replaced artifact assets fail closed with 404. Malformed or unsatisfiable ranges return 416.

## Validation

Six Rust tests cover byte-range boundaries/overflow, reference rewriting (including Unicode), exact helper/CSP placement, remote Chat qualification and real filesystem media range reads with symlink rejection, and bounded open-ended ranges on a sparse file larger than 256 MiB. UI rendering and comments need validation in the integrated real WebKit app; these unit tests do not claim that result.

`capture.rs` uses the actual WKWebView snapshot API, only under `MILAGRE_RUST_SMOKE=1`, and writes `/tmp/milagre-rust-ui.png` with a completion report. The renderer smoke settles finite paused entry animations before capture; the image is not reconstructed or edited. Two navigation policy tests cover main-frame denial and the permitted child-document schemes.

The preview registry is cleared by `content::clear_previews` on trusted main-document reloads. Protocol responses do not grant wildcard CORS access. The real sandbox probe also attempts the raw WebKit IPC handler without an invoke key and requires an explicit native-parser denial; any dispatched command callback fails the probe.
