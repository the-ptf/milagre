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
