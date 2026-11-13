# Private schedule-store state checkpoint

Status: root validation passed. Independent source review found no P1/P2 after the
identity-domain and signed-zero corrections, within this documented bounded checkpoint.
Scope was agreed in `STORE-PLAN.md` at `7f9a2b66`, on the accepted cron baseline
`2e28e486`. This file records the implementation and its limits separately from the frozen
plan and the earlier cron evidence.

## Implemented boundary

The private model in `src/store` implements schedule Routine and Heartbeat CRUD, due/manual
claims, finish, completion, expiry, pause/error metadata, recovery, retention and maintenance.
It also implements the dependent Run observations and Chat/title metadata operations listed
in the plan. The module is compiled by library tests and the explicit `store_fixture`
example. A normal build of the library exposes only the accepted cron API. There is no
public store owner, commit method, durability callback or dispatch capability.

The model owns one logical state plus its indexes and maintenance time. Mutations copy that
state, apply the transition, perform due maintenance, check the candidate and its returned
values/effects, and serialize a prospective image before publication. A private test failure
point runs immediately before publication. Failure retains current state, indexes,
maintenance time and last published image, and releases no effects. ID-source calls already
made stay consumed, as in the Node factory. The publication is an in-memory assignment;
it proves no filesystem or process-crash guarantee.

Claims advance from the supplied claim instant, with one missed record when more than a
minute late. There is no backlog replay. Duplicate finish cannot recount a Run. Recovery
fails interrupted ordinary Runs, increments a Routine's failure streak once per recovery,
and advances overdue schedules without creating missed Runs. A schedule that has no next
run pauses while other due rows continue. The model preserves the distinction between these
store rules and the scheduler's overlap, busy-Chat, expiry-before-claim and dispatch rules.

Effects are data, released only after successful publication: grouped `purged`, `dropped`
and `ended` records in Node order. They do not execute callbacks. Load-time upkeep changes
the logical view and reports effects but retains the supplied file image until a later
write-producing mutation, matching Node's constructor. Every oracle observation reports
both that logical view and the last file bytes.

## Bounds and explicit refusals

| Resource              | Bound                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Input/state image     | 4 MiB serialized bytes                                                     |
| Aggregate JSON values | 131072 scalar, array and object nodes, including unknown retained metadata |
| Structure/text        | Depth 32; 16 KiB per otherwise unbounded encoded metadata string or key    |
| Collections           | 64 Routines, 4096 total Runs, 4096 permanent removal tombstones            |
| Fixture commands      | 4096 bounded NDJSON lines per process                                      |

A lexical pass counts JSON value tokens and nesting before parsing. Semantic limits are
checked before candidate cloning, and aggregate candidate/result/effect limits are checked
before publication. Exceeding a bound refuses the whole mutation, including earlier claims
in a batch or maintenance changes. Running Runs and tombstones are never evicted to admit
another mutation. The byte and node caps are **not a heap or RSS bound**: decoded maps,
strings, parser scratch, allocation overhead and candidate/result copies require more memory.
Parsing can allocate its bounded decoded tree before semantic text/collection checks finish.

The accepted `now` and explicit `at` inputs use the cron integer-ms range, from
`-2208902400000` through `253118217599999` (1900-01-02 through 9990-12-30). Stored future
`nextRunAt` and `expiresAt` values may extend through `253402300799999`
(9999-12-31T23:59:59.999Z), so a valid upper-input-bound cron result or default expiry can
be retained. This does not widen the operation-time domain: attempting to claim at that
later stored instant is refused. Derived expiry arithmetic is checked before publication.
Other semantic times remain within the operation-time domain. Counter fields must be finite
and have absolute value no greater than 9007199254740991.

Compatibility refusals are explicit and are kept outside parity totals:

1. Mixed event/flow snapshots and methods, including event-bearing Runs or nonempty
   queue/seen/rejection/cursor/PR-snapshot maps. No supported subset is extracted and made
   writable. Fallback configuration is retained as metadata; provider retry is absent.
   Reserved `event`, `flow` or `rejected` Run fields refuse import whenever present, even
   when their value is null or false.
2. ICU-only `SystemV/*` zones, over-limit cron inputs, unpaired UTF-16 in cron/cadence/zone
   strings, and out-of-domain operation times. Unknown ordinary zones and impossible cron
   expressions in structurally valid seeds still follow Node's pause/error path.
3. Invalid/corrupt/wrong-version snapshots, duplicate Routine/Run identities and the
   prototype-sensitive identities: the own names of Node's Object.prototype, plus
   `prototype`. The guard covers Routine/Run IDs, Runs-map keys and tombstones.
   All 15 ID-taking methods require string IDs before dispatch and apply the same
   prototype-name refusal. Numbers, null, booleans, arrays and objects never coerce into
   an admitted identity. Node mixes strict Map lookup with property-key coercion across
   these methods; those non-string calls are an explicit typed-domain refusal here.
   Node's quarantine/read-only filesystem behavior is deferred, rather than simulated by
   returning an empty writable model.
4. Non-finite JSON number tokens, fractional semantic timestamps and the plan's malformed
   heartbeat input shapes. Direct Node upsert accepts some values the production tool schema
   rejects; the private typed checkpoint documents those refusals. Its supported upsert
   text limits and record replacement behavior remain distinct from validated create.
5. Aggregate byte/node/depth/text/collection excess. Limits also cover unknown retained
   metadata; none of it bypasses the cap because the model does not inspect its meaning.

Unknown supported metadata is retained with JS property order and UTF-16 strings. The pure
codec in `src/store/jsjson.rs` is a byte-identical private copy of the existing owner codec;
both copies and all 15 agreed source files are hash-checked. No owner runtime, SQLite or
filesystem dependency is imported. The only dependency change is enabling preserve_order
on the already pinned serde_json 1.0.154, with offline-resolved indexmap 2.14.2, hashbrown
0.17.1, equivalent 1.0.3 and foldhash 0.2.0 recorded with checksums in Cargo.lock.

## Oracle and tests

`store-node-oracle.cjs` executes the actual production factory, shared validators and cron
module in a fresh private temporary directory. It uses the factory's existing injected
clock and ID source, then compares each result, exact error, file bytes, logical reads,
effects, successful rename count and consumed ID count with the private Rust fixture.
It retains the same ID counter through reload. Real Node writeFileSync/renameSync failures
leave the old file and model unchanged and clean their partial temporary file. The Rust
comparison exercises its candidate publication refusal, not a fabricated filesystem writer.

The gate checks source/module-resolution drift, Node v24.13.0, ICU 77.1 and TZDB 2025b.
The existing Jiff 0.2.42 parser and jiff-tzdb 0.1.4 data remain unchanged. Unsupported seeds
are still executed by actual Node; their intentional Rust differences are tested separately,
never counted as matching behavior.

```sh
cargo test --offline --locked --manifest-path experiments/rust-routines/Cargo.toml
cargo clippy --offline --locked --manifest-path experiments/rust-routines/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/rust-routines/Cargo.toml -- --check
node --test packages/core/src/routines/store.test.cjs packages/core/src/routines/cron.test.cjs
python3 experiments/rust-routines/scripts/check-store-parity.py
python3 experiments/rust-routines/scripts/check-store-mutations.py
python3 experiments/rust-routines/scripts/check-parity.py
python3 experiments/rust-routines/scripts/check-mutations.py
```

Final evidence from root's rebuilt frozen source, with separate implementation-agent reruns:

| Check                                     | Observed result                                                                                 | Local log                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Offline Rust tests                        | 48 tests plus one compile-fail doctest pass                                                     | `/tmp/milagre-routines-store-root-accepted-tests.log`     |
| Strict Clippy/fmt                         | All targets pass, warnings denied; formatter passes                                             | `/tmp/milagre-routines-store-root-accepted-clippy.log`    |
| Actual production Node tests              | 157 store/cron tests pass                                                                       | `/tmp/milagre-routines-store-root-node-tests.log`         |
| Real store differential                   | 25 traces / 841 exact observations pass                                                         | `/tmp/milagre-routines-store-root-accepted-parity.log`    |
| Deliberate refusals, separate from parity | Eight seed-boundary observations and 90 ID-operation observations, each executed by actual Node | `/tmp/milagre-routines-store-root-accepted-parity.log`    |
| Compiled store mutations                  | All six semantic mutants killed by actual Node results                                          | `/tmp/milagre-routines-store-root-accepted-mutations.log` |
| Existing cron differential                | 4168 comparisons plus six separate documented refusals pass                                     | `/tmp/milagre-routines-store-root-cron-parity.log`        |
| Existing compiled cron mutations          | All six semantic mutants killed                                                                 | `/tmp/milagre-store-cron-mutants.log`                     |

The 48 Rust tests comprise 32 library tests (including seven unchanged codec tests),
14 cron tests and two source-drift tests. The mutation gates require a successfully built
mutant and an observed semantic divergence; compilation errors are not kills. The store
mutants exercise inclusive lateness, backlog scheduling, duplicate finish, per-Run restart
failure streaks, publication before failure and pruning running Runs. Their temporary source
and build directories are removed. Production sources remain untouched.

Rust tests include exact byte/node/depth/string/collection boundaries, aggregate result
growth, two-claim batch refusal without partial publication, consumed IDs after rollback,
failed finish/remove/upkeep with no effects, load-only upkeep, duplicate generated identities,
retained unknown metadata/orphan Runs, UTF-16/error encoding and future cron outputs.
Review added per-method non-string identity refusals with valid string controls and a
signed-zero imported timestamp tie, which retains Node's stable creation order.
The final corpus also checks missing required fields and lazy JS conversion of error
metadata: an own noncallable `toString`, including one inside an array, can make the third
failure's interpolation throw. That failure rolls back the candidate; already completed,
disabled new-chat and maxRuns-first branches retain Node's non-converting behavior.
The source reviewer did not build or run checks. Root and implementation-agent runs are
recorded separately above; the implementation agent made no index or commit changes.

No durable claim authority, timer, scheduler, host/ChatHost admission, provider, flow action,
event poller, network service, live profile or production registration is implemented.
The next storage checkpoint still needs the agreed copied-store identity/ownership and
pre-rename versus committed-uncertain durability contract before any claim can drive work.
