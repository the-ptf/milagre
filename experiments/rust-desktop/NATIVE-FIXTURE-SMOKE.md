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
   read-only before/after with mtime/ctime/device/inode and read-stability metadata.
   Installed application PID/parent/start/executable metadata is captured with
   `ps comm`, without argv/environment. Any content/metadata change or unstable
   read is `environment-noisy`, always `unattributed`. Even unchanged hashes mean
   only `no-change-observed` for these files, never filesystem isolation. The
   fixture `passed` flag does not include a preference-isolation claim.

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
that provider can run. This storage-only sequence did not test a send, provider turn, Design or Artifact.
The separate scripted send/reload milestone is recorded below.

Cookies, the complete WebKit/IndexedDB/cache filesystem footprint, OS preference
writes, setup-failure cleanup, native object deallocation and late writes beyond
five seconds remain unverified. `windowDestroyed` was not observed. Exit removes
shell files before Tauri's internal native teardown; observed non-recreation does
not prove object destruction. The two preference hashes are narrower evidence
than full live-profile isolation. No full persona QA fleet ran for this technical
smoke, and no installed application or production host was replaced.

## Composer send regression (separate feature; historical failure)

Build the shell with `--features fixture-send-smoke` instead, then run the same
fixed observer. The native context/report records `scenario: "send"`; missing
send-probe results cannot pass this feature. Storage-only assertions remain
independent and passed again in
`/private/tmp/milagre-native-fixture-observer-KdGDtn/observer.json`.

The added sequence opens real Settings > Models, turns off the actual TLDR
checkbox, opens the production model picker, selects Kiro > Scripted Rust fixture,
closes the picker, dispatches synthetic `beforeinput` through the composer and
calls the Send button's DOM `click()` exactly once. These are synthetic DOM events
through production components, not human keyboard/mouse or OS-level input. It never calls `sendMessage` directly or
rewrites the renderer's request. The runtime's separately tested non-Claude
`replies: "concise"` compatibility fix is required (`015983df`).

The first accepted send within an overall failed observer run is recorded in
`/private/tmp/milagre-native-fixture-observer-krSHbh/observer.json`, with real PNGs
in `/private/tmp/milagre-fixture-evidence-Uav9IX`. Model/Ask selection, Settings,
one click, one `chat:send`, ordered agent events 1 through 5, streamed text and
exactly one `turn-completed` passed. Owner reads returned user 10 and assistant
11, session 1, total two messages, with the exact test prompt/reply. The same
messages remained readable after the page reload.

**Before the owner summary fix, the native lifecycle test failed:** the production sidebar still says "No Chats
yet" even after the owner returns both messages. Earlier probes exposed this
through a reload timeout, but automatic selection restoration was not established
as a production requirement. The strengthened phase 0 now requires exactly one
listed sent-Chat row and failed at this listing defect. Phase 1 requires the
listed row, observes automatic selection separately, dispatches a DOM click on
that row, then requires the reply. It does not require automatic
selection restoration. Production `compactProjectState` calls
`withChatSummaries`; the Rust owner's pre-fix `slim` only ported detail compaction.
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
The observer preserves exact message/summary identity comparison across reload,
requires exactly one listed sent-Chat row in both phases, one DOM row click after
reload, and zero sends after reload when the lifecycle passes. A native startup
document probe after three seconds records bounded progress even if hidden
WebKit timers suspend the JavaScript wait; the existing forty-second watchdog
still fails and quits rather than reporting success.

### Correction to the dTEZWF environment evidence

`productionPreferencesUnchanged` is **false** in the final `dTEZWF` failing run.
The Electron preference file stayed 43,661 bytes but its SHA-256 changed from
`93d0a9e7c3e0b9c77d46bfd4d28875e5b0464cce2ddcd30990b93f9bb76aac4b` to
`4336876a6580b4035a0d8461dfa803ce32ffb54564733803edc8218ec42d4739`.
The installed Rust preference hash stayed unchanged. This observation was omitted
from the original checkpoint report. It is environment-noisy and unattributed;
no evidence identifies which process wrote the file. Running installed apps are
possible concurrent writers, not proof of attribution. That run offers no
preference-isolation assurance. Earlier `NxClI0`/`KdGDtn` unchanged hashes remain
limited observations at those times, not a full filesystem-isolation result.

New observers include file modification times and bounded installed-app process
metadata. The classification has deterministic tests for changed bytes with and
without live apps, same bytes with changed metadata, unstable reads, and missing
process metadata. No logs include process arguments or environment values.

Event checks currently prove strictly increasing sequence numbers, streamed text
and one terminal, not full Node event-sequence equivalence. The observed sequence
contains two `message-sent` events; this native probe does not explain or bless
that duplication. The owner summary work also corrected production Node oracle compaction,
independently of this UI assertion fix.

The strengthened probe was run in
`/private/tmp/milagre-native-fixture-observer-ewMjQV/observer.json`. It now fails
in phase 0 with `Sent Chat missing from sidebar: owner summary.count is 0 beside
two messages`, recording zero sidebar rows beside the two owner-read messages.
Phase 1 was not reached in that run, so it did not verify the row-click recovery
path. This run records stable preference metadata/hashes as
`no-change-observed`, three live installed application processes, and
`attribution: "unattributed", isolationClaim: false`. It does not erase or
explain the changed preference hash in the earlier `dTEZWF` run.

## Scripted send/reload passed after the owner summary fix

Owner commits `a1db434d` and `37e0c0f3` were rebuilt into the fixed sibling
`app-fixture`. Both fresh background WebKit runs passed in
`/private/tmp/milagre-native-fixture-observer-cTjQ8F/observer.json` on November 11,
2026, from 14:31:34 through 14:31:55 UTC. This is a bounded native fixture result,
not a claim that the full migration or all runtime conformance checks pass.

Each run selected Scripted Rust fixture/Ask, disabled TLDR through Settings,
sent once through the production composer, and received the exact scripted
reply. The sidebar listed exactly one Chat before and after reload. Owner reads
returned exactly user 10 and assistant 11, session 1, total two messages; the
summary had `count: 2`, the exact prompt title, matching message IDs/timestamps,
`lastModel: "scripted"`, `lastOutcome: "completed"`, and the original
`clientMessageIds`. The entire recorded transcript/summary matched across reload.
Phase 1 clicked the real listed row through a synthetic DOM event and rendered
the reply with zero send calls. Automatic selection and reply visibility were
also observed before that click, but are not required by the test.

The native PNGs and reports are in
`/private/tmp/milagre-fixture-evidence-HzdRMm` and
`/private/tmp/milagre-fixture-evidence-JHnyGS`. Both `after-reload.png` captures were
visually inspected: they show the production sidebar Chat row, title, user
message, assistant reply, and composer. These are scripted test screenshots,
not real-provider PR screenshots. Every capture is 2880 x 1800 pixels.

Both native stores reported `isPersistent: false`. Local-storage/native-preference/
real-outbox markers survived the reload and were absent in the next fresh process;
the real outbox state remained unchanged. Both processes exited zero after owner
stop and explicit shell cleanup. Neither private root existed at the four
scheduled checks through five seconds; the last actual observations were 5000 ms
and 5002 ms after exit. Native deallocation and later recreation remain untested.

The two observed preference files had unchanged contents and metadata in this
run. Three installed application processes remained present. The report retains
`attribution: "unattributed"` and `isolationClaim: false`; this does not explain
or erase the historical `dTEZWF` change. Observer schema 2 renames the misleading
legacy boolean to `observedPreferenceContentsUnchanged`, records per-run UTC
start/exit/observation timestamps plus monotonic elapsed times, and reports a
bounded native phase/stage/error instead of only an exit-code assertion. Timeout
termination remains distinct from orderly exit. Listing errors include observed
row/matching/summary/message counts, and post-click waits requery the row instead
of retaining a potentially replaced DOM node.

The native event check still proves only ordered events 1 through 5, streamed
text and one terminal. It does not prove full Node event equivalence. Direct
SQLite durability, queue/Stop, real providers, cookies, full filesystem attribution,
Design/Artifact flows and performance comparison remain outside this milestone.

Checkpoint checks: 27 fixture tests and 39 default-shell tests pass (one ignored
in each); five observer-helper tests pass; strict Clippy over all fixture targets,
JavaScript lint/format and `git diff --check` pass. Logs are
`/tmp/milagre-desktop-send-final-tests.log`,
`/tmp/milagre-desktop-default-final-tests.log`, and
`/tmp/milagre-desktop-send-final-clippy.log`. These desktop checks do not cover the
separate runtime owned-read oracle failure reported during this checkpoint.
