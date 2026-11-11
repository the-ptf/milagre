# Private persistent supervisor composition

This checkpoint implements the internal phase, approval and carrier hooks from the concluded persistent-supervisor contract. It adds no persistent worker, owner client, queue, join receipt or automatic tick. Only the existing synchronous PersistentAuthority and the injected MemoryCarrier are composed. All disk tests create fresh synthetic profiles; no existing profile, imported credentials, live network, real HTTP executor or mobile change is involved.

## Phase and retained ownership

The private phase is Running, Quiesced or Aborted. `quiesce_for_join()` derives eligibility from authority health, revocation-lock health and the recorded storage fault. It marks Aborted before teardown, revokes all access, cancels tickets/registry work, closes registry handles, then records Quiesced only after that succeeds. Repeating healthy quiescence is harmless. Ordinary operations refuse in either terminal phase. Diagnostics and the public host identity remain readable. This method neither writes a snapshot nor acknowledges the broker, and it does not prove a thread has joined.

`abort_in_place()` dominates even an already completed quiescence. `abort_without_commit(self)` revokes and returns StoppedAuthority holding the original WriterLease, without terminal IO. Fatal policy/storage retirement and poisoned access cannot become eligible through quiescence. Wrong-PID paths retain the existing refuse-before-inherited-lock behavior.

The standalone public `close_for_restart` and `retire_identity` now use this phase transition before their existing consuming terminal write. Only explicit terminal success acknowledges Clean/Retired. Drop still makes no write. A typed failure returns the existing CloseFailure and exact stopped writer guard; no clean retry or implicit replay is added. Unexpected unwind during consuming terminal close remains outside the retained-result guarantee. Synchronous fsync may block; this layer has no force or timeout path.

The future worker must retain the authority outside its unwind boundary, close every owned mailbox and release queue/carrier leases, exit, and be joined before its owner consumes terminal close. This checkpoint does not supply that orchestration or claim that a quiesced registry has drained mailboxes owned by its caller.

## Approval and carrier boundary

All new hooks and types are crate-private. No mutable Registry, Session, channel, reply or writer is exported.

| Hook                                                                    | Ownership and checks                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `begin_for_carrier(handle, source, hello, now, rng)`                    | Creates an opaque consuming CarrierTicket bound to the exact pending carrier generation and authority ticket. A bounded internal map tracks that association.                                                                           |
| `pending_for_carrier(&ticket)`                                          | Returns device metadata only for the current association.                                                                                                                                                                               |
| `prepare_pending_approval(&ticket, now)`                                | Requires first-time desktop approval, derives the absolute deadline from the owned ticket, and protects the pending carrier. Accepts no caller deadline. Repeated/failed preparation cancels that exact association.                    |
| `complete_for_carrier(ticket, decision, fresh_clock)`                   | Consumes the association and PhoneOrKnown/ApprovedDesktop decision. Rechecks records, kind, window and fresh post-IO time, persists enrollment before authorization, establishes internally, and returns only the mailbox Access guard. |
| `cancel_carrier_ticket(ticket, reason)`                                 | Cancels the exact association. An old ticket cannot close a replacement carrier or newer same-device ticket.                                                                                                                            |
| `take_output_owned`, `send_for_carrier`, `close_carrier`, `global_pool` | Forward guarded registry operations and the same store/device/connection budget pool. Ciphertext and its existing Reservation move together.                                                                                            |

Replacement, removal, pairing-window changes, disconnect and ticks reconcile authority tickets with protected carriers. The map has at most one entry per current carrier and never grows beyond the registry carrier bound. Deadline equality is expired. Successful enrollment followed by expiry during its write yields no ACCEPT, but the durable record remains; completion is not replayed.

MemoryCarrier now has a shared crate-private `bind_access` operation used by both compositions. It installs one guard only on a bound open mailbox, acquiring the epoch guard before the mailbox mutex. Removal invalidates buffered receive before its durable write, even if the mailbox has not yet been physically closed. A future actor must still close its mailbox on disconnect, replacement, quiescence or delivery failure. Already returned caller-owned bytes cannot be recalled. Transfer charges no second frame lease; closing the mailbox releases its retained packets. Unknown delivery closes only the affected registry carrier and cannot retry its popped frame.

Dropping a private CarrierTicket alone does not perform cancellation. Its future worker owns it in a pending entry and must reconcile the separate approval decision guard. The public consuming approval permit, Full-returned exact permit, non-retryable Stop/expired/replaced refusals and dropped-permit cancellation remain part of the next reviewed owner checkpoint.

## Evidence and remaining review gate

Twelve added tests cover healthy quiescence, sticky abort, access poison, modeled reservation failure after Running, retained locks, snapshot byte equality, terminal sync ambiguity, pending/inflight cancellation, stale output callbacks, ticket-derived approval deadlines, equality expiry, repeated/failed/closed approvals, duplicate/expired HELLO cleanup, replacement by carrier id and by device, new windows, removal/re-pair, post-commit expiry, guarded mailbox receive during removal, lease transfer and unknown-delivery isolation. The preexisting descriptor/subprocess and wire fixtures remain separate evidence.

This checkpoint passes 180 Rust tests, seven doctests, strict all-target Clippy, formatting and all seven Node checks. The Node checks are unchanged actual-source synthetic fixtures, not persistent-supervisor tests or actual phone interoperability.

The next checkpoint still must implement and test the retained joined worker, out-of-band Abort-dominant stop, typed start/close guard ownership, queue rejection/approval permit ownership, automatic deadline wakeups, startup/spawn/panic/poisoned-retained-slot recovery, terminal acknowledgment ordering and lease drainage. The reservation-failure test here exercises authority abort after Running; it does not claim worker startup recovery or mutex-slot recovery.

Reserved revocation versus duplicate DrainWork, Disconnect saturation, fairness and atomic real HTTP Claim/cancellation remain separate P3 gates. Production import/recovery, broker loss, real carriers/listeners, relay/host lifecycle and live phone interoperability remain excluded. Existing Node disk-format differences and JSON dense-state/lossless-byte constraints are unchanged.
