# milagre-usage (experiment)

Standalone offline Rust port of Milagre's usage limits, token transcript scan, pricing, cache and report logic.
Not wired into the runtime. All changes are confined to this crate; terminal/port code is unchanged.

## Source inventory and daemon contract

| Node source                               | Rust implementation                                                                              | Owner responsibility remaining                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `packages/core/src/usage.cjs`             | `limits` response/window mappers, offline `CodexUsage` protocol; `store::UsageReader`            | Credential lookup, HTTP, SDK control call, CLI process lifecycle and timeouts                          |
| `usage-cache.cjs`                         | `UsageStore` whitelist, import/export, reset expiry; `UsageState` backoff/last-good/checked time | Atomic disk persistence and shutdown flushing                                                          |
| `antigravity-usage.cjs`, `kiro-usage.cjs` | `gemini_windows`, `parse_kiro_usage`                                                             | OAuth refresh, Google project discovery, Kiro CLI/cleanup and its 5-minute/3-second background wrapper |
| `token-usage-scan.cjs`                    | `Entry`, `Scanner`, version-3 `ScanCache`                                                        | Explicit copied transcript roots and persisted cache JSON                                              |
| `token-usage-pricing.cjs`                 | `slim_prices`, `price_of`, `Pricing` refresh state                                               | Catalog transport, persistence and price-change event                                                  |
| `token-usage.cjs`                         | `build_report`, `owner::TokenUsage`                                                              | Read-only Project/Chats home/Link metadata, owner lifecycle                                            |

`packages/core/src/runtime.cjs` registers:

- `usage:read(scope)` and `usage:cached(scope)`: `{ providers, accountKey }`, with each provider decorated with
  `account: { id, label, email? }`. Read emits `usage:changed({ scopeKey })`.
- `usage:accounts:read()` and `usage:accounts:cached()`: `{ generatedAt, accountKey: "all:...", providers }`.
  Every installed account appears; only ready accounts query usage. Each row adds `checkedAt?` and
  `account: { id, label, state, default?, email? }`. Read emits `usage:changed({})`.
- `token-usage:read(request)`: `TokenUsageReport`, including `refreshing`, `firstScan`, `pricing`.
  Changed scans or prices emit `token-usage:changed({})`.

The Rust runtime must retain scope validation, selected-account capture, per-account reader/store isolation and
account decoration. Cache keys remain `claudeId-codexId[-antigravityId]`; Kiro uses the connected default account.
Those runtime/account functions are inventoried, **not implemented by this crate**. No socket handlers are registered.
Desktop and mobile consume the same provider/report shapes (`packages/shared/src/model.ts`, `usage.ts`,
`token-usage.ts`); this backend experiment changes neither client nor native fingerprint.

## Runtime API

All JSON APIs use `serde_json::Value` to preserve missing fields, nulls and existing camelCase names.

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
  failure; callbacks must not panic. No environment is loaded internally.
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
  remain the pricing owner's responsibility. The Tokio runtime owns these background tasks until shutdown.

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

On macOS arm64: **18 tests**, including 10 fixture replay suites with **109 Node cases**, plus 8 safety/concurrency
checks. Fixtures come from the original Node functions (selected existing report tests run with assertions), not
from Rust output. Codex is an EventEmitter fixture; Claude uses supplied synthetic credential text and a fake fetch.
No provider process, keychain access or network transport is available to the fixture sandbox.

```sh
TZ=UTC node experiments/rust-usage/scripts/generate-conformance.cjs
cargo test --offline --manifest-path experiments/rust-usage/Cargo.toml
cargo clippy --offline --manifest-path experiments/rust-usage/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/rust-usage/Cargo.toml --check
```

The expected `Milagre couldn't refresh model prices: fixture` warning comes from the scripted failed-price case.
`tests/fixtures/conformance.json` records window mapping, HTTP responses, Codex outgoing messages/results,
transcript carry/rows, quota/store traces, backoff, price refresh boundaries, reports and physical incremental scans.
Object keys and optional/null fields compare exactly; numeric values use a relative tolerance of `1e-12` because
JavaScript has one numeric type and floating arithmetic may differ in the final bits.

Safety checks cover shared readiness, cancellation, isolated provider failure, no-follow roots/files/ancestors,
cache paths that cannot grant read access, malformed cache import, large lines, UTF-8 tails, duplicate roots,
retained deleted files, recent-message eviction, pruning, Codex final-state stability, and token-owner scan/cache
boundaries. All scan writes in tests are in fresh temporary directories, cleaned when tests finish.

## Exact gaps and boundaries

1. No live provider access, runtime routing/account decoration, profile discovery, account auto-switching,
   metadata-store loading, cache persistence, SDK bridge, CLI supervision or network fetch. Use injected owners;
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
   (Node logs and continues). No write queue/idle flush exists because the crate never writes caches. Malformed
   scan-cache structure fails closed to empty, more strictly than Node's shallow cache validation. Background
   callbacks must return errors rather than panic; shutdown/cancellation supervision belongs to the runtime.
