# Fixed native fixture smoke

`fixture-native-smoke` is an opt-in extension of `app-fixture`. It accepts no
executable, profile, script, endpoint or output-path arguments. The observer copies
the two fixed Cargo artifacts into a new private staging app, signs that copy ad
hoc, and runs it twice with `MILAGRE_BACKGROUND=1`. Nothing is installed.

```sh
node experiments/rust-desktop/build-renderer.mjs
cargo build --locked --manifest-path experiments/rust-runtime/Cargo.toml --features app-fixture --bin app-fixture
cargo build --locked --manifest-path experiments/rust-desktop/Cargo.toml --features fixture-native-smoke --bin milagre-rust-fixture
node experiments/rust-desktop/native-fixture-smoke.mjs
```

The observer prints its private `observer.json` path. Reports and PNGs remain
outside the repository and outside both disposable application roots. It records
both staged executable hashes, generated identities, process exit status, bounded
stderr, actual native store persistence, and renderer diagnostics. These are
scripted-fixture test images, not real-provider PR screenshots or performance
measurements.

## Assertions and bounds

1. The live `WKWebView.configuration.websiteDataStore.isPersistent` is false.
   React and the existing preload bridge are ready on the exact generated Project,
   containing the two seeded sessions. Empty sessions need not appear in the
   production sidebar. The normal workspace layout is present.
2. Fixed unique markers start absent in localStorage, private native preferences,
   and an extra record in the production outbox IndexedDB's existing `queue`
   store. The probe does not create that store, send a Chat, or modify its `state`
   record. All three markers survive a real page reload. All start absent in the
   second fresh process, which uses the same staged bundle identifier.
3. Each phase captures actual WKWebView PNG bytes, capped at 32 MiB. Finite CSS
   entry animations are finished through their native Animation API because a
   hidden WebKit window can leave them suspended. No DOM layout or pixels are
   replaced. The JSON report is capped at 256 KiB, the renderer result at 64 KiB,
   and callback diagnostics have fixed field/list limits.
4. Async probe operations use three-second Promise races; readiness polling has
   an eight-second bound. Background WebKit timers can be suspended, so an
   independent native forty-second watchdog captures failure and requests orderly
   Quit. Native snapshot and document callbacks have 25/5-second bounds. The
   external observer's 110-second last resort signals only its retained shell
   Child and records SIGKILL/timeout as failure, never orderly cleanup.
5. A pass needs owner-stop acknowledgment plus successful child exit, explicit
   shell Exit cleanup, successful shell exit, and both generated roots absent at
   0, 250, 1000 and 5000 ms afterward. Two installed preference files are hashed
   read-only before/after; their unchanged flag is reported separately.

## Observed on November 11, 2026

Two fresh background runs passed in
`/private/tmp/milagre-native-fixture-observer-NxClI0/observer.json`.
Both real stores were nonpersistent; both reload sequences retained their own
markers; the second process inherited none; the real outbox `state` record stayed
unchanged. All four PNGs are 2880 x 1800 pixels for a 1440 x 900 CSS viewport.
Both processes exited zero, owner-stop/Exit cleanup succeeded, and neither private
root reappeared during the five-second observation. Electron's and the installed
Rust shell's preference hashes were unchanged. PNGs were visually inspected.

The captures are in `/private/tmp/milagre-fixture-evidence-Bj6yMX` and
`/private/tmp/milagre-fixture-evidence-jycFGX`. Each has `before-reload.png`,
`after-reload.png` and `report.json`. The initial workspace shows the real
production sidebar, canvas and composer with an empty fixture Project.

Earlier failed probes are preserved. The first expected visible Chat rows even
though the production sidebar hides these empty sessions. Its unbounded awaited
call/polling could outlive the JavaScript deadline in a hidden window; an external
timeout killed the shell, the owner removed its profile on EOF, and the shell
root remained. Later failures captured the native document/PNG and stopped
orderly. The final probe checks saved sessions instead and has per-operation plus
native deadlines. No unsupported command was replaced with a success stub.

## Open evidence and behavior gaps

This is startup/storage/cleanup evidence for a scripted owner only. Unsupported
calls remain explicit in the report, including computers/linked scopes, usage,
ports, project Git/image/branches, pull requests, keybindings, context settings,
Chats home, routines and Design enablement. Native notification/update/dictation
helpers are also unavailable. The visible default model label is not proof that
that provider can run. No send, provider turn, Design or Artifact was tested here.

Cookies, the complete WebKit/IndexedDB/cache filesystem footprint, OS preference
writes, setup-failure cleanup, native object deallocation and late writes beyond
five seconds remain unverified. `windowDestroyed` was not observed. Exit removes
shell files before Tauri's internal native teardown; observed non-recreation does
not prove object destruction. The two preference hashes are narrower evidence
than full live-profile isolation. No full persona QA fleet ran for this technical
smoke, and no installed application or production host was replaced.

## Composer send regression (separate feature, currently blocked)

Build the shell with `--features fixture-send-smoke` instead, then run the same
fixed observer. The native context/report records `scenario: "send"`; missing
send-probe results cannot pass this feature. Storage-only assertions remain
independent and passed again in
`/private/tmp/milagre-native-fixture-observer-KdGDtn/observer.json`.

The added sequence opens real Settings > Models, turns off the actual TLDR
checkbox, opens the real model picker, selects Kiro > Scripted Rust fixture,
closes the picker, types through the composer's `beforeinput` handler and clicks
the real Send button exactly once. It never calls `sendMessage` directly or
rewrites the renderer's request. The runtime's separately tested non-Claude
`replies: "concise"` compatibility fix is required (`015983df`).

The first accepted send is recorded in
`/private/tmp/milagre-native-fixture-observer-krSHbh/observer.json`, with real PNGs
in `/private/tmp/milagre-fixture-evidence-Uav9IX`. Model/Ask selection, Settings,
one click, one `chat:send`, ordered agent events 1 through 5, streamed text and
exactly one `turn-completed` passed. Owner reads returned user 10 and assistant
11, session 1, total two messages, with the exact test prompt/reply. The same
messages remained readable after the page reload.

**The native lifecycle test fails:** the production sidebar still says "No Chats
yet" and reload opens an empty composer instead of rendering the saved reply.
The assertion is retained. Production `compactProjectState` calls
`withChatSummaries`; the Rust owner's current `slim` only ports detail compaction.
An existing zero-count summary suppresses the Chat in the production sidebar.
No frontend summary fallback, fixture seed removal or direct Chat-open event is
used to bypass this backend compatibility gap.

The final diagnostic run is
`/private/tmp/milagre-native-fixture-observer-dTEZWF/observer.json`, with PNGs and
native document results in `/private/tmp/milagre-fixture-evidence-EBJch8`.
It records the exact owner-read `session.summary: {"count": 0}` beside the two
messages both before and after reload. The first phase sends once and receives
the reply; the second phase fails its rendered-reply assertion and is captured
by the native deadline. Owner stop and explicit shell cleanup still succeed,
and the external observer confirms both roots remain absent through five seconds.
The send-feature headless suite has 27 passing tests, the default shell has 39,
and strict Clippy passes. Those checks do not turn this failed native regression
into a passing lifecycle milestone.

The read result is labelled `ownerReadConfirmed`, not disk persistence. Missing
`state.persistence` means no reported save error; it does not prove a completed
save. The shell never reads the owner profile's SQLite files. Same-run durable
disk evidence, queue/Stop behavior and real-provider turns remain separate work.
The observer compares message identities across reload and requires zero send
calls after reload when the lifecycle eventually passes. A native startup
document probe after three seconds records bounded progress even if hidden
WebKit timers suspend the JavaScript wait; the existing forty-second watchdog
still fails and quits rather than reporting success.
