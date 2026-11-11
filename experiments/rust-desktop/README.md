# Milagre Rust migration

Local integration branch: `poc/rust-tauri-local`. Do not push. Installed development bundle: `~/Applications/Milagre Rust.app`, golden-yellow Milagre blueprint icon, bundle ID `com.milagre.rust-poc`.

## Current implementation

The full existing React UI is compiled from `apps/desktop/app/src/main.tsx`. Sidebar rows, usage bars, filters, Chat, Changes, Canvas, Settings, Designs and Artifacts use their original components, CSS and fonts. The production preload API is adapted at build time; production desktop/mobile files are unchanged.

Rust owns the Tauri window, IPC, persistent daemon socket, preferences overlay, native utilities, media and Artifact preview protocols. The existing Node owner daemon still runs agents and persists data. This is **not yet a completed backend migration or standalone upgrade**. See [BACKEND-MIGRATION.md](BACKEND-MIGRATION.md) for unported domains and completion gates.

Projects, Chats and live events use the same private daemon as installed Milagre. No second writer or host restart is introduced. Preferences initially inherit Electron's `preferences.json`; changes made in Rust go into `~/Library/Application Support/com.milagre.rust-poc/preferences.json` so concurrent clients cannot overwrite each other's files. This overlay is an interim coexistence mechanism, not full bidirectional preference synchronization.

Browser embedding, voice, floating inbox and decorative effects are optional for this migration. Other missing features are tracked as migration work, not automatic exemptions. Keep the installed Milagre available while its owner daemon is still required.

The separate feature-gated [desktop fixture launch checkpoint](FIXTURE-LAUNCH.md) compiles the same renderer against a fresh scripted Rust owner. It is uninstalled and has not yet passed native window/storage validation. It never adopts the installed profile or falls back to the Node owner.

## Build, install and check

1. Install workspace dependencies with `npm ci --ignore-scripts` (Node 24+), and have Rust/macOS build tools installed.
2. Run `./experiments/rust-desktop/install-local.sh`. It builds the production renderer and content helpers, builds Rust with Cargo.lock, then installs/signs the local bundle. Quit only Milagre Rust before replacing its binary.
3. Launch from Finder for ordinary use. Agent-launched copies must use `MILAGRE_BACKGROUND=1`.
4. For read-only UI checks, launch the executable with `MILAGRE_BACKGROUND=1 MILAGRE_RUST_SMOKE=1`. Results go to `/tmp/milagre-rust-smoke.json`, real WKWebView screenshot `/tmp/milagre-rust-ui.png`, capture status `/tmp/milagre-rust-capture.json`. The checks do not send Chats or alter project content. Screenshots contain real user data; do not commit them.
5. Run `cargo test --manifest-path experiments/rust-desktop/Cargo.toml`, `cargo clippy --manifest-path experiments/rust-desktop/Cargo.toml -- -D warnings`, and `node --test experiments/rust-desktop/renderer/*.test.mjs`. The live daemon transport test is opt-in: append `live_owner_reads -- --ignored` to cargo test.

## Research and performance

[Tauri architecture](https://v2.tauri.app/concept/architecture/) and [GitButler](https://github.com/gitbutlerapp/gitbutler) provide references for Rust desktop hosting with an existing web frontend. [Zed GPUI](https://github.com/zed-industries/zed/tree/main/crates/gpui) would require a separate UI rewrite and parity exercise; it is not needed to port the backend.

The earlier 26 MB barebones shell measurement is obsolete for the production-renderer build. No full-app speedup has been established. Compare equivalent Projects/Chats, include WebKit XPC/GPU and the shared daemon separately, run multiple cold/warm startup and idle/streaming/scroll tests, and report medians/ranges. A shell-only comparison cannot estimate gains from removing the Node runtime.

## Ongoing coordination

Milagre heartbeat `f3fd7e41` checks this Chat every 10 minutes for 7 days (created 2026-11-10). Sonnet 5.5 compatibility review runs in registered Worktree `review-rust-desktop-compatibility-migrat-02j0`, Chat `/Users/victor/Code/personal/milagre-ade#10929`, attached by Delegation to parent Chat #10904. Do not count review or heartbeat creation as implementation completion.
