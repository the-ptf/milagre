# Separate Rust Preview application

`Milagre Rust Preview.app` is a separate Finder-launchable application. It uses
normal `milagre-rust-chat` and `chat-runtime` builds, the production React renderer,
one explicitly selected Claude account/model and one dedicated persistent root.
It does not replace `Milagre Rust.app`, Electron, or the production daemon. The
preview is a development checkpoint, not full retained-service or upgrade parity.

## Prepare and package

Root first creates and validates a stable dedicated runtime beneath the private
`~/Library/Application Support/Milagre Rust Preview/` directory. The packager never
creates a runtime, reads/copies credentials, rewrites its saved manifest or starts
a window/provider. The runtime's normal markers, ownership checks and explicit
launch selection remain authoritative.

After root's normal runtime/native checks pass:

```sh
python3 experiments/rust-desktop/package-preview.py \
  --data-root "$HOME/Library/Application Support/Milagre Rust Preview/data" \
  --node-modules /absolute/explicit/build-dependencies/node_modules
```

The default stages a signed app and prints its private path and report. It builds
only `chat-desktop` and `chat-runtime` in separate package target directories;
smoke/fixture entrypoints are not packaged. Node is needed for the renderer build,
not as the preview's runtime daemon. Add `--release` for optimized native binaries;
the default development build is not a release-performance benchmark.

Root may add `--install` after validation for the first installation at
`~/Applications/Milagre Rust Preview.app`. An existing Preview is always retained:
the script refuses replacement. The ordinary installed Rust/Electron apps and all
persistent data are never installation or cleanup targets. The script starts no
process belonging to an app or provider.

The package copies actual bundled skills and the icon into Resources, creates a
private mode-0600 `preview-launch.json`, ad-hoc signs the bundle, verifies it with
`codesign --verify --deep --strict`, and records post-signing binary hashes and
architectures. Its source HEAD/dirty flag are diagnostics, not reproducible-build
attestation. Any missing build dependency or failed validation stops packaging.

Offline boundary checks, without starting an app/provider:

```sh
python3 experiments/rust-desktop/test-package-preview.py
cargo test --manifest-path experiments/rust-desktop/Cargo.toml --locked --offline \
  --features chat-desktop --bin milagre-rust-chat preview_launch
```

## Finder and explicit launch

A no-arguments Finder launch reads only
`Contents/Resources/preview-launch.json`, with exactly:

```json
{"schema":1,"kind":"milagre-rust-preview","dataRoot":"/absolute/existing/dedicated-root"}
```

The Resources directory and existing root must be owned canonical mode-0700
directories. The config must be an owned regular single-link mode-0600 file of at
most 32 KiB. Symlinks, foreign fields, changed files and invalid paths refuse.
The helper returns `open <dataRoot>` to the existing retained-child launcher.
Explicit CLI `open`/`create` arguments keep their existing behavior. Another writer
for the same root is refused. Quit must finish actual owner/child cleanup before
another frontend opens that root; data is retained.

The saved runtime manifest decides the skills path. To use only the app's bundled
copy, root must create the dedicated runtime with `skillsDirectory` naming the
final installed `Contents/Resources/bundled-skills` path after that copy exists.
The packager reports both paths and never silently changes an existing selection.

## Another Mac

This is currently a macOS-only, native-architecture, ad-hoc-signed preview. It is
not notarized or a universal distributable. Check the package report's Mach-O
architectures against the receiving Mac; build on that Mac when they differ.
Cargo/Rust, Xcode Command Line Tools, Node and project build dependencies are build
prerequisites. The normal terminal/Git integration uses local `/bin/sh` and
`/usr/bin/git`.

The other Mac needs its own explicitly installed native Claude CLI and its own
authenticated selected account/config directory. Create a new private launch
manifest with that Mac's executable, HOME, OS user name, account path, model and
skills path, then create and validate its dedicated root locally. Do not copy
credentials or reuse this Mac's absolute launch/account paths. Opening existing
production Projects, paired phones and production account migration remain
separate acceptance gates.

## Installed normal lifecycle check

`installed-preview-check.cjs` starts only the explicitly named normal Preview with
no CLI arguments and background window policy. It verifies the fixed child receipt,
reads the dedicated Project/Chat twice without sending, and asks AppKit to terminate
that exact retained PID only after verifying its bundle URL. It requires the later
shell exit 0, empty stderr, the actual previously observed socket and temporary
profile/shell roots gone, and the Project/data retained. The immediate AppKit boolean
is informational: the cleanup-owning delegate cancels that immediate exit and routes
the request through the existing asynchronous owned Quit.

```sh
NODE_PATH=/explicit/build-dependencies/node_modules \
  node experiments/rust-desktop/installed-preview-check.cjs \
  "$HOME/Applications/Milagre Rust Preview.app" \
  "$HOME/Library/Application Support/Milagre Rust Preview/data"
```

The external Node process is a verifier, not the backend. Reports retain the exact
binary/observer hashes, receipt, observed saved-message IDs/hash and cleanup results
in a new private temporary directory. This does not assert rendered pixels or a new
real-provider turn. Native content evidence remains separate in CHAT-DESKTOP.md.

The initial installed real-provider turn reached Claude but failed at the selected
account's five-hour quota (reset 2026-11-12 07:00 UTC, 02:00 Toronto). Its failed
report remains `/private/tmp/milagre-installed-preview-check-Wh51wA/report.json`.
A separate early read/Quit check raced AppKit registration; a later check exposed
Tao's native termination bypassing `ExitRequested`, exiting 0 before owned cleanup
(`/private/tmp/milagre-installed-preview-check-qy2yVZ/report.json`). The dedicated
Chat binary now intercepts `applicationShouldTerminate:` and routes it through owned
Quit; actual normal-package lifecycle acceptance now passes both staged and installed copies. The ordinary
installed Rust/Electron applications were not changed by this fix.


Accepted lifecycle reports (2026-11-12 04:23 to 04:24 UTC):

- Staged: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-check-aovtZv/report.json`.
- Installed: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-check-xTsJlZ/report.json`.

Both normal no-args launches read the identical four saved IDs, send nothing, exit
0 without signals or stderr, and remove the actual socket/profile/shell roots
before exit observation. The dedicated Project and saved data remain. The two
last messages include the honestly retained rate-limit failure; these checks are
not new real-model completions. The earlier startup turn in this same root
completed before the quota was reached.

Installed shell SHA-256:
`47a0a31e05f7ec1737decc6c39d6a06448b23e4b450792b3ad0cb0dd6d702ee3`.
The unchanged combined runtime SHA-256:
`749214a258355d7f736c99ce61d1c2b17ec81d9004a2917d010ad6779662534c`.
The shell-only refresh report and retained prior bundle are under
`/private/tmp/milagre-preview-native-quit-package-ilq4rk9s/`. Source tests pass
49 with one optional ignored; strict normal-feature Clippy/format checks pass.
The normal build has no synthetic reduced motion or smoke commands. Native
real-content evidence was captured by the separate smoke build as documented.

The final observer also waits for captured stdout/stderr to close, rather than
accepting the earlier process-exit event while output could still be buffered.
Installed acceptance with that observer passes at
`/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-check-a99tH4/report.json`.
No binary change, model request or data mutation was needed for that verifier fix.

To refresh an existing Preview, stage without `--install`, validate that exact staged
app on the dedicated root, and confirm both copies are stopped. Retain the old
bundle under the private package stage, move the accepted copy into the Preview
path, verify its signature/hashes again, then rerun the installed lifecycle check.
Rollback restores the retained bundle. Do not replace either production app or
any data directory. Existing authorization to keep this separate Preview current
covers this reversible installation after passing checks.


## Latest normal runtime refresh

Runtime `85f4e539` adds real persistent paused-routine storage. It does not add a
scheduler. Source tests pass 118 runtime tests and the routine library's 83 tests,
16 integrations and one doctest (one optional ignored), with strict checks and
independent review. Use optional `--paused-routines` on the installed observer to
require actual `{enabled:true,executionSupported:false}` and a list containing no
enabled schedules. This optional check sends no model request or routine mutation.

The rebuilt normal package was accepted before replacement, its prior bundle
retained, then accepted again at the installed path:

- Staged: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-check-lfHzFw/report.json`.
- Installed: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-check-Soi2iI/report.json`.

Current installed shell SHA-256:
`5e5f1c5687a6365c625701cd06438cadadab62bb5f8f3f8cbb46de86c3f50e71`.
Current runtime SHA-256:
`2c0eb52b943b4f5ec0fa77cf297acf652ea933ca75db764a8a4e6782ada6c882`.
Package report and retained previous app:
`/private/tmp/milagre-rust-preview-package-bq9_btkh/`.
Its normal features remain `chat-desktop` and `chat-runtime`, with no smoke/fixture
entrypoints. The signed arm64 development app is approximately 96 MiB and is not
notarized or claimed as a release-performance benchmark.


## Final launcher-loss/startup/metadata refresh

Integration `3410109b` fixes the reproduced orphan after a launcher dies mid-turn.
The owner-loss path closes/saves the turn, reaps the native child and waits for
actual cleanup. Accepted-command drain timeouts retry with admission closed;
save/ownership failures remain explicit. Ordinary viewer disconnect and wire Stop
retain their existing semantics. Both actual controller-SIGKILL variants (including
closed stderr) pass over the fixed native child, followed by a real process reopen.
This is not a claim of live-provider crash or production-profile recovery parity.

The final normal staged and installed checks include optional `--metadata` in
addition to `--paused-routines`:

- Staged: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-check-LwETCC/report.json`.
- Installed: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-check-GC8XF3/report.json`.

Both send nothing, read the identical saved transcript, require actual metadata,
then observe native Quit, exit 0, drained/empty stderr, removed socket/profile/shell
roots and retained data. The existing root's repair preserves all old session fields,
summary times and native identity (`/private/tmp/milagre-preview-metadata-before-2rtjtqes/verified.json`).
Legacy missing status remains absent as Node does; fresh starters have Created.

Current installed shell SHA-256:
`125c2f591b65f1ea795d3f15322a4ed9e1fea7363eaf98a6891250410fd5c1fa`.
Current runtime SHA-256:
`862f4cd2f7a7d243da524852320554e09fd8d11835523a3a6a4fdfa956d70502`.
The current package and retained prior app are recorded under
`/private/tmp/milagre-rust-preview-package-gul8ira_/`.
Client `3410109b` additionally preserves typed root-busy refusal from this exact
child; old success receipts remain compatible. Matching pins were sent to GPUI.
No production app, host or mobile fingerprint was replaced.


## Installed real turn after quota reset

At 2026-11-12 07:00:29 UTC, the normal installed app completed the one authorized
no-tools Claude verification turn. `installed-preview-live-check.cjs --run` uses an
external Node wire verifier, not a Node backend or synthetic provider. Its hard
not-before gate precedes any app launch. The fresh marker streamed and two messages
were saved. A second no-args app/runtime launch read the exact transcript with zero
sends. Both native Quits exited 0 with drained empty stderr, actual profile/socket/
shell removal and retained data. No permissions were requested or approved.

Evidence: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-installed-preview-live-9Gumqg/report.json`.
Runtime PIDs were 81643 then 81859. The installed shell/runtime hashes remain the
accepted `125c2f59...fd5c1fa` and `862f4cd2...6d70502` recorded above. The earlier
quota failure is retained as failed evidence; this is a new run, not a reclassification.
Do not spend another real turn on subsequent heartbeats for this same check.

This verifies transport/stream/persistence/reopen and native lifecycle through the
installed process. It does not drive or capture a fresh composer UI interaction;
the separately documented native WebKit workflow evidence covers that scope.


## Sidebar refresh

Accepted `1b180e46` adds bounded actual Node-compatible Chat metadata behavior and
typed shared-client SidebarActions. The optional `--sidebar` verifier mode tests
Rename/Done/Reopen through the normal process, requires no existing schedules,
restores the original title/unread value and asserts unchanged summary/transcript.
It sends no model turn. It is API/lifecycle evidence, not a native menu screenshot.
Both staged bbLjHW and installed qIgZ8y reports pass under the private temporary
report directory prefix recorded in MIGRATION-STATUS.md. The installed app keeps
normal features and a retained prior bundle under
`/private/tmp/milagre-rust-preview-package-nbata4vt/`.

Current shell: `5a1f27edc8f2a02de841a9a67f5bbdc82173f8c9876bc3d17822567b5f554faa`.
Current runtime: `6054d7d6759262ec4d463380589261d954e1f8be79e75bb5d1a5d0be2142d70a`.
Earlier real-provider acceptance remains tied to its earlier binary hashes. The
Sidebar refresh spent no additional real turn. GPUI adoption is separate.

## Native preference persistence source checkpoint

The dedicated Chat shell now saves its React preference map in `data/native-tauri-preferences.json`, under the same explicitly admitted dedicated root. It owns a frontend-specific lock and revalidates exact child/root/manifest authority before reads and save acknowledgement. Files are private, bounded and atomically replaced with file and directory sync. Post-rename failures remain failed and fence further access until reopen. The core daemon remains the only Project writer. Ordinary installed Rust/Electron preferences and ephemeral app fixtures are unchanged; window state/WebKit stay temporary. This preference map cannot rewrite the captured launch account/model/credentials. See [CHAT-DESKTOP.md](CHAT-DESKTOP.md#dedicated-native-preference-persistence-checkpoint) for tests and limits. This source checkpoint does not itself refresh the installed Preview or claim a native settings pass.

Root subsequently accepted `dca7cdbc` and refreshed the installed Preview shell
at 04:10 Toronto. The accepted runtime remains `6054d7d6`; only the shell changed
to `e7c8663afd7da5f7489eeecbc85b74b17a07b93fb87cd7109eaba0ebee17730b`.
Normal staged `hpwUCo` and installed `jCrGGt` lifecycle observers pass with no
model sends, native Quit and actual cleanup. Reports use the same private
temporary-directory prefix as the preceding checks. Shell-only provenance and
retained rollback bundle: `/private/tmp/milagre-rust-preview-package-5vz_p3g4/shell-refresh-install.json`.
Preference values survive actual owned-child restart in the shell harness; these
normal-package observers do not click Settings or write a preference value.
