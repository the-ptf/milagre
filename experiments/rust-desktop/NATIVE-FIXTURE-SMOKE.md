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
Rust shell's preference hashes had no change observed for those two files at those times, with no writer attribution or filesystem-isolation claim. PNGs were visually inspected.

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
also observed before that click, but are not required by the test. Because the reply was already visible, that run did not prove the click was necessary to reopen the Chat; the stricter leave-and-reopen checkpoint below addresses this.

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

## Leave-and-reopen validates the sidebar click

The earlier cTjQ8F pass observed the reply already visible after reload, so its
row click was not necessary for the following assertion. The stricter probe now
records that automatic selection, clicks the production `New chat` button,
requires the sent Chat to be unselected and its reply absent, then re-queries and
clicks the listed Chat. The reply must become visible again with zero send calls.
The external observer requires one New chat click, the explicit false/false
pre-click state, and one sidebar click. The probe does not invoke bridge commands
or change renderer state directly to select either view.

Two fresh native runs passed this sequence in
`/private/tmp/milagre-native-fixture-observer-FXjY5u/observer.json` after rebuilding
the owner with inbox fix `33a183a6`. Their report/PNG directories are
`/private/tmp/milagre-fixture-evidence-Rn8VC9` and
`/private/tmp/milagre-fixture-evidence-l1TPwO`. Both phase-1 reports record
`beforeSidebarClick: { selected: false, replyVisible: false }`, one sidebar click,
and zero sends. Both preserve the same two owner messages and summary across
reload. The Rn8VC9 native after-reload PNG was visually inspected.
Both exits are zero; owner Stop and explicit Exit cleanup succeed. Generated
roots remain absent through actual 5000 ms observations. Preference metadata and
contents had no observed change across the two files; attribution remains unknown
and `isolationClaim: false`.

Preference fingerprinting is now a shared observer helper. A deterministic test
uses a real temporary file, writes new content after the read but before the
second `lstat`, and verifies `readStable: false` despite the returned read bytes
matching the earlier observation. This tests concurrent change detection, not
writer attribution or comprehensive filesystem isolation. Six helper tests,
27 fixture tests (one ignored), strict fixture all-target Clippy, JS lint and
format checks pass. Logs: `/tmp/milagre-native-click-{observer,tests,clippy}.log`.
The default shell and production renderer source are unchanged. No fixture was
installed, no live provider or production host was used, and nothing was pushed.

## Fixture content checkpoint

Build the separate shell with `--features fixture-content-smoke` and invoke `node experiments/rust-desktop/native-fixture-smoke.mjs --content`. The fixed flag independently requires the content scenario; it accepts no path or executable. Use the same
fixed observer. It retains the scripted send and leave-and-reopen checks, then
uses production Artifacts and Designs toolbar buttons, the real Design editor's
Text inspector and Save button. The runtime's one SharedContent writer seeds
`fixture-report` (HTML), `fixture-screen` (Design) and `fixture-note.txt` only in
the generated Project. The probe does not create content through frontend stubs
or edit the production React components.

The content checks distinguish these observations:

- The HTML iframe emits its production page-helper ready event. A feature-only
  observer reads its actual heading and absence of the Tauri/renderer bridges;
  both parent and child observe the opaque sandbox boundary.
- The Design thumbnail reports painted. A read-only all-frame script observes
  the real srcdoc heading, positive rendered bounds, `design-guides` created by
  the production controller and the visible selection outline applied by that
  controller. It does not supply content, selection, a controller or a ready
  event. The inspector edit and save are a separate path through production UI.
- The owner reread must return version 2 and the edited text. After main-document
  reload the inspector, srcdoc and owner read must retain that edit, without a
  second save or send. This is owner-read evidence, not a direct SQLite read.
- A fresh HTML preview is opened and its native handler returns 200 immediately
  before reload. That exact capability must return 404 afterward. These native
  handler results are labeled as such, separately from WebKit frame rendering.
- Actual main-document CSP violations reject an HTTPS image and an absolute-path
  `milagre-media` image, while an inline image decodes. The fixture does not
  register the media scheme. This is no packet capture or filesystem-isolation
  claim. The actual HTML iframe separately reports both CSP refusals under its own restrictive policy. The Design srcdoc
  also inherits the main document's additive fetch policy.

Only the exact boolean and `: reduce` reduced-motion queries are emulated before
React starts. Other queries use WebKit's result. This synthetic environment lets
hidden-window transition completion reach the real panel content; decorative
animation and system accessibility-preference parity are not tested. The fixture
also installs the same existing frame-aware native navigation delegate as the
default shell. Main navigation remains restricted, allowed child frames retain
their sandbox, and new windows remain denied.

Several failing runs are retained. The first content attempts, including
`/private/tmp/milagre-native-fixture-observer-9YM5Cv/observer.json`, lacked the
frame-aware navigation delegate and never reached an HTML iframe. The later
`/private/tmp/milagre-native-fixture-observer-LinrbX/observer.json` negative control
showed that the configured/custom-scheme CSP alone did not reject the HTTPS image; explicit additive meta policies now precede generated
content. Those failed attempts are not claimed as content passes.

`/private/tmp/milagre-native-fixture-observer-ubSGJL/observer.json` and
`/private/tmp/milagre-fixture-evidence-JYdAhq/report.json` retain the next failure.
The HTML iframe rendered and the Design save returned version 2, matching the
owner reread, but the transcript then disappeared while Chat 1 stayed selected.
The bounded DOM observations record reply visible at 3023 ms, absent at 3098 ms,
and editor unmounted at 3110 ms. There were no recorded renderer errors. Source
inspection found that the fixture's 350 ms idle unload published raw state with
messages removed, without a negotiated lean-state marker. The production UI
therefore treated the Chat as empty and removed its content anchor. The runtime
fix must preserve the whole-state contract; the probe does not add keepalive
reads or extend timing to conceal this failure.

The checkpoint does not package a raster helper, claim PNG tool feedback,
exercise real providers, or test every Design edit, comment or attachment flow.
The saved content stays in generated profiles, and all screenshots are fixture
test evidence rather than real-provider PR images.

### Two-process content pass

After owner `9389bdb4` and runtime `2c13dd74`, the 350 ms idle policy is unchanged
and whole-client publication retains the transcript. The first corrected-runtime
run (`/private/tmp/milagre-native-fixture-observer-IS46RH/observer.json`) kept the
editor mounted and reached Saved version 2. Its new frame-text assertion still
failed because the production Design renderer lays out wrapped lines in separate
block spans. The probe now retains `rawText` and compares whitespace-normalized
rendered text. It does not replace or modify that text.

Both fresh processes passed in
`/private/tmp/milagre-native-fixture-observer-YpZlgj/observer.json`. The evidence
roots are `/private/tmp/milagre-fixture-evidence-Uz7hIe` and
`/private/tmp/milagre-fixture-evidence-4QY9wO`. Each process made one scripted send
and one Design Save before reload, then zero sends and zero saves afterward.
The version-2 owner read, inspector and real srcdoc all retain
`Rust fixture design edited in WebKit`; the raw rendered text is
`Rust fixture design edited\nin WebKit`. The controller-created guides, selection
outline and heading bounds (342 by 96 CSS pixels) are observed before and after
reload. Both main document and actual HTML iframe report the expected HTTPS and
media-scheme image CSP violations. The live preview handler gives 200 before
reload and the exact old capability gives 404 afterward.

The Uz7hIe native PNGs were visually inspected: before reload the Chat transcript
and HTML page are visible together; after reload the Design editor displays the
saved edited heading and selection outline. Each PNG is 2880 by 1800. The same
phase is pixel-identical across the two deterministic fresh processes, so pixels
alone do not establish process separation or reload. The observer's distinct
profiles, PIDs and stage data establish those checks. PNG SHA-256 values:

- Before reload: `1bbf00cd3757efa68ee1ed932d423b495c8d8f681cea82e342f5b6f374363c3e`
- After reload: `475a7a4c3355ee02323e9b9af3603ded3955b10dc1e95a3650cf9b90b58354cf`

Both processes exit 0 with no signal and empty stderr, report a nonpersistent
WebKit store, and complete owner Stop plus explicit Exit cleanup. Both generated
roots remain absent through actual 5000 ms observations. The two watched
preference files have `no-change-observed`; attribution is unknown and
`isolationClaim` remains false.

The staged binary manifest records:

- Shell: `d522c589bcbc166784f55d4e9145298819275e1c65b1710430185b46c80242d8`
- Owner: `c62e4faf023daba9cec44273283bde5346bea61daeee319aa98fd1784d684072`

Validation: 38 fixture tests pass, with one installed-host check ignored; eight
of these cover the content boundary. Seven observer/reduced-motion tests pass.
Strict all-target `fixture-content-smoke` Clippy, selected JavaScript lint/format
and diff checks pass. Logs: `/tmp/milagre-content-final-tests.log`,
`/tmp/milagre-content-final-clippy.log`, `/tmp/milagre-content-native-final.log`.
The parent separately validates and installs the default shell. This native
checkpoint installs nothing and never contacts the production host.

## Explicit content-health evidence

The content probe now checks that its saved assistant message remains rendered after
content actions in both phases. After reload it closes the production Design editor,
then records the exact assistant message id, active Chat and a positive rectangle
intersecting the viewport. This is geometric DOM evidence, not a general proof against
ancestor clipping, transparency or occlusion. The native screenshot supplies separate
visual evidence for the observed run.

The main document's uncaught JavaScript errors, unhandled rejections and console.error
calls are counted throughout the content phase. Their retained text is bounded at
eight entries; a nonzero count fails even when text is capped. A single listener counts
all main-document CSP violations during that phase, retaining at most 16. Only the two
intentional img-src probe targets are allowed, both must occur, and a count/list mismatch
fails. Startup, iframe errors and non-bubbling element resource errors remain outside
this observation. These assertions do not broaden the existing filesystem or network
isolation claims.

The external observer independently checks these observations. The explicit `--content`
invocation also rejects a missing, storage or send scenario, so the wrong build cannot
pass the content gate. The no-flag observer remains available for other smoke scenarios.
The failure summary now names the content stage when content work fails.

Two fresh runs passed with explicit `expectedScenario: "content"` in
`/private/tmp/milagre-native-fixture-observer-Hix1TF/observer.json`. All four phases record
Chat 1 / assistant 11, a 560 by 50.390625 rectangle intersecting the viewport, zero observed
errors and exactly the two intended CSP refusals. Both retain Design version 2 after
reload with zero repeated sends or saves. Stores are nonpersistent, exits are zero with
empty stderr, owner Stop and shell Exit cleanup succeed, and both generated roots remain
absent through five seconds. The preference observation is no-change-observed for its
two files only, unattributed, with no isolation claim.

The first strengthened run `Q5709f` also passed; its run-one after-reload PNG was viewed
by root and an independent reviewer and shows the reply beside the edited Design. The
final Hix1TF run adds the independent scenario assertion using the same compiled native
probe. These are synthetic fixture test images, not real-provider PR screenshots.

Root validation: 53 shell-target tests and 38 fixture-target tests pass with one ignored
case in each; nine helper/reduced-motion tests pass, including eleven rejected content
evidence mutations and wrong-scenario refusals. Strict content-feature all-target Clippy,
targeted JavaScript lint/format and rebuilt renderer/shell/daemon pass. Logs use
`/tmp/milagre-content-health-{tests,clippy,helper,renderer,build,daemon,native-final}.log`.
Independent source and artifact review found no P1/P2 and closed the scenario-gate P3.
No production components changed, no full persona fleet ran, and no fixture was installed.
