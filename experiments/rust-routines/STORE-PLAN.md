# Routine store state checkpoint proposal

Status: root accepted this bounded state scope, including the aggregate node cap below.
Cron baseline is accepted commit `2e28e486`. This document is frozen before implementation;
it does not itself establish store implementation or validation evidence.

## Smallest next checkpoint

Port the **pure state transitions for schedule Routines and Heartbeats**, including both
`chat` and `new-chat` targets, into this standalone crate. Exercise them against the real
Node store using fresh synthetic files. Keep the model private to the checkpoint and its
explicit fixture target until its behavior is reviewed. It is an in-memory model, with no
production claim capability or public storage-owner API.

Included operations are `create`, `upsertHeartbeat`, `update`, `list`, `get`, `runs`,
`remove`, `claimDue`, `startRun`, `finishRun`, `expireDue`, `complete`,
`recoverInterrupted`, `pause` and `setLastError`. Include the small dependent observations
`getRun`, `hasRun`, `runningCount`, `hasPending` and `wasRemoved`, plus `attachChat` and
`setRunTitle` so retention and dropped-Run effects can be compared. These last operations
only save supplied metadata; they do not resolve or create a Chat or Worktree.

Include valid schedule-only snapshot import, the old missing optional top-level maps,
hourly maintenance, 30-day completed-Routine purge, permanent removal tombstones, Run
retention and the post-publication effect records. Keep fallback settings as metadata
through create/update; retry dispatch and `retryRun` are a later increment.

Refuse event-trigger Routines, nonempty event queue/seen/rejection/cursor/PR-snapshot maps,
event Runs, flow Routines and flow Runs at the boundary. A mixed snapshot is refused whole,
with its input bytes retained by the caller. Never drop the unsupported part and return an
empty or partially writable store. Unsupported methods are absent from the fixture command
set. This is schedule-store parity within a stated domain, not the full `store.cjs` port.

## Source facts that constrain the port

| Area                   | Behavior in the current Node source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publication            | `transact` clones current data, runs the change, performs due maintenance, writes one complete JSON image, then publishes data and rebuilds indexes. A thrown validation, write or rename leaves memory and the old file unchanged. Results and callbacks do not escape before this publication. ID-source calls already made are not rolled back.                                                                                                                                                                                                                                                                                  |
| Create                 | A schedule's next instant is calculated before publication. New-chat schedules have no default end. Chat targets get seven days unless `maxRuns` or `expiresAt` supplies an end. Name/prompt limits are 80/4000 UTF-16 code units, maxRuns is an integer from 1 through 1000, and expiry is capped at now plus 30 days. Past expiry is accepted. Supplied `enabled` does not override create's `true`. Trigger/target/createdBy are reconstructed from their checked fields.                                                                                                                                                        |
| Heartbeat upsert       | Match the first noncompleted Routine by exact name and `target.chatId`. Preserve its id, createdAt, runCount and optional lastRunAt. With neither new end supplied, preserve an existing maxRuns/expiry; otherwise use the supplied end or seven days. Replace the record, so fields such as pausedReason, failedStreak, fallback and unspecified provider/model do not survive. Direct upsert has weaker checks than `create`; it must not silently be routed through create's validator.                                                                                                                                          |
| Update                 | Check existence/completion, object shape and unknown patch keys before applying changes to a copy. Preserve patch insertion order for the first unknown-key error. Null clears optional fields. Trigger and target kinds cannot change; whole replacements discard omitted fields. A cron/timezone adjacent to a whole trigger overrides that replacement. Re-enabling from disabled clears pause/failure state and retimes from now; merely passing enabled:true while already enabled does not retime. A Chat target must retain an end.                                                                                          |
| Reads/removal          | List excludes truthy completedAt, includes disabled rows, and sorts newest first with stable tie order. Runs are returned newest first. Returned values are copies. Remove drops the Routine and its Runs, records a permanent tombstone, returns false for an unknown id, and never removes a Chat or folder.                                                                                                                                                                                                                                                                                                                      |
| Due claim              | Visit stored Routine order. For each enabled, noncompleted, due row, calculate its next slot **after claim `at`**, before recording a Run. More than 60,000 ms late records one `missed` Run but returns no claim; exactly 60,000 ms late is still running. Advance directly to the next slot, with no catch-up loop. A schedule with no next run pauses with `pausedReason="schedule has no next run"` and lastError, makes no Run, and does not block other due rows.                                                                                                                                                             |
| Store versus scheduler | `claimDue` itself does not expire rows, enforce one in-flight Run, consult busy Chats, or enforce a newly lowered maxRuns. `startRun` also permits disabled rows and leaves nextRunAt unchanged. `scheduler.cjs` calls expireDue before claims and separately applies scheduleAllows, Chat existence/busy checks and dispatch. Do not add those scheduler rules to the store port.                                                                                                                                                                                                                                                  |
| Finish                 | Only a running Run can finish. Accepted statuses are acted, quiet, failed, skipped-busy and ended. All except skipped-busy count; missed cannot be supplied to finishRun. Set lastRunAt from startedAt. Success/ended reset the failure streak; skipped-busy leaves it. At maxRuns, complete. Three failed beats complete a Chat-target Routine and suffix the last Run error; three failed new-chat runs pause the Routine. A prior pause reason remains if already disabled. Finishing a Run on an already completed Routine still records/counts it before the completed check. A second finish returns null without recounting. |
| Recovery               | Fail every running non-flow Run with `daemon restarted`, counting each Run but only one failure-streak increment per Routine per recovery. Advance an enabled overdue schedule from recovery now without a missed Run. Repeating recovery does not re-fail ended Runs. Flow Runs are deliberately left running for flow-runner resume.                                                                                                                                                                                                                                                                                              |
| Completion             | expireDue checks disabled rows too and uses expiresAt <= at. Explicit complete keeps the first reason and emits onEnded once, but repeated complete still updates completedAt/updatedAt and writes. Max-run/failure completion inside finish does not call onEnded. Preserve source truthiness of completedAt, including epoch zero, rather than replacing every check with Option::is_some.                                                                                                                                                                                                                                        |
| Retention/maintenance  | Retain 50 acted, 50 skipped/missed and 50 other Runs separately; never evict running Runs to make the last group fit. The full source also retains 50 rejected event Runs separately. Trimming occurs when appending, not on every finish. Purge completed rows after 30 days, including their Runs, and keep removal tombstones. Maintenance is checked with injected now, not claimDue's explicit at; it runs on load and at most hourly in transactions.                                                                                                                                                                         |

The relevant implementation ranges are store lines 204-399 (finish/retention/upkeep),
462-674 (load/transaction), 675-933 (reads/create/update/due claims), 1112-1206
(metadata/finish), and 1258-1391 (pause/completion/expiry/recovery). Exact source hashes
below take precedence over these navigation ranges.

## State, publication and effects

Use one exclusively borrowed model, ordinary synchronous methods and no background worker.
The owned data, run-id index, Routine-position index and maintenance timestamp move together.
A private candidate contains the draft, result, serialized prospective image and ordered
effect records. Validate aggregate bounds before publication. Only a successful internal
publication releases claims/results/effects. Failure drops the entire candidate and leaves
all current data/indexes/maintenance state unchanged. There is no public `commit(true)`,
caller-supplied durability proof, persistence callback or reusable claim ticket.

The first checkpoint's publication is only an in-memory assignment. Its test-only failure
point immediately before publication proves rollback of the same candidate used on success;
it does **not** prove filesystem atomicity. Claim values are observations of this model,
not authorization to dispatch. Reloading a supplied, previously published snapshot can
prove state recovery/no duplicate claim. It cannot prove crash durability or exactly-once
external execution without the later writer/owner checkpoint.

Represent onPurged, onRunsDropped and onEnded as copied effect records, released after
publication in Node order. Do not execute arbitrary callbacks in the model. Node's
transaction reports purges, then dropped Runs; complete/expireDue report ended rows after
that. No effect escapes a failed transaction. A future adapter may log a failed listener,
but must not roll back or replay the committed mutation. Keep function return values
separate from these effects: a transaction's maintenance can purge a row after its return
value was calculated.

Load-time upkeep is a separate detail: Node changes its in-memory view and reports purges
and dropped Runs without immediately rewriting a valid file. The oracle must compare the
logical view and last published file image separately. Do not invent a write on load or
collapse this distinction in the fixture. Indexes are built from the retained view.

Clock values are explicit integer inputs, with one stable injected `now` per fixture
operation, and a separate `at` for claim/start/expiry where Node has that parameter. No wall
clock or automatic ticking enters the model. Test clocks may move backward. The private ID
source is deterministic in fixtures using the Node factory's existing `id` option; assert
its consumption order, including failed operations. Do not expose a random-ID string as
storage ownership. Duplicate Routine/Run identifiers in a seed or generated collision refuse
the candidate rather than corrupt an index; Node's weaker handling is outside this domain.

## Bounds and dependencies

Proposed checkpoint limits are 4 MiB per input/state image, 64 Routines, 4096 total Runs,
4096 removal tombstones, depth 32 and 16 KiB for each otherwise unbounded metadata string.
An aggregate limit of **131072 JSON value nodes** counts every scalar, array and object,
including values in unknown retained metadata. Object keys are covered by the string and
byte limits. Check node, depth, string and collection caps before candidate cloning and
again before publication, including candidate results and effects. The 4 MiB serialized
limit is not a heap bound: parsed maps, strings, allocation overhead and candidate/result
copies cost more. Before JSON parsing, scan the bounded bytes for nesting and value-token
counts outside strings, refusing depth/node excess before allocating the parsed tree.
The parser can still allocate its bounded decoded tree and temporary string/number buffers
before semantic collection/string validation completes; there is no allocator-level peak
memory guarantee. Never describe the byte cap or node cap as an exact RSS bound.
The image cap applies before parsing, then to the candidate before publication; collection
counts are checked before cloning/expansion. State results/effects are bounded by the same
admitted rows. A full cap refuses the whole mutation; it must not evict running Runs,
forget tombstones, partially claim a batch or persist maintenance alone. Node's own
80/4000 text and 1..1000 create/update maxRuns checks retain their exact messages inside
this envelope. No fixture batch is unbounded: at most 4096 commands, one bounded line per
command. These are new explicit fixture/domain limits, not claimed Node limits.

Use the accepted cron implementation and its exact parser/data pins. Retain its integer-ms
range (`-2208902400000` through `253118217599999`), 4096-byte cron/cadence and 128-byte
timezone bounds. Validate operation times and derived expiry arithmetic before changing
state. Each batch performs at most one bounded nextRun search per visited schedule, up to
64 searches; each search retains the accepted inclusive eight-year calendar bound. This is
a bound on work, not a hard wall-clock timeout. No new timer or executor dependency is needed.

ICU-only `SystemV/*` remains unsupported. Refuse creation/retiming and imported schedule
images using it, explicitly as a compatibility refusal. Do not let a later claim turn this
known Rust gap into Node's ordinary "schedule has no next run" pause. Unknown zones and
syntactically invalid/impossible cron strings that are within the supported input domain
may still be loaded when Node's structural loader accepts them; then claim/recovery must
produce Node's pause/error behavior. Out-of-domain times and over-limit cron strings are
also import refusals, not evidence that an ordinary schedule has no next run.

The direct heartbeat API accepts some malformed values that the production tool schema
does not. For this first bounded typed domain, require chatId and creator to have the
documented shapes, maxRuns (when supplied) to be an integer 1..1000, and optional
provider/model/permissionMode to be strings. Report other upsert shapes as explicit domain
refusals, separately from Node errors. Within that domain preserve upsert's own weaker text
limits and replacement behavior; do not silently add create's 80/4000 limits to upsert.
Keep missing, null and undefined distinct where they affect checked create/update inputs.
Non-finite/fractional timestamps, unsupported JS objects/functions and duplicate identities
are refused, never rounded or normalized into another mutation.

Reuse the existing pure JSON compatibility implementation in
`experiments/rust-owner/src/jsjson.rs` as a byte-identical private copy with source and copy
hash drift checks, rather than taking
the entire owner crate and its SQLite/filesystem dependencies or writing a second JS JSON
codec. It depends only on serde_json. Enable that already-pinned dependency's preserve_order
feature and pin the resulting offline-available transitive versions/checksums in Cargo.lock.
This permits exact JS object order, missing/undefined handling, number text and UTF-16
length/string behavior in store metadata. Encoded JSON values remain private and are encoded
once. Cron/timezone strings containing unpaired UTF-16 surrogates remain a deliberate refusal
of the existing typed cron domain. No edits to the owner module are part of this checkpoint.

The Node store unconditionally imports shared babysit and routine-flows validators even
when using only schedules. The real oracle must resolve and hash those actual modules and
the package export map. Do not stub them to make require succeed. No Rust port of their
unused behavior is necessary in this increment. Pin all exercised source/runtime/data
inputs; refuse drift before comparing outputs.

## Real Node oracle and acceptance order

The oracle requires actual `createRoutineStore` with its existing injected `now` and `id`
options. Each trace gets a new temporary directory and fixed synthetic `routines.json`;
cleanup runs in finally. Record results, exact errors, effects, reads, successful rename
count and the file bytes after every command. Capture IDs directly from the injected source,
with no output-ID normalization that could hide a lost allocation. Recreate the real store
from that file for restart steps. Hash/Node/ICU/TZDB drift aborts before the trace runs.

Run one trace per isolated process where monkeypatching fs is needed. Inject actual Node
writeFileSync and renameSync failures using the existing tests' pattern, including the
partial temporary file. The Rust model's corresponding prepublication failure must preserve
the same logical state and last published image, and release no result/effect. Actual Rust
disk failure, lock and process-crash tests belong to the subsequent writer checkpoint.

1. **CRUD and exact boundaries:** new-chat schedule plus heartbeat; first-match upsert and
   keep-end/default-end cases; null clears versus omitted fields; same-time list ordering;
   UTF-16 text limits and JS trim whitespace; unknown-key/error precedence; replacement
   field loss; detached return values; duplicate/id/domain refusals. Compare real file bytes
   and no-op write counts, not just a final summary.
2. **Claims and restart:** exact due, exactly 60 seconds late and one ms later; many missed
   periods create one missed Run; repeated claim emits none; claim at different injected
   now; DST gap/repeat, leap day, 2096 to 2104 and upper cron bounds; impossible schedule
   next to a healthy one; several running schedule Runs and disabled manual start; load
   then recovery advances overdue slots without replay. Run recovery twice.
3. **Finish and maintenance:** all five accepted finish statuses, duplicate/unknown finish,
   existing completed Routine, three failures for both targets, success/streak reset,
   prior pause reason, enable/retime, repeated complete reason/timestamp, exact expiry,
   epoch-zero truthiness, separate retention buckets, never trim running, dropped-Chat
   effects, purge/tombstone/index consistency and load-only maintenance versus persisted
   bytes. Verify a capacity refusal does not discard no-replay history.
4. **Atomic failures and compatibility refusals:** fail before publication for create,
   update, claim, finish, remove and upkeep-containing transactions; retry and compare
   IDs/results to the real Node trace. Assert unchanged data, indexes, maintenance time,
   last image and effects. Mixed flow/event/SystemV seeds, corrupt/wrong-version/wrong-shape
   seeds, oversized images and invalid scalar domains return distinct refusal causes and
   never produce a writable empty model. Report Node's differing load/upsert behavior as
   an intentional boundary, outside the parity count.
5. **Independent gates:** offline locked Rust tests, strict all-target Clippy/fmt, original
   Node store/cron tests, Node --check and real differential traces with exact result counts.
   Compiled semantic mutants must be killed for inclusive late threshold, backlog replay,
   duplicate finish count, multiple restart failure-streak increments, publishing before a
   failed mutation, and pruning a running Run. Compiler failures do not count as kills.

## Deferred boundaries, with source evidence

**Disk owner:** Node's store file is global `dataDir/routines.json`, created by runtime.cjs,
not a Project's state file. Its writer uses mkdir, a UUID temp, JSON.stringify and rename;
it has no store-specific lock or fsync protocol. Missing file starts empty. Other read errors,
wrong shape/version open read-only; corrupt JSON is moved to `.corrupt`; invalid records are
quarantined to `.invalid.json` and the valid subset may be rewritten. These effects need a
separate copied-store ownership checkpoint. The state increment does not reproduce them by
silently resetting or touching an arbitrary path.

For that later checkpoint, use the existing `Isolation`-based fresh-copy admission and
descriptor-relative, pinned-identity, single-writer patterns from the registry/accounts
work. Seeds are supplied bounded bytes, never live profile paths. Preserve Node's
save-before-publication order and distinguish pre-rename refusal from post-rename durability
uncertainty; a committed/uncertain claim must never be auto-retried. Retain ownership through
publication and cleanup. A narrow private routines storage adapter is preferable to another
public owner/proof API. Reuse or factor shared machinery only under a separately reviewed
scope; no other crate changes are proposed now.

**Events and flows:** event admission is a separate state increment: queue cap 20; seen
keys 48 hours/5000 with queued/running keys retained; separate 50 rejected-event records;
three concurrent event Runs, one for a PR; maxRuns reserves in-flight slots; Linear comment
expiry is strictly over two hours and ordering uses both issue id/key; deferred events keep
their original arrival time. PR events never expire and cannot overtake the head. None of
this is equivalent to claimDue. Flow publication depends on checkFlowSteps/checkDraftSteps:
40 published steps, depth 3, a 200,000-code-unit draft bound, typed references and branch
validation. Flow-runner saves action intent before execution and receipts afterward; a
restart checks an uncertain PR and refuses to repeat an uncertain Linear comment. Treating
these as opaque ordinary Runs would break recovery, so they remain refused until ported.

**Scheduler/dispatch:** timers, start/stop recovery-once, live Chat/Project admission,
busy/archived checks, Worktree creation, provider/fallback attempts, event observation,
quiet-run cleanup, polls, webhooks and external flow actions remain absent. Store effects
are data, not permission to call any of them. The later runtime must bind committed claims
to its existing owner/ChatHost authority and track consumption before claiming end-to-end
no replay. This proposal does not authorize production registration, a host or network use.

## Source pins for the implementation gate

The implementation should copy these into a separate store-oracle manifest and verify
resolved module paths. The approved cron manifest stays unchanged.

| Repository path                                       | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core/src/routines/store.cjs`                | `c8af1c739391cc7b337ecc112be17cd5c1e0d8c30dc572d65e27fd022babbc67` |
| `packages/core/src/routines/store.test.cjs`           | `22e3634eb051ecfb060df6188b1299a208a6f79203a87824c0e4f12edb970a0e` |
| `packages/core/src/routines/cron.cjs`                 | `4bf2089a47093afa6bb364adb77d1196415849f8da33ff361d4b41f37183cbce` |
| `packages/core/src/routines/cron.test.cjs`            | `31dea9aee61f5a19e84a097f4679f0124638015cab80ebad65b1b8baf6a0bdf0` |
| `packages/shared/src/routine-flows.mjs`               | `7c13ea465bf15566dbecc658253b438042e2b8a1dc1dfab00c6854483e10c563` |
| `packages/shared/src/babysit.mjs`                     | `44bd122baee3d92fd938a0f99e75c7aa1c1ee2d286dee4a2f7ee64d11b06e4a8` |
| `packages/shared/package.json`                        | `dbca4f4db2ce28781221103a295ff6270dd45c4f673caaf3fee1858a308036ae` |
| `packages/core/src/routines/scheduler.cjs`            | `d30cdb2e6f4f1c5a1b733f09e6616beaba3c550bfa13dab14032f4306d58ac57` |
| `packages/core/src/routines/scheduler.test.cjs`       | `0efdf9dc42a1ece6301b94571fbb71feddffd8cd4b6dce77b78af2f9a1defbcf` |
| `packages/core/src/routines/runtime-adapter.cjs`      | `a27c9ad685dc3c2d8c8c205c2dfa36d082c861c80781493408677aa06a9294b7` |
| `packages/core/src/routines/runtime-adapter.test.cjs` | `ed0893723d40850f6e9ba875222e9a338795fe3880f89647174e2358eae1d87b` |
| `packages/core/src/routines/flow-runner.cjs`          | `e6071a5445a6316487c68701e96f9016084efa97ee0c289377bb806bcc14704d` |
| `packages/core/src/routines/tools.cjs`                | `e3a246e869cc20623f4fb005eb2f7cbbbdd9d6ce3c884df06170b49630085b5f` |
| `packages/core/src/runtime.cjs`                       | `3d44a7e175df281bd09740384fcda839d549e8fb4afbfb24d3b42be859bdd839` |
| `experiments/rust-owner/src/jsjson.rs`                | `518c89cfdad784818b2431d25fb580a85de32949716fecf41aa5cc9ba86097f3` |

The source audit also used `docs/adr/0014-routine-flows.md`, the routine inventory in
`experiments/rust-desktop/BACKEND-MIGRATION.md`, and the existing registry writer contract.
Node v24.13.0 / ICU 77.1 / TZDB 2025b and Rust Jiff 0.2.42 / jiff-tzdb 0.1.4 remain the
accepted matching cron baseline. No checks run for this documentation-only proposal imply
store implementation or acceptance. Root agreement on this bounded state scope is the next
step before code.
