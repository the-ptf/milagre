# Persistent store safety follow-ups

These checkpoints implement the three store prerequisites agreed in 885e37ad before persistent supervisor wiring. Fresh synthetic capabilities only; no existing-profile import, live keys, network, production host or mobile change.

## 1. Read-only limits rejection

`PersistentLimits::validate()` is a pure check of policy and registry configuration. Call it before acquiring a writer where possible. Snapshot-dependent active-device counts are checked under both locks. A read-only InvalidLimits result now returns `OpenedAuthority::Rejected(RejectedAuthority)` instead of poisoning an otherwise clean profile.

The rejection owns the same non-Clone writer. `retry(self, limits, rng)` revalidates its unstarted proof and moves that lease back through resume. `release(self)` restores only the previous broker acknowledgment, writes no snapshot and creates no CleanStop. Drop does the same read-only validation; an unchanged valid profile remains eligible for corrected retry. PID, original locked descriptors, pinned identities, exact prior snapshot stamp, current attempt, last stamp, no write attempt and an unpoisoned broker ledger are required. Generic WriterLease Drop still invalidates eligibility.

A failed release returns `RejectedReleaseFailure`; `into_parts()` yields `(StoreFault, Quarantine)` retaining the exact writer locks. A failed Drop check fails closed. Every commit attempt permanently consumes unstarted eligibility before storage is touched, even if encoding, writing or syncing fails. Running/retired/quarantine outcomes cannot masquerade as pre-write rejection.

Validation: 163 tests and seven doctests passed after this change; focused cases cover invalid policy/registry limits, stored active count, corrected same-lease retry, release/reacquire, rejected Drop, descriptor substitution, poisoned ledger and successful/failed commit attempts. Strict Clippy and formatting are required for the checkpoint. Existing Node checks will run again after all three store commits; this change adds no protocol behavior.

## 2. Interrupted transaction destruction

An interrupted worker's reserved `transaction` can now be adopted for deletion during explicit `SyntheticProfile::destroy(&mut self)`, even when that worker's process-local inode ledger did not reach the surviving broker. Quarantine still refuses admission; callers release its writer before destroying through the original fresh capability. This does not recover or replay the transaction, change a snapshot, restore acknowledgment, or permit a new run.

Destruction holds the original root and writer-file locks. It validates the entire bounded directory inventory, opens and pins each known regular file without following links (nonblocking open), checks owner/0600/single-link and descriptor/name identity, then rechecks those identities and the root spelling before each unlink. Only the reserved transaction name can be adopted; an already recorded inode mismatch is refused. Unknown names, symlinks, hardlinks, wrong modes and substituted entries remain untouched. Partial destruction retains both locks and the original capability for explicit retry. The fresh private namespace is the ownership boundary; this is not protection against a malicious same-UID process that can manufacture matching files.

New tests kill a real child after an empty transaction and after 19 real prefix bytes followed by an injected storage-full fault. Both remain quarantined until explicit release/destruction; neither has an inode entry in the parent's ledger. A failure immediately after transaction unlink retains both independently checked locks and leaves the snapshot unchanged; explicit retry finishes cleanup. Additional tests refuse hardlinks to the snapshot, symlinks, unexpected files, unsafe modes, recorded-inode substitution and replacement between inventory and unlink. No general temporary-directory sweep or existing-profile cleanup API was added.
