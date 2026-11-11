# Fresh copied routine-store writer proposal

Status: accepted plan after root and independent source review. Only slice 1, the private
candidate seam without filesystem I/O, is authorized for implementation first. Each later
slice needs its preceding implementation review; no filesystem writer has been implemented.
The private state baseline is accepted commit `4ff6175e`; the public library
still exposes only cron helpers. This proposal extends the deferred disk-owner section of
`STORE-PLAN.md` without admitting a live profile, an existing caller path or a dispatcher.

## Smallest useful boundary

Create one private, fresh routine-store copy from explicit bounded seed bytes. Connect its
single writer to the accepted schedule/Heartbeat model so a successful mutation means the
candidate file was written, synced, renamed and its directory synced before logical state,
results or effects become visible. Keep all state-domain refusals, including mixed
event/flow snapshots and ICU-only `SystemV/*` zones. Missing seed means a missing file;
an empty or invalid JSON seed does not mean an empty writable store.

Use a private Unix test module plus an explicit copied-store example, following the existing
`store_fixture` compile arrangement. Compile the model once in each fixture process. Add
filesystem crates only as pinned dev-dependencies; the normal library dependency graph,
public API and default build remain unchanged. There is no Tokio runtime, background task,
timer, public persistence callback, caller proof boolean or reusable claim ticket.

The initial writer handles valid schedule-only seeds and a missing seed. It does not yet
perform corrupt-file backup, invalid-row quarantine or filtered repair. Those are observable
Node behaviors with separate failure boundaries, not incidental parsing details. Refusing
such a seed preserves the caller's bytes and creates no writable copy.

## Source behavior to preserve or explicitly defer

The production store is global `dataDir/routines.json`, created by `runtime.cjs`, rather
than part of a Project's state. The following facts come from `store.cjs:462-674` and the
load/write tests in `store.test.cjs`.

| Node operation | Observed source behavior | Proposed copied-writer treatment |
| --- | --- | --- |
| Transaction | Clone current data, calculate changes and hourly upkeep, write a complete JSON image, then publish data/indexes and release results/callbacks. Consumed IDs are not rolled back. | Preserve this order. Build all candidate data, indexes and effect/result values before native publication. |
| Native write | Create parent directories, write a UUID temporary file, rename over the target; best-effort temporary removal on error. No store-specific lock, file sync or directory sync. Normal file mode follows the process umask. | Fresh private directory, descriptor-relative I/O, one writer, mode `0600`, file and directory sync. These are stronger fixture ownership/durability rules, not claimed Node syscall parity. |
| Missing/read failure | ENOENT opens empty; other read errors open a read-only empty view and never overwrite the unreadable file. | Missing seed is supported. Read/identity failure during retained-copy reopen refuses access and preserves bytes; it never silently opens writable empty. |
| Valid-file upkeep | Constructor publishes loaded data, performs maintenance in memory, then reports purges/dropped Runs. It does not immediately save the maintained view. | Preserve the distinction between current logical view and exact last file bytes. Load effects remain observations, with no external cleanup callback. |
| Corrupt JSON | Try renaming the original to `.corrupt`, ignore a failed rename, and return writable empty. | Deferred. Do not adopt this weaker failure behavior implicitly. The first writer refuses the input whole. |
| Wrong shape/version | Open read-only and preserve the original, including a newer version. | Refuse import with the original bytes retained by the caller. No read-only empty-model compatibility claim yet. |
| Invalid rows | Keep valid rows, append invalid Routine/Run records to `.invalid.json` with mode `0600`, then attempt a filtered-store write. Quarantine failure opens read-only; a failed filtered-store write is logged but the filtered view remains usable. | Deferred two-file load repair. It cannot be presented as one atomic publication. |
| Existing quarantine | Append to a JSON array. An unreadable file is preserved and the error propagates; malformed/wrong-shaped content is renamed to `.corrupt` first. History has no source-level cap. | Deferred, requiring explicit archive bounds, both file identities and per-publication uncertainty handling. |

The existing Node oracle must still execute unsupported inputs when comparing these
differences. A Rust refusal is counted separately, never substituted for Node's result.
This checkpoint does not claim full store/load compatibility or power-loss durability.

## Reused ownership patterns and dependencies

Use the fresh fixed-temp admission and descriptor checks in
`rust-accounts/src/store.rs:47-146`, together with the registry writer's original lock-inode
and token checks in `rust-registry/src/writer/storage.rs:149-234`. Adapt the narrow helpers
inside rust-routines and pin the reviewed source. Do not import the accounts service,
registry owner, SQLite or account journal. No changes to those crates are required.

This refines the earlier plan's `Isolation` reference: `Isolation` itself retains a path,
and `Policy::system()` reads real profile registries. The accounts fresh-copy pattern avoids
that live discovery and gives this checkpoint no path-admission API. It also avoids copying
the registry's public `Active` callback into a new authority surface.

Proposed direct dev-dependency versions already present in both reviewed writer lockfiles
are `libc =0.2.191`, `uuid =1.29.2` with `v4`, and `tempfile =3.27.0`. The implementation
must resolve and test them with `--offline --locked`, record every checksum, and leave the
normal build graph unchanged. Existing `sha2 =0.10.9` can pin source inputs in tests; a
digest is diagnostic evidence, never a substitute for descriptor identity and exact bytes.

Private admission and ownership rules:

1. Reserve one bounded fixture resource slot before the first filesystem creation. Create
   beneath the fixed, canonical OS temp root (`/tmp` or `/private/tmp`), independent of
   HOME/TMPDIR. The only input is `Option<bounded seed bytes>` plus the existing explicit
   model clock. No arbitrary basename, path, environment or callback enters admission.
2. Hold the parent directory, fresh `0700` child directory, marker and original lock inode.
   Use fixed names for the marker, lock and `routines.json`; generated staging names stay
   beneath the held child descriptor. Require effective-UID ownership, regular `0600`
   files with one link, and `O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK` where appropriate.
   Validate seed bytes before creation; preserve them byte-for-byte as the initial file.
   Sync seed/marker/lock and the directory before admitting the copy.
3. Acquire nonblocking exclusive locks on both a fresh directory file description and the
   pinned lock file. Recheck directory/marker/lock identity and token after acquisition.
   A cloned copy capability does not clone writer authority; the writer is non-Clone.
   Directory locking prevents lock-file replacement from admitting a second writer.
4. Retain the canonical file's descriptor identity and exact expected bytes, or a checked
   absence. Before every operation and before rename, verify the parent/child linkage,
   modes, owner, marker, lock and target identity/bytes. Same bytes in a replacement inode
   still refuse. Read through bounded descriptors; a symlink, FIFO, device, hardlink,
   growth or metadata change never falls back to path-based loading.
5. Register every newly created file in the resource owner immediately, before writing,
   pin validation or any other fallible work. Construction failures carry this same owner
   into checked cleanup. There is no gap where a created file is left to an untracked
   temporary-directory destructor.

These are cooperative same-UID guarantees. Advisory locks and check-then-rename/unlink do
not prevent a malicious same-UID process from changing entries after the final check. The
tests refuse observed interference; they do not establish an immutable directory namespace.

## Private candidate and publication state machine

Extract the existing private `Model::transact` into preparation and installation without
changing its transition semantics. Preparation consumes IDs as Node does and stores one
non-Clone candidate inside its originating model/writer. It contains the draft, prebuilt
indexes/tracking data, maintenance time, exact optional image, result and ordered effects.
Bind it to an immutable per-model identity and a checked, nonwrapping preparation generation.
Identity/generation exhaustion refuses before consuming IDs or changing candidate state.
The private model phase permits only one outstanding preparation; second preparation,
reload and model replacement are unavailable while it is pending. Their rejection leaves
the current candidate untouched. Installation verifies that exact origin and current
pending generation, consumes the candidate once, and leaves no stale candidate reusable
after refusal, reload or close. A new model gets a new identity.

There is no separate `install(Model, candidate)` surface. Native I/O may borrow the pending
image and record its internal identity, but cannot extract the result/effects or supply a
caller-provided success proof. Bounds are checked before cloning and before installation.
No I/O callback is passed into the model. The pure fixture keeps its internal in-memory
installation path; only the copied writer can advance its own native publication state.

Internal discard before I/O can clear a pending candidate while retaining consumed IDs.
Once staging starts, discard requires confirmed pre-rename cleanup. After rename, the
candidate stays with its uncertain owner until close-only reconciliation proves cleanup;
ordinary discard, reload or model replacement cannot erase that obligation.

| Private state | Required retained data | Allowed next action |
| --- | --- | --- |
| `Ready` | Current model, exact expected file/absence, pinned copy and both locks | Verify and prepare one operation. |
| `Prepared` | Candidate plus original model/file baseline | For a changed image, create one staging file; for a no-write operation, install its in-memory upkeep/result after identity verification. |
| `Staged` | Candidate and exact staging name, descriptor and inode | Write all bytes, sync file, reverify target/owner, then rename. |
| `Renamed` | Candidate, replacement inode and held old baseline | Record rename success immediately, with no intervening fallible work. Sync directory and reverify installed inode/bytes/owner. |
| `Published` | Newly installed model/file baseline | Release this operation's result/effects once, then return to `Ready`. Installation itself uses prepared moves/swaps without new fallible I/O or index construction. |
| `Uncertain` | Cause/phase, original model, candidate, file identities, all locks and cleanup resources | Diagnostics and close-only reconciliation. No normal reads presented as authoritative, mutation, reload, claim delivery or automatic retry. |
| `Closed` | No active candidate/staging cleanup and no writer locks | A retained valid copy capability may open a new writer; it is not a live-path reopen. |

The physical commit point is successful `renameat`; logical publication follows successful
directory sync and final verification. A file-sync success alone is not a committed store.
An error before rename is a clean refusal only when this writer has not renamed, its exact
staging file is removed and the directory synced, and the original target/ownership still
verify. The old logical state, indexes, maintenance time and file image then remain current;
only consumed IDs differ. A fresh explicit attempt is permitted after that clean refusal.

An observed ownership change or unconfirmed staging cleanup fences the writer even before
rename. Its error must say that this writer did not publish, without asserting that another
actor left the pathname unchanged. Any error or caught panic after successful rename is
post-rename uncertainty, even if the new file can be read. Do not restore old bytes, return
the prepared claim, discard the candidate owner, or turn uncertainty into a retryable write
error. A panic guard records the phase before unwinding and preserves the same resources.

No-write operations do not create or sync a new store image. In particular, valid-file load
upkeep and hourly maintenance with no persisted change retain Node's logical/file distinction.
Read-only observations still verify the copy while it is `Ready`. No filesystem failure is
hidden by serving a stale model as a healthy owner.

## Uncertainty, close and retained cleanup

The first version offers **close-only reconciliation**, not resumption of an uncertain
operation. Under the same held locks it may verify that the canonical entry is exactly the
retained replacement inode and bytes, retry directory sync, and finish cleanup of its exact
owned staging entry. On success it discards the withheld result/effects, closes the writer
and reports that the file contains the candidate. It never runs the transition again or
publishes that operation's claims later. If identity, bytes, removal or sync remains
uncertain, close returns retained uncertainty and keeps both locks.

For a pre-rename cleanup failure, close may remove only the matching owned staging inode,
sync the directory and verify the original baseline, then close. It cannot delete a
replacement entry, sweep temporary names or repair ownership by recreating the lock. A
failed close is sticky until these checks succeed. No ordinary operation can clear it.

Make the last-drop case explicit: the one fixture resource slot is reserved before creation
and can park the entire unresolved resource owner if the caller drops a failed constructor
or writer. Parking retains descriptors, locks and capacity until private checked cleanup
succeeds or the process exits. A second admission remains Busy. There is no unbounded leak
list, recursive Drop cleanup, public adoption API or caller assertion that cleanup happened.
Poisoning or panic in cleanup also retains the slot. Clean close releases writer locks, but
the resource slot remains occupied while the closed copy capability exists. Last copy-handle
Drop parks the remaining copy owner until checked destruction, rather than admitting a new
copy while the old directory remains. Destroying the copied directory is a separate
identity-checked operation after all copy handles are returned; only its confirmed success
releases the slot. It removes only known matching entries, never arbitrary contents.

A process crash releases kernel locks. The fixture parent may retain the original copy
capability and reopen after reaping the exact child. Reopen reads only canonical
`routines.json`; it never adopts a staging file as committed state. Old crash staging files
are preserved, bounded and not automatically deleted. Recovery cleanup of those files is
outside the writer: tests may remove an exact inode they retained as test evidence, after
all assertions and child cleanup. Unknown entries or exceeded orphan bounds refuse further
mutation rather than prompting a directory sweep.

After a post-rename claim uncertainty or crash, a new writer sees the persisted running Run.
An explicit `recoverInterrupted` uses the existing state semantics to fail it and advance
overdue schedules without returning it for dispatch. Repeating recovery does not recount
that Run. If the crash preceded rename, the old due state may still be claimable because
no claim escaped. This proves no replay of a persisted uncertain claim within the copied
store; it does not prove exactly-once external execution or effect delivery.

## Bounds

Retain every accepted state bound: 4 MiB input/image, 131072 aggregate JSON value nodes,
depth 32, 16 KiB encoded metadata strings/keys, 64 Routines, 4096 Runs and 4096 tombstones.
Unknown retained metadata counts. These are not heap/RSS bounds. Hold at most one prepared
candidate and one current staging file; bounded read buffers avoid loading an unbounded
file before validation. Prebuild indexes and pending observations before native commit.

The proposed fixture permits one admitted copy per process, one writer and one in-flight
operation. Current staging and preserved crash staging files share eight entry slots, each
an owned `0600`, single-link regular file no larger than 4 MiB. Reserve a free slot before
creating a stage, so a crash cannot exceed the orphan budget. A bounded directory scan
recognizes only fixed entries and the private generated staging-name grammar; unexpected
entries or an exhausted staging budget refuse new staging. Do not parse, adopt or delete
those orphans. Including the canonical image gives at most 36 MiB of admitted data-file
content, plus fixed small marker/lock metadata. Interference is fenced, not forcibly reduced
to fit.

The fixture command/observation stream stays bounded as in the state fixture. OS filesystem
calls are synchronous: byte/work limits are not a hard wall-clock completion guarantee.
There is no cancellation thread which could release ownership while a syscall still runs.

## Review slices and acceptance gates

1. **Candidate seam, no filesystem yet.** Prepare/install the actual private model with
   indexes and effects fully allocated before publication. Preserve all current 48 tests,
   doctest, 25-trace/841-observation store oracle, refusal corpora, six store mutants and
   cron gates. Add direct tests for dropping a candidate, no-write maintenance, ID
   consumption and atomic batch failure. Wrong-origin, stale, duplicate installation and
   second-preparation tests must leave the original pending/current model unchanged.
   Freeze this seam for source review.
2. **Fresh copy and single native publication.** Add the private descriptor owner and
   state machine, then run the same admitted Node traces against actual Rust file bytes.
   Add syscall failure points inside the private I/O implementation, never a public
   callback or a fixture-provided durability success. This slice includes the reserved
   resource slot, retained-owner and last-Drop mechanism before any native write is added.
   Cover creation, partial write, file
   sync, pre-rename verification, rename, directory sync, post-rename verification and
   staging removal. Exercise caught panics at the same owned phases. Freeze before crashes.
3. **Retained cleanup and real process crashes.** Add exact-child crash barriers and
   retained-capability reopen. Extend source/hash/mutation gates and record actual process
   results. Independent review must cover last Drop, partial construction and uncertainty
   classification before calling this a copied writer checkpoint.

The filesystem tests must assert all of the following, rather than only checking errors:

| Case | Required evidence |
| --- | --- |
| Clean refusal before rename | Old canonical bytes and inode, logical state/indexes/maintenance unchanged; IDs consumed in source order; no result/effects; owned stage removed; retry allowed only after clean ownership verification. |
| Failure after rename | New canonical bytes/inode can be present while the model is fenced; no claims/effects escape; no rollback rename; subsequent operation/reload refused; close-only reconciliation never executes the mutation again. |
| Cleanup failure | Matching stage and locks remain owned; a second writer process fails both before and after caller Drop; restoring the same identity permits checked cleanup; replacing it with a sentinel never permits deletion or a false clean close. |
| Identity interference | Parent/child rename or symlink, marker/token change, lock replacement, same-byte canonical replacement, mode/link-count changes and staging replacement all refuse. Sentinel contents survive. No arbitrary existing path is admitted. |
| Constructor/panic ownership | Fail after each creation before final admission, including pin failure. Confirm no created inode loses its cleanup owner; unresolved cleanup retains the one slot. Catchable pre/post-rename panic follows the corresponding refusal/uncertainty rule. |

Use the accounts exec-only crash-test pattern: the parent keeps the copy capability, the
child receives inherited pinned descriptors only in test code, acquires its own fresh lock
descriptions and signals a bounded named barrier. The parent kills and reaps that exact
child; no process-group/descendant authority is needed. There is no normal capability
deserializer or path argument. Test real SIGKILL after staging write, after file sync,
immediately before rename, immediately after rename, after directory sync, and before
logical publication/result handoff. Assert complete old/new JSON, kernel lock release,
staging non-adoption and explicit recovery without replay. A process kill cannot prove
what storage hardware retains across power loss.

Compile semantic mutants that publish/return claims before rename, classify a post-rename
sync failure as retryable, advance the model on refusal, release locks during uncertain
cleanup, remove a replacement staging inode, and adopt a crash staging file. A compile
failure is not a killed mutant. Keep actual Node error/byte/effect parity separate from the
additional Rust ownership guarantees and intentional refusal cases. Finish with offline
locked tests, strict Clippy, fmt, Node syntax/tests and source-drift checks.

## Deferred work

Corrupt backup and invalid-row quarantine require their own plan for independent archive and
canonical publications, bounded archive retention, collisions and crash recovery. Node's
ignored corrupt-backup failure and usable filtered view after failed repair must be recorded
as source behavior, even if a later Rust owner deliberately refuses those cases more safely.
No repair may discard unsupported event/flow or SystemV-bearing records and open a writable
subset under the current state contract.

Production profile admission, runtime registration, timer/scheduler behavior, Chat/Project
ownership, dispatch, providers, flow actions and external effect cleanup remain absent.
Source-level claims are still copied observations, with no execution authority. Reusing a
shared storage implementation across crates or widening the retained-copy recovery API
requires a later reviewed scope; this proposal edits only rust-routines.

## Audit source pins

The implementation should add these writer inputs to a separate drift gate. Preserve the
accepted store and cron manifests and their full transitive-source checks.

| Repository path | SHA-256 |
| --- | --- |
| `packages/core/src/routines/store.cjs` | `c8af1c739391cc7b337ecc112be17cd5c1e0d8c30dc572d65e27fd022babbc67` |
| `packages/core/src/routines/store.test.cjs` | `22e3634eb051ecfb060df6188b1299a208a6f79203a87824c0e4f12edb970a0e` |
| `packages/core/src/runtime.cjs` | `3d44a7e175df281bd09740384fcda839d549e8fb4afbfb24d3b42be859bdd839` |
| `experiments/rust-accounts/src/store.rs` | `0a007fa1d12c91674a5dac8dda9b35f0db81a38f3a89fa0cfe3a4fb534ecb894` |
| `experiments/rust-accounts/src/service.rs` | `7727c2dbe77a02ade9e86b29e7a5e09c17fc2e666656a56e5b442dd59898e2f8` |
| `experiments/rust-accounts/src/recovery_tests.rs` | `1df044ab1fa290028bd89077ba495d9bf359a6f6e65bdbd6a3d7fce78c392a0d` |
| `experiments/rust-registry/src/writer/storage.rs` | `96c8d4a5c78cd115ae87972c27e41ccc29bb3db2bdfc085af24fb8f1e622903a` |
| `experiments/rust-registry/src/writer/mod.rs` | `6414b6ef0802101d833610247e9f2d7f8f595ab0d792eb2a4aae03fd84138dc6` |
| `experiments/rust-owner/src/isolation.rs` | `00a1c891e3696573dd8ed57db4cb9899f8d962dfda924d31202f9e4c0551e8a4` |
| `experiments/rust-routines/src/store/mod.rs` (accepted seam baseline) | `8bbb422060095a5370b8f728bf15d479fe4b42a551ccd1bc1dbaa272be91db8b` |
