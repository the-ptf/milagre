# Dedicated runtime routine storage

The default-disabled `durable-store` library feature adds real persistent schedule
CRUD and explicit execution-state transactions through `RoutineStore`. It reuses the existing Node-conformant Model's
prepare/pending-image/install transition; it does not expose the Model, its fake
Fault inputs, or the temporary Copy lifecycle as production authority.

This is a storage increment. Claims are persisted records, not authority to launch
an agent or evidence that a turn ran. There are no timers, agent turns, event
pollers, flows, hooks, delegation or automatic execution in this library. New
execution transactions remain host-internal until separate runtime acceptance. A computed
`nextRunAt` and an `enabled` field preserve the Node data schema, not evidence that
a scheduler runs. Do not advertise scheduling/execution based on CRUD checks.

## API and runtime responsibilities

```rust,ignore
use milagre_routines::{RoutineStore, StoreCommand};
let mut store = RoutineStore::open(&dedicated_root, actual_owner_check, now)?;
let reply = store.execute(StoreCommand::Create(input), now)?;
// Only now may the caller publish reply.value and dispatch reply.effects.
store.close()?;
```

The exported types are `RoutineStore`, `StoreCommand`, `StoreReply`, `StoreError`,
`RunFinishStatus` and `OwnerCheck`. CRUD commands remain `List`, `Get(id)`, `Runs(id)`,
`Create(Value)`, `CreatePaused(Value)`, `Update {id,patch}` and `Remove(id)`.
No raw method name can select execution.
`StoreReply {value,changed,effects}` is returned only after actual persistence and
the final owner check. `changed` means a file publication occurred, rather than
the outer Node scheduler's `onChange` notification policy. Effects are returned,
not dispatched by this library. Constructor-time maintenance callbacks are not
connected to a host here; existing production data/run adoption is out of scope.

`CreatePaused` is an explicit storage adapter for runtimes without execution. Its
result and saved bytes equal the production Node store's `create(input)` followed
by `update(id, {enabled:false})` at the same clock value. It prepares one disabled
candidate and persists it once; no enabled intermediate image or reply exists.
Ordinary `Create` preserves Node's always-enabled creation behavior. The additional
oracle test compares the complete reply and actual file bytes, then injects a
post-rename failure to prove the disabled candidate is saved without publication.

### Durable execution records

The additional typed commands expose only the already ported schedule-state
semantics:

```rust,ignore
StoreCommand::ClaimDue { at: i64 }
StoreCommand::StartRun { id: String, scheduled_for: i64 }
StoreCommand::FinishRun {
    run_id: String, status: RunFinishStatus,
    chat_id: Option<String>, error: Option<String>,
    summary: Option<String>, title: Option<String>,
}
StoreCommand::RecoverInterrupted
StoreCommand::ExpireDue { at: i64 }
StoreCommand::Complete { id: String, reason: Option<String> }
StoreCommand::AttachChat {
    run_id: String, chat_id: String, worktree_id: Option<String>,
}
```

`RunFinishStatus` is exactly `Acted`, `Quiet`, `Failed`, `SkippedBusy`, or `Ended`.
There is no fabricated Cancelled status. The runtime must map real turn outcomes
and cancellation policy to those existing Node statuses. Optional string fields
are omitted rather than written as null. The existing bounded JSON preflight and
schedule timestamp checks run before preparation or persistence; metadata strings
remain capped at 16 Ki UTF-16 units, and the aggregate state/run limits still apply.

`execute(command, now)` retains Node's distinction between the store clock and
an explicit claim/expiry `at` or manual-run `scheduled_for`. ClaimDue returns an
array of `{routine,run}` only after its running records and next slots are saved.
StartRun returns one such pair or null. A slot more than 60 seconds late records
a missed run and advances without returning a dispatchable claim. Manual StartRun
leaves the schedule unchanged and, as Node does, can start a disabled but
uncompleted routine; the host owns policy/admission/concurrency limits.

Finishing a non-running/missing Run returns null without recounting it.
RecoverInterrupted marks existing running records failed (`daemon restarted`),
counts only the first interrupted failure per routine toward its failure streak,
and advances overdue slots without returning claims. Repeating recovery never
redelivers a Run or counts it twice. Complete/ExpireDue apply the Node end-state
and effects; they do not stop an executing provider. AttachChat only saves bounded
metadata; the host must check its actual Chat/Worktree authority.

All generated durable IDs, including every member of a multi-routine claim batch,
come from the native eight-hex-character random source. The private Model's
deterministic `idN` fixture generator is never used by a durable store. The private
test ID queue stays unavailable to callers, and existing pure/copied Model fixtures
retain their original behavior.

A claim/finish with a post-rename error returns Uncertain, withholds its result,
and fences the store while retaining the writer. The caller must never dispatch
or replay that claim. An explicit verified close/reopen reads the actual canonical
bytes; startup recovery can then settle an unacknowledged running record without
executing it. Before-rename failure preserves the old file and model. No routine
execution, scheduling loop, cross-store transaction, live provider, process-crash
or power-loss guarantee is added by these state transactions.

The mandatory ownership callback must retain and check the real runtime authority.
It runs on open, every operation, immediately before rename, after the durable
write and before publication, and on close. A panic refuses. Root/manifest/lock
identity and saved-file checks are independent of that callback. Ownership failure
fences that captured store; restoring bytes or a callback does not resume commands.
An explicit verified close can release it, after which a new store may open.

The host still owns Node runtime policy and presentation:

- Validate actual live Project/Chat target membership and archived status, as
  `routineTargets` does. The store validates schema, not runtime registry grants.
- User creation must force `createdBy: {kind:"user"}` regardless of caller input.
- `routines:create` wraps the store result as `{routine}`. Node's `routines:list`
  is `{routines: list.map(r => ({...r,runs: runs(r.id)}))}`, not a bare array.
- Publish changes only after the library reply. Do not convert an uncertain save
  into success, retry it automatically, or enable unsupported trigger/execution
  commands. The separate runtime adapter's event behavior still needs its tests.

Values at this public boundary are ordinary UTF-8 `serde_json::Value` trees. Inputs
are converted through the existing injective JavaScript codec before transitions;
saved bytes use its exact Node JSON ordering, numbers and escapes. Existing files
with unpaired-surrogate escapes refuse unchanged. A future lossless adoption DTO
is required before importing arbitrary production stores.

IDs are fresh eight-character lower-case hexadecimal strings, matching Node's
default ID shape. The existing bounds remain: 4 MiB encoded state, 64 routines,
4,096 runs/tombstones, 16 KiB metadata strings and bounded depth/node counts.
Only schedule trigger semantics are admitted. Unsupported flows, webhooks, Linear
and PR triggers refuse; none returns an empty success.

## Filesystem and uncertainty

Open requires an explicit canonical absolute 0700 root whose 0600
`rust-chat-runtime.json` declares schema 1, `kind:"milagre-rust-chat"` and the same
root. Known production profiles and `MILAGRE_DATA_DIR` overlap are refused. The
store uses the fixed `routines` subdirectory, `.routine-writer.lock` and
`routines.json`. It takes independent kernel flocks on the directory and lock file;
a second store in this process or another process refuses while the writer lives.
The old temporary Copy/global slot remains a private fixture and is not used.

Root, manifest, directory, lock and canonical file are descriptor-pinned. Opens use
no-follow, nonblocking and close-on-exec flags. Every mutation checks the actual
saved inode and bytes before preparing a new image. Directory replacement, inode
replacement with equal bytes, mode changes and manifest rewrites refuse.

A mutation creates one uniquely named private staging file after recording its
creation intent, writes and fsyncs it, checks ownership again, renames through the
held directory, syncs that directory, checks actual canonical bytes/owner, then
installs the prepared Model and returns. Creation of the routines directory also
syncs its parent entry. Pre-rename failure discards only after identity-checked
staging cleanup, directory sync and verification of the unchanged canonical file.

Once rename is attempted, any failed proof returns `Uncertain` with the original
operation/cause and withholds Model publication. The directory/file handles and
locks remain retained. Cleanup failure also fences; it never deletes a replacement
entry or releases the active writer. Close can verify the exact observed canonical
file and finish only its own staging cleanup, without delivering a withheld result
or replaying the mutation. A failed close retains ownership. Drop after failed
close parks the handles for the current process; no global worker or synthetic
successful cleanup is invented. A new process may reopen the actual canonical
store after the old process has exited.

Orphan staging files from an interrupted process are not swept. A normal reopen
reads only the canonical file; it never adopts or publishes a staging candidate.
The new tests prove graceful process restart and injected native syscall-boundary
failures, not process-crash, hostile same-uid race freedom, hardware/power-loss
durability, or a completed runtime shutdown/adoption flow. Those remain explicit
acceptance gates. The filesystem boundary is cooperative same-uid Unix; macOS was
run, while Linux execution and Windows support are not claimed.

## Validation

```sh
NODE_PATH=/explicit/main-checkout/node_modules cargo test --locked --offline --features durable-store --lib store::durable::tests
cargo clippy --locked --offline --features durable-store --all-targets -- -D warnings
cargo check --locked --offline --lib
cargo fmt --check
```

The twelve original focused tests cover real canonical bytes; one writer; close/reopen;
two separate graceful process lifetimes; root/manifest/directory/file replacement;
late owner refusal before and after rename; retained pre/post-rename faults; and
failed cleanup followed by explicit close. Final read checks cover both host
revocation (List/Get/Runs) and manifest-pin failure: restoring authority does not
revive the captured store, its unmodified candidate is discarded, and only an
explicit close/reopen admits commands again. The actual Node production store is
run over its own fresh temporary directory for twelve CRUD/read operations. Every
result and actual file byte string is compared, including invalid update, Unicode,
delete/missing IDs, runs and list order. No seed or error is skipped.

Five additional execution tests cover two actual Node traces, a real two-process
graceful restart, claim/finish native fault boundaries and bounded refusal. The
Node execution oracle compares every result, effect and actual saved file byte
string, including multi-routine claim IDs, all five terminal statuses, completion,
expiry, late slots, repeated recovery and no redelivery. The process helper is
ignored during ordinary suites and invoked only by its exact parent. All six
Node/process tests share the copied-owner lifecycle mutex.

The full library suites pass: default 71 passed/1 ignored, durable feature
88 passed/2 ignored. Before the execution amendment the durable feature had
83 passed/1 ignored. Before the paused-create amendment it had
82 passed/1 ignored, with ten consecutive full runs passing. All three Node/process
tests at that checkpoint shared the copied-owner tests' process/lifecycle mutex.
An earlier parallel run failed a copied crash cleanup with `Busy` and poisoned
the test mutex. A separate controlled fork experiment on this Mac confirms a
pre-exec child retains inherited flock descriptions after the parent closes them,
until exec closes the descriptors. This explains the isolation fix; the original
failure was not traced to an exact concurrent child. Production locking and
cleanup refusal rules are unchanged.

Two deliberate mutations fail cleanly: removing native persistence breaks the
saved-byte test; classifying an attempted rename as pre-I/O breaks the uncertainty
test. Sources are restored byte-identically before the final green run.
Restoring the old write-only final-check fence also fails both final-read tests.

Logs: `/tmp/milagre-routines-durable-{tests,clippy,default-check,mutants}.log`.
Final-read fix logs: `/tmp/milagre-routines-durable-final-read-{tests,clippy,mutant}.log`.
Full-suite logs: `/tmp/milagre-routines-isolated-{default-tests,feature-tests,feature-repeat,clippy}.log`;
controlled fork evidence: `/tmp/milagre-routines-fork-lock-proof.log`.
Node is used only as a test oracle, never as this store's backend. No production
profile, network, account, runtime route, process kill or push was used.

Paused-create amendment logs: `/tmp/milagre-routines-paused-{feature-tests,clippy,default-check,mutant}.log`.

Execution-record amendment: the full feature suite passes 88 library tests
(2 exec-only helpers ignored), 14 cron integration tests, 2 source-pin tests and
3 compile-fail doctests. Default remains 71 library tests (1 exec-only helper
ignored), 14 cron tests, 2 source-pin tests and 1 compile-fail doctest. Strict
feature all-target Clippy, formatting and Node recorder syntax checks pass.
Logs: `/tmp/milagre-routines-transactions-{tests,full,default,clippy}.log`.
