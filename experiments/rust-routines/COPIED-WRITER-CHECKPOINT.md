# Private fresh copied-store writer

Status: accepted after implementation-agent checks, root validation and Claude Sonnet's
independent source review/rereview. This is slice 2 of `WRITER-PLAN.md` at `785989a3`, on the accepted candidate seam
`9fdf0c0c`. Real process-crash/reopen work in slice 3 has not started.

## Admission and ownership

`src/store/copied` is private to tests and explicit fixture targets. The normal library
still exports only cron helpers. `Copy::create` accepts bounded seed bytes, never a path,
environment, callback or caller claim of successful durability. It validates the existing
schedule/Heartbeat domain, then reserves one process-wide slot before filesystem creation.
Invalid, corrupt, wrong-version, mixed event/flow and unsupported timezone seeds remain
whole-input refusals. No quarantine, repair or writable-empty fallback is performed.

Copies are fresh `0700` children of the fixed canonical `/tmp` or `/private/tmp`, independent
of HOME/TMPDIR. The owner holds the parent and child descriptors, original marker and lock
inodes, a random copy token, and exact canonical file bytes/inode or checked absence.
The child name and fixed marker/lock/canonical descriptor slots exist before creation.
A missing descriptor permits cleanup only when its fixed entry is absent; an existing
unpinned entry is retained as uncertainty. There is no intent journal or unused intent list.
Generated staging names are stored before exclusive creation, and every returned FD is
retained before writing or validation. File operations use held descriptors and fixed/generated
basenames with no symlink following. Regular files require effective-UID ownership, mode
`0600` and one link. Reads check metadata and bounded bytes through the held descriptor.

Each non-Clone writer acquires independent nonblocking directory and lock-file flocks.
The directory lock prevents replacing the lock pathname from admitting a second writer.
Copy capabilities can be cloned, but they carry no writer lock. Rechecks cover the fixed
parent identity, child linkage, marker/token, original lock, modes, link count and exact
canonical inode/bytes. Same bytes in a replacement inode still refuse.

The single resource slot remains reserved after writer close, while any copy handle exists,
and after the last handle drops. Unresolved writer/copy owners move into that slot without
a new allocation. It retains their descriptors, locks and candidate. Checked retained-owner
cleanup takes no path or proof input. Checked directory destruction releases the slot only
after exact owned entries are removed and parent-directory sync succeeds. Unknown entries
are preserved. There is no recursive destructor or temporary-file sweep.

These are cooperative same-UID checks, tested on macOS. They do not prevent a malicious
same-UID actor from changing entries after the final check. The fixed system temp parent is
verified read-only; tests do not rename or modify the machine's `/tmp` parent.

## Publication and failure boundary

The accepted Model prepares one origin/generation-bound candidate with its data, indexes,
tracking, result and effects before native publication. The writer retains that candidate
and one immutable byte image through the following steps:

1. Verify owner/canonical identity and reserve a bounded staging entry. Register its name
   before exclusive creation, then retain the returned FD before any further operation.
2. Write the complete image and sync the staging file. Recheck owner, canonical and staging
   identity and exact staged bytes before rename.
3. Rename within the held directory. Mark the private pending operation renamed immediately
   after syscall success, before any fallible operation. Sync the directory and verify the
   installed inode, contents, marker and locks.
4. Move the prebuilt native file baseline into the copy owner, then install the exact Model
   candidate. Only this path releases its result/effects. Installation adds no serialization
   or index construction after publication.

A pre-rename I/O refusal returns only after the matching staging inode is removed, the
directory is synced and the old canonical baseline still verifies. The old model/file stay
current and already consumed IDs stay consumed. Staging-capacity exhaustion is a distinct
clean refusal. Observed ownership/content interference fences the writer even before rename.

Any error or caught panic after rename returns uncertainty and retains the candidate and
locks. The writer blocks reads, mutations, reload and claim delivery. Close-only
reconciliation verifies the exact replacement and bytes, retries directory sync and checks
cleanup. It never reexecutes the transition or installs/returns the withheld claim later.
After proven cleanup, the closed owner can drop that candidate; the exact retained copy may
open a new Model from the actual canonical file. Explicit `recoverInterrupted` then fails
a persisted running Run without claiming it again. This is in-process retained-capability
recovery, not process-crash evidence.

Pre-rename cleanup uncertainty also retains the exact owner and locks. A replacement staging
entry is never deleted. Last writer Drop parks uncertain ownership instead of retrying it
implicitly. Partial constructors use the same retained slot; failed teardown retains its
directory/file locks too.

A poisoned copy-data mutex is never repaired or cleared. Existing open/read/write/close
operations refuse it permanently. In particular, a parked writer still holds that poisoned
Root: repeated `cleanup_retained` cannot acquire it, returns uncertainty and retains its
locks/capacity until process exit. There is no poison recovery or writer-reopen claim. A
copy-only destructor may extract bare retained Data for checked destruction; that can remove
owned resources but never restores the poisoned copy or writer. No subprocess poisoning
regression is claimed in this slice; adding retained ownership across process exit belongs
to the separately reviewed slice 3 boundary.

No-write operations and valid-file load upkeep preserve the existing difference between
logical state and last file bytes. The copied fixture reads actual canonical descriptor
bytes for its `file` observation. Observation verification failures also fence the writer.

## Bounds and dependencies

State limits remain 4 MiB per input/image, 131072 aggregate JSON nodes including unknown
metadata, depth 32, 16 KiB encoded metadata strings/keys, 64 Routines, 4096 Runs and 4096
tombstones. These are not heap/RSS bounds. There is one admitted copy, one writer and one
pending operation. Current and preserved staging entries share eight slots, each at most
4 MiB. A bounded descriptor-relative scan rejects unknown names/types or excess entries;
existing staging files are never parsed, adopted or removed automatically. Admitted data
file content is at most 36 MiB including the canonical image, plus small fixed metadata.

Native filesystem calls are synchronous. Bounded bytes/work are not a hard wall-clock
guarantee. File/directory sync success is not a claim about storage hardware across a power
loss. No journal or process-crash protocol has been added.

The only direct additions are dev-dependencies `libc =0.2.191` and `uuid =1.29.2` with `v4`,
resolved offline with checksums in Cargo.lock. The latter resolves getrandom 0.4.3.
No tempfile dependency is needed because construction owns descriptor-relative mkdir from
the start. `cargo tree --edges normal` is unchanged: there is no owner, registry, accounts,
Tokio or filesystem dependency in the normal library graph.

The writer-plan table currently contains ten paths. Three production paths (store, store
tests and runtime) are already covered by `store-oracle-manifest.json`. Six reviewed
ownership paths are now hash-pinned by the native source test: accounts store/service/recovery
tests, registry writer/storage and writer/mod, and owner isolation. The test cross-checks
those hashes and the existing manifest against the plan. The tenth path is the historical
pre-seam Model baseline, explicitly preserved as history rather than checked against today's
changed implementation. Existing production store/cron/validator, codec and timezone pins
are unchanged; no oracle hashes were silently refreshed.

## Evidence and remaining boundary

Nineteen new native/source tests cover successful physical publication, independent locks,
pre-rename fault/panic loops, post-rename uncertainty, close-only recovery, partial-constructor
retention, last writer/copy Drop, closed-copy capacity, stage/canonical replacement sentinels,
root rename/symlink, canonical/lock symlinks, mode/link-count/byte/token interference, read
fencing, orphan bounds, seed/load upkeep, invalid seed admission and source pins. The added
post-rename Drop test observes the saved candidate bytes before teardown, proves both locks
and new-copy admission remain Busy, and exercises exact retained close-only cleanup. With a
copy handle retained, cleanup closes the parked writer but returns Busy for copy destruction;
reopening then sees the saved Run, returns no second claim and permits explicit recovery.
With all copy handles dropped, checked cleanup destroys the copy and releases the slot.

Fault tests perform real file creation/write/rename/cleanup around private injected errors.
They include a real partial write before refusal and an actual fixed-stage byte mutation.
Sync errors are injected at the corresponding private syscall boundary; tests do not claim
to cause hardware I/O faults or power cuts. Panic injection uses the same owned phases.
There is no public callback or input that reports durability success.

| Check | Result | Local implementation-agent log |
| --- | --- | --- |
| Targeted native tests after review | 19 pass | `/tmp/milagre-routines-writer-reviewed-targeted.log` |
| Offline locked Rust tests after review | 80 tests plus one doctest pass | `/tmp/milagre-routines-writer-reviewed-tests.log` |
| Strict Clippy/fmt after review | All targets pass with warnings denied; formatter passes | `/tmp/milagre-routines-writer-reviewed-clippy.log`, `/tmp/milagre-routines-writer-reviewed-fmt.log` |
| Actual copied-file Node oracle after review | 25 traces and 841 observations match | `/tmp/milagre-routines-writer-reviewed-copied-parity.log` |
| Original pure-model Node oracle | 25 traces and 841 observations match | `/tmp/milagre-routines-writer-model-parity.log` |
| Separate refusal corpus | Each fixture checks eight seed and 90 ID refusals against actual Node | Same parity logs, excluded from matching counts |
| Existing compiled store mutants | All six compiled model mutants killed by actual Node observations | `/tmp/milagre-routines-writer-model-mutants.log` |
| Existing Node store/cron tests | 157 pass | `/tmp/milagre-routines-writer-node.log` |
| Normal dependency graph | Unchanged, checked offline/locked | `/tmp/milagre-routines-writer-normal-graph.log` |

The targeted/full Rust, Clippy/fmt and copied-file oracle checks above were repeated after
the acceptance-review amendments. Pure-model oracle, model mutants and production Node
test results are retained from the preceding freeze; those algorithms/sources did not change.

Root independently passed the amended 80 Rust tests plus one doctest, strict all-target
Clippy and formatting. Logs: `/tmp/milagre-routines-writer-root-amended-{tests,clippy,fmt}.log`.
Root's preceding copied-file and model oracle runs each passed 841 observations plus the
98 separately reported refusals; the amended copied-file rerun is the agent result above.
Claude Sonnet closed all four acceptance findings by source reading, not execution. Poison
recoverability and real process-crash/native-mutation evidence remain explicitly unclaimed.

The new Drop test initially over-specified `copy.open` as returning Busy: its existing
canonical check can refuse identity before reaching flock. The corrected test requires
refusal and independently proves both kernel locks and new-copy admission are Busy.
The original full failed log was overwritten by the successful rerun; a captured excerpt
is retained at `/tmp/milagre-routines-writer-reviewed-initial-failure.log`. Its one private
test copy, `/tmp/milagre-routine-copy-ab386965-1db3-479e-b02d-a1d0c2891efc`, was removed after
checking device/inode, UID/modes, all file identities, token, synthetic contents and locks.
Directory and parent sync succeeded; cleanup evidence is
`/tmp/milagre-routines-writer-reviewed-cleanup.log`. Runtime refusal behavior was unchanged.

Root owns the checker addition `--rust-example copied_store_fixture`; the default remains
`store_fixture`. Both use the same actual Node factory and resolved source/hash gates. The
checks use a fresh temporary NODE_PATH link to this worktree's exact `packages/shared`,
without changing repository package links. Model mutation checks remain explicitly distinct
from native-owner mutation/crash acceptance.

Slice 3 still needs actual killed-process barriers, exact child
reaping and retained-capability reopen, plus its native ownership/publication mutants. There
is no claim that a parent can already adopt a child-published replacement inode after crash.
Corruption/quarantine, production profile admission, scheduler/dispatch, host/provider work,
external callbacks and end-to-end exactly-once execution remain absent.
