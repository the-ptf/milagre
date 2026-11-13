# milagre-usage (experiment)

Standalone offline Rust port of Milagre's usage limits, token transcript scan, pricing, cache and report logic.
Not wired into the runtime. All changes are confined to this crate; terminal/port code is unchanged.

## Source inventory and daemon contract

| Node source                               | Rust implementation                                                                              | Owner responsibility remaining                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `packages/core/src/usage.cjs`             | `limits` response/window mappers, offline `CodexUsage` protocol; `store::UsageReader`            | Credential lookup, HTTP, SDK control call, CLI process lifecycle and timeouts                          |
| `usage-cache.cjs`                         | `UsageStore` whitelist, import/export, reset expiry; `UsageState` backoff/last-good/checked time | Production disk capability and runtime save triggers                                                   |
| `antigravity-usage.cjs`, `kiro-usage.cjs` | `gemini_windows`, `parse_kiro_usage`                                                             | OAuth refresh, Google project discovery, Kiro CLI/cleanup and its 5-minute/3-second background wrapper |
| `token-usage-scan.cjs`                    | `Entry`, `Scanner`, version-3 `ScanCache`                                                        | Explicit copied transcript roots and persisted cache JSON                                              |
| `token-usage-pricing.cjs`                 | `slim_prices`, `price_of`, `Pricing` refresh state                                               | Catalog transport, production persistence and price-change event                                       |
| `runtime.cjs` usage commands              | `accounts::UsageAccounts` command envelopes, scope validation, account decoration and isolation  | Trusted account metadata/selection adapter and socket registration                                     |
| `token-usage.cjs`                         | `build_report`, `owner::TokenUsage`                                                              | Read-only Project/Chats home/Link metadata, owner lifecycle                                            |

`packages/core/src/runtime.cjs` registers:

- `usage:read(scope)` and `usage:cached(scope)`: `{ providers, accountKey }`, with each provider decorated with
  `account: { id, label, email? }`. Read emits `usage:changed({ scopeKey })`.
- `usage:accounts:read()` and `usage:accounts:cached()`: `{ generatedAt, accountKey: "all:...", providers }`.
  Every installed account appears; only ready accounts query usage. Each row adds `checkedAt?` and
  `account: { id, label, state, default?, email? }`. Read emits `usage:changed({})`.
- `token-usage:read(request)`: `TokenUsageReport`, including `refreshing`, `firstScan`, `pricing`.
  Changed scans or prices emit `token-usage:changed({})`.

`accounts::UsageAccounts` implements those four usage commands through injected account metadata and readers.
Wire `accountKey` remains `claudeId-codexId[-antigravityId]`; Kiro uses the connected default account.
Internal caches use the structural `Selection` triple, so delimiter collisions cannot share another account's data.
This corrects a latent Node cache-key ambiguity without changing the output key spelling. No socket handlers are registered.
Desktop and mobile consume the same provider/report shapes (`packages/shared/src/model.ts`, `usage.ts`,
`token-usage.ts`); this backend experiment changes neither client nor native fingerprint.

## Runtime API

JSON response APIs use `serde_json::Value` to preserve missing fields, nulls and existing camelCase names.

- `limits::{claude_windows, codex_windows, gemini_windows, parse_kiro_usage, claude_response, retry_after_ms}`:
  map supplied responses. `CodexUsage::new()`, `outgoing()`, `feed(bytes, now)`, `result()`, `fail(kind, now)`
  implement initialize/account/read/rateLimits exchange without a subprocess. When `result()` becomes Some,
  the owner must send SIGTERM to its isolated app-server, as Node does. `fail` kinds: missing, spawn, error,
  timeout, close. Provider response bodies and protocol errors never supply user-visible error messages.
- `UsageStore::{from_json, to_json, set_last, set_blocked, get, snapshot}`: in-memory quota store; only labels,
  percentages, reset timestamps, updated timestamp and positive banked-reset counts survive `set_last`.
  `UsageState::{begin, complete, cached, checked_at}` exposes deterministic reader transitions.
- `UsageReader::new(store, read, now, ready) -> Arc<_>`; `provider(name).await`, `read().await`, `cached(name)`,
  `checked_at(name)`, `store_json()`. All four providers have independently coalesced reads. Readiness is shared
  once, cancellation of a caller does not cancel the shared read. Injected reads return `Err(())` for generic
  failure; synchronous and asynchronous callback panics become generic failures. `store_snapshot(now)` exposes
  only the store's last-good data, as required by `usage:cached`. No environment is loaded internally.
- `CopiedRoot::new("claude" | "codex", absolute_copy_path)`, `Scanner::new(roots, ScanCache)`;
  `scan(now) -> io::Result<bool>`, `rows()`, `finished()`, `scanned_at()`, `cache().to_json()`.
  Import with `ScanCache::from_json`. The owner should run this synchronous single-owner scanner on its blocking
  pool, then serialize its exported cache where authorized. There is no default root or cache filename.
- `Pricing::{from_json, current, begin_refresh, complete, status}`: call `begin_refresh(now)`, run an injected
  catalog fetch only if true, then `complete(Some(catalog) | None, now)`. Daily refresh uses strict `> 24h`,
  failure retry uses `>= 15m`, and stale status uses `> 48h`, as Node does.
- `report::build_report(&input) -> Result<Value, String>` accepts Node's `{ rows, prices, projects, range, days,
  timeZone, now, worktreeRoot }` plus explicit `home` and `defaultTimeZone` (UTC when absent). No home/environment
  lookup occurs. `now` must be integer milliseconds in the calendar library's range.
- `TokenUsage::new(TokenUsageOptions, cached_rows, finished) -> Arc<_>`; `read(&request).await` provides the
  complete token report envelope, starts at most one injected scan, emits changes, and caches attribution for 30s.
  Options inject `scan`, `projects`, `prices`, `pricing_status`, `emit`, `now`, `home`, `worktree_root`,
  `default_time_zone`. `ScanResult` carries the scanner's complete rows and changed flag. Price refresh events
  remain the pricing owner's responsibility.
- `UsageAccounts::new(UsageAccountsOptions, HashMap<Selection, UsageStore>) -> Arc<_>`;
  `handle(command, &scope).await -> Result<Value, String>` accepts the four `accounts::COMMANDS` above.
  Use JSON null for an omitted scope. `stores()` exports `(Selection, cache JSON)` pairs, including seeds not
  yet used. Export order is unspecified. No filesystem read/write or account discovery occurs.

`UsageReader`, `TokenUsage` and `UsageAccounts` provide `shutdown().await` and `in_flight()`. The owner must await
shutdown before discarding them. Caller cancellation leaves shared work supervised; shutdown rejects new work,
requests cancellation and waits for injected callback futures to drop. Cancelling shutdown does not lose task
tracking; a later call can finish it. Panics clear in-flight/scan state and allow retry. Readiness rejection/panic is
ignored once, matching Node's readiness catch. Event callback panics are contained. These guarantees cover
cooperative futures owned by the crate, not synchronous blocking loops or tasks independently spawned by adapters.

## Required trusted account API

The runtime's rust-accounts adapter must supply these `UsageAccountsOptions` callbacks. Renderer input supplies
only the scope string; it must never supply account snapshots, selected IDs, environment maps or readers.

1. `scopes() -> MetadataFuture<Vec<String>>`: current authorized Project/Link keys, plus Chats home when present.
   Optional null scope means computer defaults. Empty/non-string and removed scopes retain Node's exact errors.
   Accounts commands ignore the scope argument, as Node does.
2. `selected(Option<&str>) -> Selection`: synchronously resolve Claude, Codex and Antigravity IDs for the validated
   scope. Capture happens after readiness for reads, immediately for cached commands. Kiro always uses `default`.
3. `list() -> MetadataFuture<AccountSnapshot>`: ordered provider groups `{ provider, selectedId, installed?, accounts }`.
   Accounts carry `{ provider, id, label, state, email?, message? }`; no credential/path/environment fields are needed.
   Scoped responses decorate the captured IDs from a fresh list after reading; removed IDs retain their ID and
   `Removed account` label. Accounts responses capture the list before reading, skip `installed: false`, query only
   `state: ready`, preserve order, and flag `default` from each group's selected ID.
4. `read(provider, pinned_id) -> ReadFuture`: resolve exactly that ID without consulting a mutable current selection.
   Return the existing provider result or `Err(())`. All-account reads pin unrelated providers to `default`, matching
   Node's independent cache combinations. The Kiro adapter still owns its shared 5-minute/3-second wrapper.
5. `ready`, `now`, `emit`: shared environment readiness, millisecond clock, and event sink. Cached commands never
   await readiness or emit changes. Scoped reads emit `usage:changed({scopeKey})`, or `{}` without a scope;
   all-account reads emit `{}`. Optional `read_usage_override` retains Node's test/demo bypass after scope validation.

Account metadata types are a narrow adapter contract, not a dependency on or implementation of rust-accounts.
The adapter must retain captured `Selection` together with explicit `EnvironmentContext.directory` when calling
rust-accounts. The parent reports account preparation checkpoint `e192330e` with additive service methods
`seed_synthetic_sources(&SyntheticSources)`, `prepare_creation(&mut PendingCreation)`,
`prepare_synthetic_antigravity_default()` and `inherit_synthetic_mcp(provider, id, Option<&str>) -> McpRefresh`.
`Accounts`, `Selection` and environment APIs remain unchanged. `PendingCreation.pending` is a variable-length
`Vec`; `preparation()` reports `Pending` or `Complete`. Preparation completion still leaves login pending and must
never imply readiness. Readiness comes only from the trusted account snapshot. These preparation methods are
synthetic-only; metadata-first creation and multi-file recovery remain account-service gaps. This crate does not
invoke preparation, inspect its state or derive a profile directory; usage persistence remains isolated.

## Isolated service facade

`service::UsageService::open(&TempCache, ServiceOptions).await -> Result<Arc<_>, String>` combines the owners above.
Options contain trusted `accounts: UsageAccountsOptions`, explicit `roots: Vec<CopiedRoot>`, `projects`,
`fetch_catalog`, `home`, `worktree_root` and `default_time_zone`. The account clock and event sink are also used for
token usage. No cross-crate account API changes are needed. No transport, root discovery or socket routing is added.
Use a Tokio runtime with timers; this crate enables the `time` feature.

- `handle(command, &argument).await` dispatches the four usage commands and `token-usage:read`. Usage arguments
  are scope/null; token arguments are the existing request object. Scope validation and selected-ID capture remain
  in `UsageAccounts`. Scan/pricing load before callbacks run. Quota loads lazily through additive
  `UsageAccounts::with_async_store_loader`, so an account first selected after startup still rehydrates its own cache.
  Startup and quota disk/JSON loads run on tracked blocking workers; cancelling their callers does not release the
  cache lease while a worker is running. A per-selection async gate coalesces first loads.
  `open_with_limits(..., ServiceLimits { cache_load_bytes })` overrides the default 64 MiB aggregate input-byte
  load budget shared across scan, pricing and quota slots. Loads serialize through a separate gate on blocking
  workers. Capacity is reserved under a short budget lock before reading; disk I/O, parsing and copying happen
  outside that lock. Success settles against current store ownership with a release-build capacity check; errors/panics release the reservation.
  Store destruction and budget inspection never acquire the loading gate.
  Disk loads charge actual bytes read, including whitespace, without a second serialization buffer. Pending snapshots
  use a bounded counting writer before cloning. Missing/malformed JSON consumes no retained charge. Quota charges
  follow loaded stores and their clones; abandoned blocking results release their charge. Concurrent loads of one
  slot share its maximum charge until the last store drops, even if the largest loaded store drops first.
  This conservative high-water rule avoids weakening the input bound while smaller owners remain. The two fixed
  scan/pricing slots stay reserved for the service lifetime. Removed-account readers still own their stores and retain their charges for Node compatibility.
  A new selection that exceeds the budget returns an error from `handle` with its remaining byte allowance and
  records a slot diagnostic; it is never memoized as empty. Existing readers remain usable. `loaded_cache_bytes()`
  reports retained charges plus any active load reservation. This bounds rehydration input, not allocator overhead,
  live callback output or total in-memory report state. Cache eviction and production UI presentation of errors remain owner work.
  Lazy-loader errors/panics do not poison readers or memoize an empty store and can be retried.
- Before invoking an injected provider reader, the facade rechecks the pinned ID against a fresh trusted account
  snapshot. Removed and non-ready IDs return unavailable without invoking the reader or substituting another ID.
  This is a deliberate stronger guard than Node's scoped path; the underlying `UsageAccounts` still preserves its
  original Node behavior. A read already started keeps its captured identity. Removed-account readers and last-good
  cached data remain available for Node's `Removed account` display and are not deleted from disk. Re-added or newly
  ready accounts are checked again on the next read; readiness failures are not negatively cached by this guard.
  Global environment readiness still uses Node's once-only catch behavior. Preparation is never treated as login.
- Token reads use `TokenUsage`'s existing 30-second scan/attribution behavior. A dedicated scanner thread coalesces
  scans over only the supplied copied roots and stages changed cache exports. `scan_cancellable(now,
  &ScanCancellation)` checks cancellation between roots, directory entries, files and 4 MiB reads. A cancelled
  scan retains only complete-line offsets and parsed rows; it does not advance the completed-scan timestamp.
  Directory cursors close on early return, and a later scan resumes safely. Pricing
  starts from supplied `fetch_catalog` on demand and stages successful refreshes. Price-change events follow
  committed pricing versions, including a later successful retry after the original flush failed; each observed
  committed version is notified once. No new catalog fetch is required for that event. `refresh_prices().await -> Result<bool, String>` explicitly waits for the same refresh
  and backoff policy; callback failure/panic clears refresh state, keeps old prices, and allows a later retry.
- `flush().await` waits for snapshots already staged, not arbitrary active provider/scan/catalog work.
  `dirty_count()` and `cache_diagnostics()` expose persistence state. Staging failures are diagnostic and never
  replace a successful usage result. `CacheOwner::changes()` reports dirty/failure state and pricing commit versions.
  A supervised watcher sleeps on cache notifications when clean. Failed saves use exponential backoff from one
  second with 20% jitter and a 60-second cap; success resets it. It retries while the service is open without
  restarting provider callbacks. Cached quota commands do not stage new writes. Stopped and panicked commands
  return distinct errors.
- **Request shutdown before releasing the service or stopping Tokio.** `shutdown()` seals commands, requests scan
  cancellation and suppresses new event delivery immediately, even if its future is never polled. It reports within
  two seconds as `ShutdownReport::Complete(Result<(), String>)` or `Pending`. This changes the previous
  `shutdown().await -> Result<(), String>` service API. `shutdown_report(Duration)` returns the same typed report
  using a caller-supplied deadline. **Never stop the runtime while a report is `Pending`.**
  Concurrent callers share the same finalizer. A timeout cancels only the wait; it never abandons a worker, releases
  the cache lease early, or permits a second owner. Call again to observe completion and keep Tokio running.
  The finalizer stops retries, cancels/awaits command/account/token/pricing callbacks, waits for blocking loads and
  the scanner to exit, exports all final state on a blocking worker, then closes the cache. Completed quota results
  survive cancellation of other providers. Each final export has its own panic/error boundary. Scanner and pricing
  mutex poison is recovered independently with diagnostics; a failed account export cannot skip either.
  Recovery at scan start, pricing start/read/completion/cancellation, and final export discards possibly partial
  working state, restores the last good snapshot, clears poison and records a diagnostic. Snapshots are captured
  from startup rehydration and successful scans/catalog refreshes, before staging. Scanner roots stay pinned;
  restored offsets and retained deleted-file history survive rescans even when a copied root is missing. Pricing
  retains its original timestamp and normal refresh/backoff rules; restoration does not claim fresh catalog data.
  Recovered state is not exported until a successful scan or catalog refresh, respectively. Poisoned shutdown
  preserves existing disk bytes; previously staged good snapshots still flush normally. A failed refresh cannot
  replace the last good cache with empty state. The facade retains one additional scanner snapshot and pricing
  value for recovery, outside the rehydration input-byte accounting; startup copies run on the blocking worker.
  Failed final writes remain in the capability for reopen/retry. Interrupted scans report `Scanner stopped`, without a fault
  diagnostic. Token-owner cancellation is distinct from a callback panic.
  Drop requests the same cleanup when a Tokio runtime is available, without exposing its result; it is a fallback,
  not a replacement for explicit shutdown. Active commands hold their own service references, so dropping an
  external Arc alone cannot revoke an outstanding command. Without a live runtime, final export is not promised;
  `dropped_without_export` is recorded on the retained temporary capability for the next owner's diagnostics.

Review verification: the residual export-poison and string timeout findings were confirmed. Budget failures already
propagated through command errors; the safety change adds byte context and fixes charges retained by cancelled
loads. Removed stores intentionally remain charged while owned. Scan errors are consumed by the background token
owner, not directly returned by token reads; explicit scan cancellation and token-owner shutdown now use stopped
errors. No new transport, routing, account discovery or production cache adoption is enabled.

Snapshot guards do not revoke an already-running read when metadata changes. Removed cache entries are retained
for compatibility, so privacy-driven cache deletion needs a separate explicit API. Copied roots are fixed for the
service lifetime; changing them requires closing and reopening the service. Blocking OS I/O cannot be forcibly
cancelled; a bounded shutdown report can remain `Pending` until its workers exit. Injected async callbacks must
remain cooperative, and synchronous callbacks must not block the Tokio worker. Events are fully quiescent when
shutdown completes.

## Temporary persistence API

`persistence::TempCache::fresh() -> io::Result<TempCache>` is the only disk capability constructor. It creates a new
private temporary directory; there is no arbitrary path constructor, production profile adoption, directory listing,
or credential discovery. Clone the capability to keep its directory alive across owner restarts. `open()` acquires
an exclusive writer lease; a second owner returns `AlreadyExists` until the first finishes shutdown.

`CacheOwner` exposes:

- `save_quota(&Selection, &UsageStore)` and `save_accounts(&[(Selection, Value)])` stage quota exports. Account JSON
  passes through `UsageStore` sanitization. Each structural selection gets a separate filename made from hex-encoded
  IDs, not Node's ambiguous dash-concatenated key. No ID is interpreted as a path. Names over 250 bytes are rejected;
  `save_accounts` validates every name before staging anything. The account API and wire key remain unchanged.
- `save_scan(&ScanCache)` and `save_pricing(&Pricing)` stage the existing v3 scanner and pricing JSON shapes.
  Quota bodies retain Node's provider map; prices retain `{ fetchedAt, models }`. An empty price state saves null.
  Saves are independent per file, not a transaction across caches. Request callbacks and transports stay injected.
- `load_quota(&Selection)`, `load_scan()` and `load_pricing()` rehydrate typed caches. Loads return pending latest
  data first, then committed disk data. Missing or invalid JSON becomes the existing empty cache state; I/O errors,
  symlinks and non-regular files return errors. Existing stricter scanner-shape validation still applies. Imported
  scanner paths never authorize reads; callers must separately supply explicit copied transcript roots. Reads and
  staged saves are capped at `MAX_CACHE_BYTES` (32 MiB per file). Disk reads/JSON parsing occur outside the state
  lock, then pending state is checked again. `diagnostics()` returns up to 32 deduplicated recent load issues
  (slot and reason, never file contents), including malformed JSON, invalid shapes, size limits and I/O failures.
  Malformed data still falls back to empty, matching Node; over-limit files return errors. Over-limit save snapshots
  are rejected before staging and are not part of failed-write retention. This is a per-file limit, not a global
  memory budget across all account selections.
- `flush().await -> Result<(), String>` waits for snapshots staged before the call; later stages may remain pending.
  A single dedicated worker coalesces bursts over 10 ms. Versions prevent an older successful write from clearing a
  newer staged value. Failed snapshots remain dirty without automatic retry loops; a new save, flush or shutdown
  retries them. `dirty_count()` reports pending slots. Errors do not prevent other slots from being saved.
  Worker batches/failed-state retention share immutable snapshots through `Arc`, avoiding deep copies per retry.
  Persistence mutex poisoning is deliberately recovered: they guard only owned maps/flags, and close must retain
  pending values even after a worker panic. The facade supplies the retry scheduler; standalone CacheOwner still
  retries only on an explicit save/flush/shutdown.
- `shutdown().await -> Result<(), String>` seals new saves immediately and attempts a final flush. Dropping or never
  polling the returned future does not cancel the worker. Drop also requests shutdown, but explicit shutdown is
  required to observe its result. Failed snapshots remain in the capability for the next owner to retry. A worker
  panic reports an error, releases the lease and retains dirty data. The worker keeps the directory alive until I/O
  ends; the last capability/owner/worker reference removes the temporary directory.

Runtime adapter order: load quota seeds for explicitly known selections, construct `UsageAccounts`, `Scanner` and
`Pricing`, and stage their exports after mutations. At close, first stop usage/token callbacks, export final account,
scan and price state, then await cache shutdown. A failed shutdown must be reported and the capability retained for
retry. No runtime hooks are installed by this crate. Node does not persist `checkedAt`, latest failed responses,
pricing retry timers or scanner `scannedAt`; these restart semantics are preserved.

Atomic writes use anchored Unix directory descriptors, no-follow exclusive temporary creation, write + file sync,
rename, then directory sync. Stale temp links are unlinked, never followed; existing hard-linked targets are replaced,
never truncated. Files are explicitly `0600` and the directory `0700`, without changing the process umask. Node's
original implementations use implicit modes (`0644` under umask `022`, `0600` under `077`) and drop failed save
attempts. Private modes and retained retries are intentional corrections. JSON shapes match Node; byte spelling of
floating-point numbers and object field order need not match.

Close/reopen tests represent owner restarts within the same fresh capability. Full process restart, persistent
production paths, cache adoption and multi-process writer locks remain gated. Failed writes cannot survive process
exit until a durable destination accepts them. This temporary capability intentionally cannot be reconstructed from
a path. Unix persistence is tested on macOS; Windows construction returns `Unsupported`.

## Scan and parity behavior

A scan reads only regular `.jsonl` files under the explicitly supplied roots, at Node's depth limit of five.
Every Unix path component is opened relative to a directory descriptor with `O_NOFOLLOW`; directory enumeration
uses `fdopendir`, and final file handles are checked as regular files. A symlink root/ancestor is skipped too:
supply the physical absolute path of a copied profile. Paths imported in cache entries never authorize reading.
Root selection is a caller trust boundary: the type cannot determine whether a directory is a copy. Hard links
are regular files, so a supplied copy must not contain hard links to live data. This crate neither discovers nor
copies live profiles. Tests create all profile contents themselves and never read credentials.

Preserved Node behavior:

- Claude counts a message/request pair once within the last 16 pairs, keeps custom titles over generated titles,
  and marks SDK sessions. Exact compact-JSON marker filtering intentionally skips spaced markers.
- Codex subtracts cache reads/writes from input, attributes subagent usage to the parent thread, skips copied
  pre-start history and non-increasing totals, and remembers the first session metadata/model across appends.
- Partial final lines wait for a newline; offsets are bytes, including split UTF-8. Reads use 4 MiB chunks.
  A shrunk file resets its entry; an archived Codex file keeps its basename identity. Deleted-file rows remain.
- Retention pruning is 400 days and runs only on entries processed by that scan, as in Node. An unchanged or deleted
  entry is not independently pruned. Same-size rewrites are not detected. Claude relative-path IDs and Codex
  basename IDs can collide across account roots; the first root wins. These existing semantics need a separate
  product decision before changing cache identity or invalidation.
- Reports include the 90-day calendar, hourly/day selection, cache savings and unpriced tokens, all provider/model
  splits, Project/Chats home/Link ownership, title fallback, outside folders, duplicate Project names, top 20 Chats
  and top 25 Projects with overflow totals. Reasoning is part of output, never added to billable token totals.

## Verification

On macOS arm64: **79 tests**, including 10 fixture replay suites with **109 Node cases**, plus **19 original Node
command traces**, account isolation, callback lifecycle and **19 persistence tests**, plus **29 service tests**. Fixtures come from the original Node functions (selected existing report tests run with assertions), not
from Rust output. Codex is an EventEmitter fixture; Claude uses supplied synthetic credential text and a fake fetch.
No provider process, keychain access or network transport is available to the fixture sandbox.

```sh
TZ=UTC node experiments/rust-usage/scripts/generate-conformance.cjs
TZ=UTC node experiments/rust-usage/scripts/generate-account-traces.cjs
TZ=UTC node experiments/rust-usage/scripts/generate-persistence.cjs
cargo test --offline --manifest-path experiments/rust-usage/Cargo.toml
cargo clippy --offline --manifest-path experiments/rust-usage/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/rust-usage/Cargo.toml --check
```

The expected `Milagre couldn't refresh model prices: fixture` warning comes from the scripted failed-price case.
`tests/fixtures/conformance.json` records window mapping, HTTP responses, Codex outgoing messages/results,
transcript carry/rows, quota/store traces, backoff, price refresh boundaries, reports and physical incremental scans.
`tests/fixtures/accounts.json` captures command envelopes, validation errors, provider calls and emitted events
from the original runtime command bodies in a VM. Account metadata/readers are synthetic; cache persistence is
stubbed to throw if accessed. Command fixtures compare exactly. `tests/fixtures/persistence.json` uses the actual
Node disk implementations in guarded fresh temporary directories: three saved cache shapes, two process-local
umasks, restart results and four malformed inputs. Scanner fixture warnings are fatal. Rust checks compare those
outputs and cover actual filesystem failures, retry retention, coalescing, cancelled waits, worker panic, single-writer
leases, temp cleanup, symlink/hard-link replacement and incremental scans after reopen. Service tests replay the
first 16 existing command traces for available account IDs, then independently cover the stronger removed/non-ready
account guard, startup rehydration, callback cancellation, final-export ordering, retries and diagnostics. Additional
persistence checks cover oversized/sparse files, malformed shapes, poison recovery and a blocked disk read that does
not prevent staging a newer value.
Object keys and optional/null fields compare exactly; numeric values use a relative tolerance of `1e-12` because
JavaScript has one numeric type and floating arithmetic may differ in the final bits.

Safety checks cover shared readiness, cancellation, isolated provider failure, no-follow roots/files/ancestors,
cache paths that cannot grant read access, malformed cache import, large lines, UTF-8 tails, duplicate roots,
retained deleted files, recent-message eviction, pruning, Codex final-state stability, and token-owner scan/cache
boundaries. Account tests cover selection changes during reads, removed identities, unrelated-default pinning,
legacy key collisions, unused seed retention, cached/readiness separation, override behavior, shutdown cancellation,
and synchronous/asynchronous callback panics. All scan writes in tests are in fresh temporary directories, cleaned when tests finish.

## Exact gaps and boundaries

1. No live provider access, runtime routing, production trusted account adapter, profile discovery, account auto-switching,
   metadata-store loading, production cache persistence, SDK bridge, CLI supervision or network fetch. Use injected owners;
   this checkpoint does not claim an end-to-end live usage migration.
2. Scanner is implemented for Unix and tested on macOS only. Windows scanning explicitly returns Unsupported.
   Linux descriptor code is present but unexecuted here. Injected provider/parser/report tests are platform-neutral.
3. Date parsing covers RFC3339, RFC2822/HTTP-date, ISO dates and zone-less ISO datetime (treated as UTC).
   V8's permissive legacy date coercion and host-local zone-less datetime interpretation are not reproduced.
   Invalid/reset date handling matches fixtures. Invalid out-of-range Codex reset timestamps become null instead
   of throwing a JavaScript RangeError. Isolated UTF-16 surrogate truncations become replacement characters in Rust.
4. Timezone names/aliases are captured from Node v24.13.0, ICU 77.1 (tz 2025b) in `src/timezones.json`; the input
   name list comes from bundled Jiff tzdb 2026e (`scripts/timezone-names.json`). Jiff supplies date boundaries from
   2026e, so historical/future rules changed between those databases can differ outside the fixture dates.
   IANA zones, including case/aliases, are mapped; numeric-offset Intl timezone strings are not supported.
5. Scanner errors opening missing/unreadable roots/files skip them; errors during an opened file read return Err
   (Node logs and continues). Scanner persistence is explicitly staged through the temporary cache owner; no live
   scanner or runtime hook is installed. Malformed scan-cache structure fails closed to empty, more strictly than
   Node's shallow cache validation. Background
   task supervision is implemented; real provider transports and their process cleanup remain gated.

## Optional trusted quota fixture adapter

[fixtures/trusted-accounts](fixtures/trusted-accounts/README.md) contains a default-disabled nested
crate that owns the real committed registry/accounts services in fresh synthetic copies. Its
`fixture-adapter` feature depends on those exported crates; the base crate adds only the optional
`fixture-admission` check/commit hook. Real generations, readiness observations and descriptor-pinned
paths reject removed or revoked cached/late quota results before state/event acceptance.

Run `python3 experiments/rust-usage/scripts/check-trusted-fixture.py` from the repository root for
the verified offline disposable export, 11 adapter tests and nine additional original Node command
traces. The nested README records exact hashes, API, limits and remaining production/scanner gates.
