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
