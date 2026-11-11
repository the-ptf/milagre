# Account selection and environment planning

This crate ports the saved metadata, Project/Link selection and environment filtering from `packages/core/src/accounts.cjs`, plus the captured account selection from `account-routing.cjs`. It is not a complete account manager or connected to the installed application. The pure model never performs I/O. The new Unix metadata service writes only a newly created isolated copy; neither layer reads a real profile, starts a CLI or reads credentials.

## API

- `Accounts::parse(Some(json))` validates saved metadata, keeps the existing account IDs, ignores unknown account fields and fills newly added providers with `default`. `None` means a genuinely missing file, never a failed read. Invalid saved data fails instead of dropping account selections.
- `selected`, `snapshot` and `scope_snapshot` keep computer defaults and Project/Link overrides separate. A removed scope-pinned account stays selected and gets the same missing-account message; it never silently falls back to another credential.
- `pin(scope)` produces an owned `Selection` for a session or service. Later changes to the account model cannot change those captured IDs. It does not implement status/model service caches yet.
- `environment_plan(provider, &Selection, context)` requires an explicitly captured session selection. `environment_for_account(provider, id, context)` handles explicit Settings row operations with no default fallback. Both preserve the default CLI environment, clears provider authentication overrides for added accounts, clears Antigravity's ambient variables and chooses the existing account directory layout. Both environment-bearing types redact their Debug output.
- `EnvironmentPlan::prepare` exposes its environment only after an owner callback handles all explicit preparations. Antigravity default-profile creation and MCP inheritance are listed as `Preparation` values. Their filesystem implementations are **not ported**. Production treats MCP inheritance as best effort, so a future owner callback must make that decision explicitly. The plan itself performs nothing.

`EnvironmentContext` is supplied by the owner; it never reads this process's environment. Directory resolution targets POSIX hosts. Scope keys include the production Windows-drive and remote-computer forms because those can be present on paired clients.

## Evidence

```sh
node experiments/rust-accounts/scripts/generate-conformance.cjs --check
cargo test --manifest-path experiments/rust-accounts/Cargo.toml
cargo clippy --manifest-path experiments/rust-accounts/Cargo.toml --all-targets -- -D warnings
```

The five original pure-model tests pass. The conformance test replays **300 calls from 15 profiles** through recorded production Node outputs: missing/valid/invalid metadata, defaults, captured selections, Project/Link/remote scopes, removed accounts, environment filtering and relative CLI config directories. A separate test proves failed preparation does not return credentials and Debug is redacted; another proves removed pinned accounts cannot switch implicitly. Two regression tests reject duplicate IDs across or within providers and verify that environment planning uses the Project pin and refuses removed accounts. The replay also compares MCP inheritance arguments and first Antigravity default-preparation root/home/directory arguments captured from the real Node functions. Repeated Antigravity preparation is intentionally left for owner memoization. Fixtures contain only synthetic values. Their generator uses disposable private directories, synthetic environments and injected CLI inspection; any attempt to spawn a process throws. Fixture regeneration compares the actual current Node implementation, not a second hand-written oracle.

## Unported and deliberate restrictions

- Production account persistence and full `accounts:add`, login/logout, installation/identity inspection, status/model cache invalidation, account switching during turns and usage routing. The isolated service below is a metadata checkpoint.
- MCP configuration inheritance, shared history links, default Antigravity preparation, account CLI inspection, OAuth and credential storage.
- Native Windows directory resolution; existing Windows and remote scope identifiers are preserved.
- Lone-surrogate JSON text is refused by serde_json. The owner has a lossless JSON module, but this crate has not adopted that representation.
- Duplicate IDs are refused across all providers because the profile directory is keyed by ID alone; Node currently accepts them. Antigravity preparation includes its accounts root and home, with memoization left to the owner.
- Malformed `selected` primitives are refused, although JavaScript can coerce some into an object with no choices. Invalid `directory` provider/ID arguments are also refused rather than becoming a path. No legitimate saved account is affected.

Pure-model snapshots are saved metadata with `state: unknown`. The isolated service can display trusted, supplied state observations; it performs no inspection itself. Neither is evidence of a real login. The Node owner still provides the running app's account service.

## Isolated metadata service checkpoint

Available on Unix: `AccountSandbox`, `AccountService`, `Observation`, `Readiness`,
`IdentityState`, `Availability`, `PendingCreation` and `AccountEvent`.

```rust
let copy = AccountSandbox::create(Some(saved_metadata_json))?;
let mut accounts = copy.open()?;
let request = accounts.begin_observation("codex", "default")?;
// Only trusted owner inspection may complete this request. Do not expose it to a renderer.
let ready = accounts.observed(request, IdentityState::Ready)?;
let snapshot = accounts.select("codex", "default", ready)?;
accounts.close();
```

This example supplies a synthetic readiness observation, not a working CLI inspector.
`create(provider, label, Availability)` likewise takes a trusted installation fact. It writes
only the new account's metadata and returns `PendingCreation`, whose pending work is explicitly
`prepare-private-profile` and `login`. It **must not be wired as a completed `accounts:add`**.
Node prepares config/history/profile files before persistence and then starts login. Those
operations remain unported here, including their rollback and asynchronous completion paths.
Custom CLI-problem messages, identity/email/plan inspection, signing-in cancellation and the
production installation cache are not implemented by this service.

`select` and `assign` consume readiness for the exact provider/account. Issue `Observation`
before asynchronous inspection; complete it through `observed`. Tickets and proofs are private,
non-cloneable values scoped to the service's random owner ID, metadata generation and most
recent inspection of that account. A newer inspection, any metadata commit, close, or another
service invalidates them. Wrong-account, stale and late results fail before changing metadata.
This is stricter than Node's mutable identity cache. Owners must arrange a fresh observation
when necessary and must never accept readiness claims from untrusted callers.

`assign(scope, provider, None, None)` clears an override without login. `remove` forgets only
metadata, resets a selected computer default, retains scope overrides and leaves profile files
untouched. The service refuses an empty scope when pinning (the pure model retains Node's empty-string fallback). Existing `Selection` values retain their original IDs; removed pins still fail
rather than falling back. `take_events` returns provider invalidations with owner ID and
metadata generation. The owner still has to apply them to status/model/session caches.
`owner_id` and `generation` let event consumers reject stale service events.

There is **no account-rename method or daemon channel in the production implementation**.
This port does not invent one.

### Capability and writer guarantees

- `AccountSandbox::create` accepts supplied metadata text, never a source/destination path.
  It creates a fresh 0700 directory under canonical `/tmp` or `/private/tmp`, independent of
  `HOME`, `TMPDIR`, CLI variables and production registries. There is no API to adopt an
  existing directory, so a production data/profile path cannot be admitted. Metadata is
  validated before creating files. A retained capability can reopen its own copy.
- `open` takes exclusive kernel `flock`s on a fresh root-directory descriptor and the writer
  lock file. Lock-file replacement cannot admit another writer while the first still holds
  the directory inode. No takeover, PID guessing, lock deletion or stale-lock recovery occurs.
  `close` and dropping the service release these locks even if capabilities, selections or
  observation tickets remain alive.
- Writes use held directory descriptors, `openat(O_NOFOLLOW|O_EXCL)`, a unique 0600 temporary
  file, file synchronization, then `renameat` in that same directory. Model state and changed
  events update only after rename succeeds. This is atomic metadata replacement, **not a
  power-loss durability guarantee**: the containing directory is not fsynced.
- Each mutation checks the pinned root/accounts inode, owner/modes, marker, lock-file inode and
  expected metadata bytes. Symlinks, hard-linked files and special files anywhere in the copy
  are refused. External metadata edits fail instead of being overwritten. Errors and service
  Debug never include file contents, marker values or raw OS errors. Metadata is capped at
  4 MiB; containment walks are capped at 8,192 entries and depth 32.
- These are cooperative single-writer guarantees, not protection against a hostile process
  of the same OS user swapping entries between the final check and rename. Existing production
  profiles with intentional history symlinks cannot be admitted by this metadata-only copy.
  The crate never recursively deletes a capability's root; callers own copy cleanup. Tests
  explicitly remove their fresh roots after dropping all handles. Process-restart admission
  of existing copies is not implemented.

Node discards unknown top-level/account fields and unknown computer-selection providers when
loading; the first subsequent mutation writes that normalized shape. Rust follows this exact
behavior rather than preserving fields Node discards. Existing valid scope mappings, ordering,
removed-account IDs, trimmed labels and UTF-16 label-length limits match Node. The pure model's
existing duplicate-ID rejection and mandatory pinned launch selection remain in force.

### New evidence

`generate-mutations.cjs --check` runs **6 actual Node traces with 42 mutation/read steps** in
private synthetic homes. Calls go through real `createAccounts`; fake CLI inspection and
in-memory EventEmitters replace login processes. No CLI, credentials, live account, network or
production profile participates. The recorder compares metadata projections of snapshots,
compact `accounts.json` bytes, file modes and provider changed events after every step.
Installation and identity decoration are explicitly excluded from that metadata projection;
this is not full account-service or full `add` parity.

**19 tests pass**: the original 5, one 42-step Node replay, 12 ownership/observation tests and
one injected pre-rename failure test. A child helper is normally ignored and invoked by the
cross-process flock test. Coverage includes same-process/thread/process writer exclusion,
lock replacement, close with retained capabilities/tickets, malformed reopen, readiness
account/owner/generation/inspection mismatches, removing an assigned account, retained profile
sentinels, root/directory symlinks, hard links, changed metadata/markers, permission changes,
nonblocking FIFO rejection, complete JSON during concurrent atomic replacements, and failure
after temporary-file synchronization without changing the old metadata or leaving a temp file.

```sh
node experiments/rust-accounts/scripts/generate-mutations.cjs --check
cargo test --manifest-path experiments/rust-accounts/Cargo.toml
cargo clippy --manifest-path experiments/rust-accounts/Cargo.toml --all-targets -- -D warnings
```

The service is not wired into a socket, owner actor, installed application or login flow.
