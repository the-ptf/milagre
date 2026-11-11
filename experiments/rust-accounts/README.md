# Account selection and environment planning

This crate ports the saved metadata, Project/Link selection and environment filtering from `packages/core/src/accounts.cjs`, plus the captured account selection from `account-routing.cjs`. It is not a complete account manager or connected to the installed application. The pure model never performs I/O. The new Unix metadata service writes only a newly created isolated copy; neither layer reads a real profile, starts a CLI or reads credentials.

## API

- `Accounts::parse(Some(json))` validates saved metadata, keeps the existing account IDs, ignores unknown account fields and fills newly added providers with `default`. `None` means a genuinely missing file, never a failed read. Invalid saved data fails instead of dropping account selections.
- `selected`, `snapshot` and `scope_snapshot` keep computer defaults and Project/Link overrides separate. A removed scope-pinned account stays selected and gets the same missing-account message; it never silently falls back to another credential.
- `pin(scope)` produces an owned `Selection` for a session or service. Later changes to the account model cannot change those captured IDs. It does not implement status/model service caches yet.
- `environment_plan(provider, &Selection, context)` requires an explicitly captured session selection. `environment_for_account(provider, id, context)` handles explicit Settings row operations with no default fallback. Both preserve the default CLI environment, clears provider authentication overrides for added accounts, clears Antigravity's ambient variables and chooses the existing account directory layout. Both environment-bearing types redact their Debug output.
- `EnvironmentPlan::prepare` exposes its environment only after an owner callback handles all explicit preparations. Antigravity default-profile creation and MCP inheritance are listed as `Preparation` values. Their synthetic-copy implementations are described below; they cannot be applied to arbitrary paths from a plan. Production treats MCP inheritance as best effort, so a future owner callback must make that decision explicitly. The plan itself performs nothing.

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
- Admission of existing real profiles, real shared history, account CLI inspection, OAuth and credential storage. Config/history/default preparation below is restricted to synthetic copies.
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
Node prepares config/history/profile files before persistence and then starts login. Synthetic preparation is now available as a separate explicit step below. The legacy metadata-only method keeps this ordering; `create_prepared` below finishes the synthetic profile before publishing metadata. Neither starts login.
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
  file in a private staging directory, file synchronization, then `renameat` into the held target directory. Both directories are synchronized. Model state and changed events update only after success. This provides process-crash recovery; hardware power-loss durability has not been tested.
- Each mutation checks the pinned root/accounts inode, owner/modes, marker, lock-file inode and
  expected metadata bytes. Unregistered symlinks, hard-linked files and special files anywhere in the copy
  are refused. The preparation API can mint internal history/skill links with pinned identities. External metadata edits fail instead of being overwritten. Errors and service
  Debug never include file contents, marker values or raw OS errors. Metadata is capped at
  4 MiB; containment walks are capped at 8,192 entries and depth 32.
- These are cooperative single-writer guarantees, not protection against a hostile process
  of the same OS user swapping entries between the final check and rename. Existing production
  profiles with intentional history symlinks cannot be admitted by this copy capability.
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

**19 metadata/model tests pass**: the original 5, one 42-step Node replay, 12 ownership/observation tests and
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

## Synthetic profile preparation checkpoint

Available only on the same Unix `AccountSandbox` capability. No source/destination paths are
accepted. `SyntheticSources` contains supplied fixture text and two booleans for empty Gemini
skill folders. Debug redacts all contents. It never reads ambient HOME, CLI config locations,
credentials or existing profiles. Keep these APIs owner-only; they are not renderer channels.

```rust
let copy = AccountSandbox::create(None)?;
let mut accounts = copy.open()?;
accounts.seed_synthetic_sources(&SyntheticSources {
    codex_config: Some("# synthetic config\nmodel = \"fixture\"\n".into()),
    ..Default::default()
})?;
let mut pending = accounts.create("codex", "Test account", Availability::Installed)?;
assert_eq!(pending.pending(), ["prepare-private-profile", "login"]);
accounts.prepare_creation(&mut pending)?;
assert_eq!(pending.preparation(), PreparationStatus::Complete);
assert_eq!(pending.pending(), ["login"]);
accounts.close();
```

`prepare_creation` verifies a private owner/provider/account ticket against current metadata.
Changing its public account JSON, removing the account, using another service or closing the
service refuses preparation. A successful repeat is a no-op. Status describes the successful
preparation checkpoint, not a live filesystem monitor or login. It never sets identity to Ready.
The copy's capability retains the completed-profile/link ledger across service reopen without
retaining the writer lock; old creation tickets remain invalid under the new service owner.

- **Codex:** creates the six production history/skill folders under the synthetic `.codex`,
  shares them through checked internal symlinks, copies `AGENTS.md` once, and copies config text
  with root `cli_auth_credentials_store = "file"`. Root `sqlite_home` is retained when supplied,
  otherwise it names the synthetic source. Root setting detection follows JavaScript line
  anchors, including CR, U+2028 and U+2029. TOML comments, unknown sections and table-scoped
  values follow Node's text splice, not a semantic TOML reserializer. MCP sections are inherited
  before preparation completes, matching the environment setup immediately before Node login.
- **Claude:** shares the five production history/skill folders and copies `CLAUDE.md` once.
  `settings.json` uses strict JSON, removes only root `apiKeyHelper` and writes Node-compatible
  compact JSON. Unknown fields survive; JSON comments are invalid in production and are refused.
  Source `.claude.json` is never copied, so source identity cannot become account identity.
  The target file is absent before login; MCP refresh correctly does nothing then.
- **Antigravity:** `prepare_synthetic_antigravity_default` creates the private default profile
  once. Optional synthetic Gemini skill folders are linked only when present. Added profiles
  share conversations/brain with that default. No token, ACP process, OAuth or browser action
  occurs. No files are created in a real `.gemini` directory.
- **MCP refresh:** `inherit_synthetic_mcp(provider, id, source_text)` requires an already prepared
  added Codex/Claude account. It accepts supplied synthetic source text, reads only the checked
  target inside the copy, preserves account-only servers, updates source-owned servers and
  removes recorded top-level servers removed from the source. Claude project-local removals
  remain untracked, matching Node. Unknown target fields/identity remain unchanged. No-op files
  keep their original formatting and inode. The record uses Node's sorted names and newline.
  Explicit refresh returns `McpRefresh { config_changed, record_changed }`; parse/write errors
  propagate instead of being silently swallowed as Node's environment builder does.
- **Containment:** links are minted with descriptor-relative operations only after opening the
  source directory without following symlinks. Every operation verifies the link's exact target,
  source inode and link inode, plus the existing root/lock/metadata checks. Removing a registered
  link, replacing it even with an equivalent link, swapping its source, adding an unregistered
  alias or introducing a hard-linked file refuses subsequent operations. Existing unprepared
  profile directories and source homes cannot be adopted or overwritten. Registered links are
  not followed during containment scans. Files are 0600; created directories are 0700 (stricter
  than Node's ordinary history mkdir/copy modes).

### Preparation evidence and remaining gaps

`generate-preparation.cjs --check` records **23 actual production Node add preparations and
30 MCP transformations**. Every source is a new synthetic home. Injected spawn/sign-in hooks
throw before launching anything, after the actual preparation/environment code ran. Assertions
compare profile trees, link targets, config/instruction bytes, MCP record bytes and inode changes.
The Rust suite also checks private modes, copy-once settings versus refreshed MCP, shared history,
independent malformed-provider config, stale/modified tickets, repeated preparation, close/reopen,
retained removed profiles, link/source replacement, external aliases, hardlinks and missing links.
At that checkpoint, the six preparation tests brought the crate to **25 passing tests**, plus its normally ignored child-lock
helper invoked by the flock test. Existing 300-call and 42-step Node fixtures still pass.

```sh
node experiments/rust-accounts/scripts/generate-preparation.cjs --check
cargo test --manifest-path experiments/rust-accounts/Cargo.toml
cargo clippy --manifest-path experiments/rust-accounts/Cargo.toml --all-targets -- -D warnings
```

This is not full `accounts:add` or environment-service parity. The legacy metadata checkpoint
persists first; preparation follows separately. `create_prepared` and the recovery API below
provide profile-before-metadata ordering and interrupted-preparation recovery inside the fresh
copy. Live MCP config-plus-record refresh remains two atomic file updates rather than one
transaction. Sources seed once; source config edits in tests are synthetic. A real login would
write Claude's target `.claude.json`; only fixture tests do so here.

No real profile admission, live credential access, login, installation/identity inspection,
Windows junctions, provider processes, usage cache integration or runtime routing is implemented.
The existing `EnvironmentPlan` API remains unchanged and requires an explicit owner preparation
callback; the new synthetic APIs deliberately cannot apply arbitrary plan paths. The fixture
source home uses fixed `.codex`, `.claude` and `.gemini` paths; configurable real CLI homes are
still unported. Both Claude MCP source-location variants feed the same supplied text transform,
but no real `CLAUDE_CONFIG_DIR` discovery occurs. Lone-surrogate JSON, overflowing JSON numbers
and more than 128 nested JSON levels remain refused by serde_json. Existing account readiness
observations remain trusted owner inputs without an age limit, not a credential inspector.

## Journaled creation and recovery

The additive owner-only path is `create_prepared(provider, label, Availability)`. It records an
immutable private file plan, finishes the synthetic profile, then publishes the account row.
The result still reports `pending() == ["login"]`, and identity stays unknown. This follows
Node's profile-before-metadata ordering. It also finishes MCP inheritance before publication;
Node performs that last part in the environment setup immediately before login. Final profile
bytes match the same 23-case Node fixture through both creation APIs.

The legacy `create` method remains metadata-only for existing callers. Its interrupted
`prepare_creation` now resumes a journaled plan rather than rejecting its own partial directory.
A pre-existing directory without a matching signed plan remains refused.

```rust
let mut accounts = copy.open()?;
// Sources can also resume from their saved text after an interrupted seed call.
accounts.resume_synthetic_sources()?;
for pending in accounts.recoverable_creations()? {
    let provider = pending.account["provider"].as_str().unwrap();
    let id = pending.account["id"].as_str().unwrap();
    let ready_to_login = accounts.recover_creation(provider, id)?;
    assert_eq!(ready_to_login.pending(), ["login"]);
}
// An existing metadata-only account uses a new ticket scoped to this reopened service.
let ready_to_login = accounts.resume_preparation("codex", existing_id)?;
```

`recoverable_creations` lists only saved creation plans awaiting metadata publication, with
`PreparationStatus::Pending` or `Complete`. It never claims authentication. A crash after the
metadata rename but before its journal acknowledgment is repaired by checking the exact saved
account row, not appending it twice. `recover_creation` is idempotent for an already published
account. Removal records a forget intent before dropping metadata, so recovery cannot resurrect
an explicitly forgotten account. A failed removal can leave its metadata present and its
creation forgotten; retrying removal resolves that state without deleting profile files.
Unpublished reservations count toward the 20-account limit. `preparation_status` checks the
current copy and reports file-plan completion for an existing account.

The private `.preparation-journal.json` has an authenticated envelope, versioned schema,
per-creation plans, step cursors, directory identities, link intents and publication state.
Journal revisions cannot move behind the last revision observed by the retained capability, so
restoring an older authenticated journal cannot undo a recorded removal. MAC verification uses
the hash library's constant-time equality.
The random authentication key lives only in the original capability; no public export,
deserializer or caller-path admission exists. The journal is capped at 64 MiB, while individual
text files remain capped at 4 MiB. A completed plan is retained for identity verification;
retry of an unfinished plan uses its saved bytes even if the synthetic source later changes.
A repeated seed with different inputs is refused. `resume_synthetic_sources` uses saved inputs
without requiring the caller to retain them.

Each filesystem action has a preceding persisted plan or link intent. Journal writes and
profile/metadata replacement use private temporary files, file synchronization, atomic rename
and directory synchronization. A replay accepts an already-created planned file only when its
bytes match; it does not overwrite conflicting content. Recorded directory/link identities and
source targets must match. A link created just before a crash can be adopted only through its
authenticated write-ahead intent and exact internal target/source identity. Whole-copy scans
still reject unregistered links, hardlinks and special files. Unknown ordinary files and the
original copy marker are preserved. Journals and abandoned private staging temporaries are
retained, not recursively cleaned; recovery never guesses that unrelated content is disposable.
A sufficiently large number of interruptions can hit the existing 8,192-entry containment cap.

### Recovery evidence and limits

The recovery matrix injects errors at every logical step boundary and at each distinct journal,
file, link, metadata and publication I/O stage. A separate matrix executes the Rust test binary
as a child and calls `_exit(72)` at each I/O stage, skipping destructors entirely. The parent
reopens its retained capability, reconstructs only journal-authorized links, resumes and compares
the final profile/metadata tree with an uninterrupted run. Cases cover source seeding, Codex,
Claude, Antigravity default/added profiles and profile-before-metadata creation. Extra regressions
cover conflicting files, journal tampering, exact-once publication, explicit removal, reserved
account limits and immutable source snapshots. Existing Node conformance and containment tests
remain in the suite. The matrix covers **289 injected-error points and 76 abrupt child exits**;
additional regressions reject modified authentication, unsafe journal paths and journal rollback.
The crate now has **32 passing tests**, with two normally ignored helper tests invoked only by
the lock/crash fixtures.

After an I/O error, close and reopen the service before retrying. An error after a metadata
rename can leave the old in-memory model stale; reopen reads the durable metadata and reconciles
its publication journal. The journal makes partial preparation recoverable, not invisible or
transactionally rolled back. A conflicting external edit remains a visible error and is never
silently repaired. Sources and profile creation are journaled; later arbitrary MCP refreshes
still use the earlier two-file semantics.

The crash fixture transfers inherited copy descriptors and the private key through a test-only
pipe. Production has no process-restart admission API: recovery requires the original fresh-copy
capability to remain available, for example in a supervising owner. Restarting the whole owner
without that capability, machine power loss, Windows, real profile adoption, credentials and
login remain unimplemented or unverified. This is still an isolated migration checkpoint.
