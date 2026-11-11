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

## 3. Retired serialized credentials

`retire_identity` now fills the terminal candidate's box secret and pairing token with zeros before encoding. The strict codec rejects any retired snapshot containing nonzero credential bytes, on both encode and decode. Retired remains terminal; these zero bytes cannot authorize a connection. Clean restart of a current identity still preserves its generated credentials.

Tests compare the actual persisted JSON against the previous synthetic secret/token encodings without printing either value. They require both zero fields and terminal resume, and reject retired snapshots that retain either credential. Faults before write, file sync, rename and final directory sync retain the exact original root/file locks. Before rename the current snapshot still contains the original credentials; after a failed final sync a zeroed Retired snapshot may be visible, but no receipt is issued and the next attempt quarantines. No fault reports retirement or erasure success.

This sanitizes only the successfully replaced current snapshot. No memory zeroization or secure erasure of old inodes, filesystem snapshots, backups or freed blocks is claimed. The preliminary synthetic retired format retaining credentials is now refused rather than migrated; there is no existing-profile importer.

Final validation for the three safety commits: 168 Rust tests, seven doctests, strict all-target Clippy, formatting/diff checks and all seven existing Node checks pass. The 159-test baseline remains covered; nine tests were added. All subprocesses use fresh marked profiles and synthetic material. Persistent supervisor implementation remains pending independent review of this safety chain.
