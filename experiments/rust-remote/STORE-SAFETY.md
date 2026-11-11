# Persistent store safety follow-ups

These checkpoints implement the three store prerequisites agreed in 885e37ad before persistent supervisor wiring. Fresh synthetic capabilities only; no existing-profile import, live keys, network, production host or mobile change.

## 1. Read-only limits rejection

`PersistentLimits::validate()` is a pure check of policy and registry configuration. Call it before acquiring a writer where possible. Snapshot-dependent active-device counts are checked under both locks. A read-only InvalidLimits result now returns `OpenedAuthority::Rejected(RejectedAuthority)` instead of poisoning an otherwise clean profile.

The rejection owns the same non-Clone writer. `retry(self, limits, rng)` revalidates its unstarted proof and moves that lease back through resume. `release(self)` restores only the previous broker acknowledgment, writes no snapshot and creates no CleanStop. Drop does the same read-only validation; an unchanged valid profile remains eligible for corrected retry. PID, original locked descriptors, pinned identities, exact prior snapshot stamp, current attempt, last stamp, no write attempt and an unpoisoned broker ledger are required. Generic WriterLease Drop still invalidates eligibility.

A failed release returns `RejectedReleaseFailure`; `into_parts()` yields `(StoreFault, Quarantine)` retaining the exact writer locks. A failed Drop check fails closed. Every commit attempt permanently consumes unstarted eligibility before storage is touched, even if encoding, writing or syncing fails. Running/retired/quarantine outcomes cannot masquerade as pre-write rejection.

Validation: 163 tests and seven doctests passed after this change; focused cases cover invalid policy/registry limits, stored active count, corrected same-lease retry, release/reacquire, rejected Drop, descriptor substitution, poisoned ledger and successful/failed commit attempts. Strict Clippy and formatting are required for the checkpoint. Existing Node checks will run again after all three store commits; this change adds no protocol behavior.
