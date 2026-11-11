# Isolated desktop fixture launch checkpoint

This feature compiles a separate `milagre-rust-fixture` executable and `com.milagre.rust-fixture` Tauri configuration. The default `milagre-rust` executable, its production endpoint discovery and installed application stay unchanged. No window was launched or app installed for this checkpoint. The production React renderer is reused from the existing `dist` build; this is not a second UI implementation.

## Authority and storage

`LaunchContext::spawn_fixed()` takes no arguments. It resolves only `app-fixture` beside the current shell executable, refuses symlinks/non-owned/group-or-world-writable executables, and starts that fixed child with inherited stdin/stdout pipes. It uses `env_clear`, a fixed system PATH, and private HOME/XDG/config/cache/temp paths under a new mode-0700 `/tmp` shell directory. This is configuration separation, not an OS sandbox or an executable signature check.

The daemon owns its separate generated profile. The shell reads only the bounded 4096-byte receipt from that exact child's pipe, with a five-second deadline. It checks versions, fixture/Gated flags, `Child.id`, UID, canonical generated profile/Project containment, the profile-derived socket hash, and all four device/inode/mode/UID/type records. Directory and socket identities are rechecked on every connection. macOS `getpeereid` and `LOCAL_PEERPID` verify the connected peer belongs to the same UID and exact child PID. The parser and endpoint are private; there is no arbitrary endpoint, existing profile, executable or environment input. A missing, changed or exited child never falls back to the installed host.

The shell owns its own lock, preferences, window-state and smoke directories. Preferences start empty and never read Electron or installed Rust preferences. Only the existing Milagre preference namespace and string/null values are accepted, with a 1 MiB aggregate limit. Window position/size are written under the shell root on close. Fresh launches do not restore a previous fixture. Smoke capture is explicitly unsupported rather than using the production global paths. No ContentOwner or content-root grant exists in this composition; paths from the receipt do not authorize Artifact/media filesystem reads.

The fixture transport uses the ordinary renderer command allowlist, paging and state hydration, with one explicit handshake difference: absence of `computer-management-v1` does not mark this known limited fixture as an outdated installed host. It never advertises that capability. Unsupported owner/native calls still fail. Native shell support is deliberately small: private preferences, version/launch arguments, connection state, window drag/maximize/background, compiled shortcuts, exact-Project open and Quit. Native dialogs/editors/notifications/browser/content/account helpers remain unavailable. First-window onboarding/model selection and the complete renderer startup call set remain unverified.

## WebKit source evidence

The locked local dependencies provide this exact path:

1. Tauri **2.12.5**, `src/webview/webview_window.rs`: `incognito(true)` sets the underlying WebviewBuilder flag.
2. tauri-runtime-wry **2.12.3**, `src/lib.rs`: forwards `webview_attributes.incognito` to Wry `with_incognito`.
3. Wry **0.57.2**, `src/wkwebview/mod.rs`: `(true, _, _)` selects `WKWebsiteDataStore::nonPersistentDataStore`, then assigns it to the new WKWebViewConfiguration. A supplied existing configuration could bypass this branch; this shell supplies none.

The fixture builder explicitly sets `incognito(true)` and creates no persistent custom data-store identifier. After construction, a native `with_webview` callback checks `configuration().websiteDataStore().isPersistent()`. A persistent result prevents showing the window and requests orderly owner shutdown. A distinct Tauri identifier alone is not the storage guarantee, and `data_directory` is not used as a macOS WebKit isolation claim.

This establishes the compiled source route, not observed native behavior. Still required before any installation or isolation claim: launch a real fixture WKWebView, record `isPersistent == false`, exercise cookies/localStorage/outbox, compare installed Rust/Electron storage before and after, verify no persistent fixture WebsiteData directory is used, and verify native window/store destruction order. WebKit network/cache internals and OS preferences are not an OS sandbox.

## Quit and crash behavior

The shell retains the exact Child and stdin while the window is alive. Close, Quit and ExitRequested are intercepted. Quit runs off the UI thread, sends `daemon:stop` over a separately authenticated endpoint and accepts only the matching `{stopping:true}` result. It then waits up to three seconds for a successful child exit after the daemon's `Server::finish`. A pending/refused response or incomplete exit retains all authority and storage, prevents window exit, emits `app:quit-blocked`, and changes the fixture title to describe the retry path. Repeated Quit is supported. The existing isolated runtime itself interrupts synthetic turns during shutdown; the shell adds no force flag or production suspend/resume policy.

A crash, missing acknowledgement or unsuccessful exit is never classified clean. Startup/build failure and forced LaunchContext drop are explicit crash boundaries: they kill only the retained child handle and reap on a background worker while retaining its private shell HOME. An unknown wait outcome retains that storage instead of reporting cleanup or retrying a possibly reused PID. SIGKILL can leave the daemon's generated profile behind; the shell does not adopt/delete it or claim graceful durability. Real native window-release ordering and process teardown under app startup failures still need a window-based check.

## Headless checks

Build the fixed sibling crate artifact first when running the fixture tests:

```sh
cargo build --manifest-path experiments/rust-runtime/Cargo.toml --features app-fixture --bin app-fixture
cargo test --manifest-path experiments/rust-desktop/Cargo.toml --features app-fixture --bin milagre-rust-fixture
cargo test --manifest-path experiments/rust-desktop/Cargo.toml --no-default-features --bin milagre-rust
cargo clippy --manifest-path experiments/rust-desktop/Cargo.toml --features app-fixture --all-targets -- -D warnings
```

The test-only child path is a fixed sibling crate target path, not a configurable executable. Tests spawn fresh in-process scripted Rust owners only. They prove receipt bounds/deadline/EOF, real peer-PID rejection, replaced socket rejection, private preference storage, busy quit refusal with a reachable owner, Stop/watchdog/retry, acknowledgement plus successful process exit/profile cleanup, and crash never becoming clean. The ordinary desktop transport also completes its real handshake/current-Project/runs calls against that owned child without claiming computer management. The live installed-host test remains ignored.

This checkpoint deliberately does not run the fixture shell binary, copy a sibling executable into an app bundle, rebuild the renderer, launch Electron, start a second live writer, change a mobile fingerprint, or update `~/Applications/Milagre Rust.app`.

Storage lifetime still has a native validation gate. The main function retains a shell-root lease through `App::run`. The transport supervisor retains its LaunchContext and emitter AppHandle until it observes the child exit on its next reconnect attempt (normally within one second of socket closure); it then breaks rather than reconnecting forever. The fixture removes the NSEvent shortcut monitor on `RunEvent::Exit`, releasing that callback's retained AppHandle. These close known ownership chains, but headless tests do not establish WKWebView deallocation, AppKit autorelease timing or final Tauri managed-state release. Do not claim shell-directory removal after native WebKit destruction until a real window test observes both.

Current headless results: 23 fixture tests and 39 default-shell tests pass; each suite leaves its installed-host read test ignored. Strict Clippy passes with the feature across all targets. Crash cleanup tests inject known exit, ECHILD, live-child and wait-error outcomes, assert exact probe/kill/wait call order, and exercise an externally reaped real `/usr/bin/true` child. Unknown or already-known exit never signals; unknown wait never confirms storage cleanup.
