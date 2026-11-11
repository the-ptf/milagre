# Isolated desktop fixture launch checkpoint

This feature compiles a separate `milagre-rust-fixture` executable and `com.milagre.rust-fixture` Tauri configuration. The default `milagre-rust` executable, its production endpoint discovery and installed application stay unchanged. No window was launched or app installed for this checkpoint. The production React renderer is reused from the existing `dist` build; this is not a second UI implementation.

## Authority and storage

`LaunchContext::spawn_fixed()` takes no arguments. It resolves only `app-fixture` beside the current shell executable, refuses symlinks/non-owned/group-or-world-writable executables, and starts that fixed child with inherited stdin/stdout pipes. It uses `env_clear`, a fixed system PATH, and private HOME/XDG/config/cache/temp paths under a new mode-0700 `/tmp` shell directory. This is configuration separation, not an OS sandbox or an executable signature check.

The daemon owns its separate generated profile. The shell reads only the bounded 4096-byte receipt from that exact child's pipe, with a five-second deadline. It checks versions, fixture/Gated flags, `Child.id`, UID, canonical generated profile/Project containment, the profile-derived socket hash, and all four device/inode/mode/UID/type records. Directory and socket identities are rechecked on every connection. macOS `getpeereid` and `LOCAL_PEERPID` verify the connected peer belongs to the same UID and exact child PID. The parser and endpoint are private; there is no arbitrary endpoint, existing profile, executable or environment input. A missing, changed or exited child never falls back to the installed host.

The shell owns its own lock, preferences, window-state and smoke directories. Preferences start empty and never read Electron or installed Rust preferences. Only the existing Milagre preference namespace and string/null values are accepted, with a 1 MiB aggregate limit. Window position/size are written under the shell root on close. Fresh launches do not restore a previous fixture. The ordinary fixture rejects smoke capture. The separate `fixture-native-smoke` feature runs only a compiled fixed probe and writes evidence to a new private directory outside shell storage; it never uses the production global capture paths. No ContentOwner or content-root grant exists in this composition; paths from the receipt do not authorize Artifact/media filesystem reads.

The fixture transport uses the ordinary renderer command allowlist, paging and state hydration, with one explicit handshake difference: absence of `computer-management-v1` does not mark this known limited fixture as an outdated installed host. It never advertises that capability. Unsupported owner/native calls still fail. Native shell support is deliberately small: private preferences, version/launch arguments, connection state, window drag/maximize/background, compiled shortcuts, exact-Project open and Quit. Native dialogs/editors/notifications/browser/content/account helpers remain unavailable. The native smoke verifies the initial empty-Chat workspace and records unsupported startup calls. First-user onboarding interactions, model selection and the complete renderer startup call set remain unverified.

## WebKit source evidence

The locked local dependencies provide this exact path:

1. Tauri **2.12.5**, `src/webview/webview_window.rs`: `incognito(true)` sets the underlying WebviewBuilder flag.
2. tauri-runtime-wry **2.12.3**, `src/lib.rs`: forwards `webview_attributes.incognito` to Wry `with_incognito`.
3. Wry **0.57.2**, `src/wkwebview/mod.rs`: `(true, _, _)` selects `WKWebsiteDataStore::nonPersistentDataStore`, then assigns it to the new WKWebViewConfiguration. A supplied existing configuration could bypass this branch; this shell supplies none.

The fixture builder explicitly sets `incognito(true)` and creates no persistent custom data-store identifier. After construction, a native `with_webview` callback checks `configuration().websiteDataStore().isPersistent()`. A persistent result prevents showing the window and requests orderly owner shutdown. A distinct Tauri identifier alone is not the storage guarantee, and `data_directory` is not used as a macOS WebKit isolation claim.

The fixed native smoke has now observed `isPersistent == false`, production renderer startup, and localStorage/native preferences/actual outbox-DB marker isolation over reload and two fresh processes. It compares only two installed preference files, not all installed storage. Cookies, persistent fixture WebsiteData attribution, and native window/store destruction order remain unverified. See `NATIVE-FIXTURE-SMOKE.md` for exact evidence and limits. WebKit network/cache internals and OS preferences are not an OS sandbox.

## Quit and crash behavior

The shell retains the exact Child and stdin while the window is alive. Close, Quit and ExitRequested are intercepted. Quit runs off the UI thread, sends `daemon:stop` over a separately authenticated endpoint and accepts only the matching `{stopping:true}` result. It then waits up to three seconds for a successful child exit after the daemon's `Server::finish`. A pending/refused response or incomplete exit retains all authority and storage, prevents window exit, emits `app:quit-blocked`, and changes the fixture title to describe the retry path. Repeated Quit is supported. The existing isolated runtime itself interrupts synthetic turns during shutdown; the shell adds no force flag or production suspend/resume policy.

The UI's `clean()` status is atomic and cannot block behind the child mutex during Stop. Clean Exit explicitly calls `remove_shell_storage()` from `RunEvent::Exit`: it requires acknowledged successful child exit, checks the original shell-root identity, refuses an active shell writer, removes the private directory and marks cleanup complete. Retained LaunchContext/storage Arcs do not delay this removal. Later preference/window writes fail instead of recreating files. Cleanup failure is reported; it is not treated as successful removal.

A crash, missing acknowledgement or unsuccessful exit is never classified clean. Admission/build failure now probes, signals only a proven-live retained child, and polls for exit synchronously for at most three seconds. It does not start a detached reaper that races main's return. Unknown/timeout outcomes retain storage and report incomplete cleanup. The setup closure catches both errors and Rust panics internally, so a returned error cannot trigger Tauri's own setup panic inside `App::run`. Confirmed failure reaping permits a distinct exit(1); unconfirmed setup cleanup retains the context/event loop and reports the failure. This is abnormal termination, not clean shutdown, so clean-only Exit storage removal does not run. Forced LaunchContext Drop remains a best-effort crash fallback; no normal path relies on it.

Unknown wait outcomes never authorize another PID signal. SIGKILL or failed startup can leave the daemon's generated profile and shell storage behind; the shell does not adopt/delete the daemon profile or claim graceful durability. A pre-loop startup failure with unconfirmed exit can still leave its child; its error says so and retains storage. Native setup error/panic behavior and WebKit destruction still need a window-based check.

## Headless checks

Build the fixed sibling crate artifact first when running the fixture tests:

```sh
cargo build --manifest-path experiments/rust-runtime/Cargo.toml --features app-fixture --bin app-fixture
cargo test --manifest-path experiments/rust-desktop/Cargo.toml --features app-fixture --bin milagre-rust-fixture
cargo test --manifest-path experiments/rust-desktop/Cargo.toml --no-default-features --bin milagre-rust
cargo clippy --manifest-path experiments/rust-desktop/Cargo.toml --features app-fixture --all-targets -- -D warnings
```

The test-only child path is a fixed sibling crate target path, not a configurable executable. Tests spawn fresh in-process scripted Rust owners only. They prove receipt bounds/deadline/EOF, real peer-PID rejection, replaced socket rejection, private preference storage, busy quit refusal with a reachable owner, Stop/watchdog/retry, acknowledgement plus successful process exit/profile cleanup, and crash never becoming clean. The ordinary desktop transport also completes its real handshake/current-Project/runs calls against that owned child without claiming computer management. The live installed-host test remains ignored.

The earlier lifecycle checkpoint was headless. The later opt-in native smoke builds a disposable staging bundle and runs only its fresh isolated child. It never launches Electron, starts a second live writer, changes a mobile fingerprint, installs the fixture, or updates `~/Applications/Milagre Rust.app`.

Storage lifetime still has a native validation gate. The locked tao **0.37.2** `src/platform_impl/macos/event_loop.rs` implements `run` by calling `run_return` followed by `process::exit`. Code after `App::run` and final Arc destructors are therefore not cleanup hooks on this path. Normal shell-file removal is explicit in `RunEvent::Exit` and works while Arcs remain retained. The transport supervisor still retains its LaunchContext/emitter until it observes child exit; the fixture removes its NSEvent shortcut monitor on Exit. Neither ownership-chain release nor the nonpersistent-store source path proves WKWebView deallocation. Exit file cleanup occurs before Tauri's own `cleanup_before_exit`, so this checkpoint specifically does not claim that AppKit/WebKit objects have already been destroyed. The shell directory holds configuration/preferences/window files, not the nonpersistent WKWebsiteDataStore. Real-window testing must confirm no late callbacks write after cleanup and the native store does not persist elsewhere.

Current headless results: 26 fixture tests and 39 default-shell tests pass; each suite leaves its installed-host read test ignored. Strict Clippy passes with the feature across all targets. New regressions retain Context/storage Arcs across explicit removal, reject replacement-root cleanup without touching a sentinel, prove the clean check does not lock the child, refuse active writers and late writes, and confirm setup-failure reaping before return. Injected bounded-cleanup tests cover known exit, ECHILD before/after signal, live timeout and exit confirmation without a blocking wait. Earlier crash tests exercise an externally reaped real `/usr/bin/true` child. Unknown or already-known exit never signals; unknown wait never confirms storage cleanup.

Remaining review limits: ACLs/xattrs are not part of endpoint identity checks, generated Project mode is not constrained beyond UID/type/identity and private parent containment, and the fixed sibling is not signature/hash verified. Normal event-loop Exit cleanup has passed in two real background windows, with both generated roots absent through five seconds after process exit. Native setup failure and WebKit object release remain unverified. These limits remain fixture-only adoption gates, not completed native isolation evidence.
