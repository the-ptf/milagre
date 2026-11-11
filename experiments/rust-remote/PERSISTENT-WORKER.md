# Joined persistent synthetic service

`persistent_supervisor::PersistentSupervisor` owns a fresh `SyntheticProfile`, its retained authority/Registry and one joined Rust thread. `start(profile, supervisor::Limits, Clock)` accepts no path, descriptor, imported state or keys. The unchanged disposable Supervisor remains separate. The lifecycle-only checkpoint is `5950296e`; the next service checkpoint adds commands, consuming approvals and automatic carrier deadlines.

## Ownership and terminal outcomes

Static limits and known queue/control/event accounting are prepared before writer acquisition, from the profile's existing global pool. Snapshot-dependent InvalidLimits retains RejectedAuthority's unstarted proof. After Running, startup reservation failure, spawn refusal and startup panic return dirty stopped ownership. A capacity-one startup handoff precedes exposing the owner client. The startup RAII owner holds its profile, retained runtime slot and any JoinHandle before waiting.

The worker borrows its runtime from the retained slot and never consumes terminal close. Its inner run-loop unwind is caught while ownership remains outside; an outer unwind or poisoned retained-slot/queue mutex can only abort. Poison recovery retains the value solely for cleanup and guard extraction. It never clears poison to resume. The out-of-band stop latch is independent of queue capacity: Running, Requested, Abort. Abort dominates Requested, and a separate sticky fatal fault cannot be hidden by a prior healthy stop request.

`close_for_restart(self)` and `retire_identity(self)` disable admission, revoke access/cancel work, close mailboxes, reject queued commands, drain leases, join, then extract the retained authority and invoke terminal persistence on the joining owner. Owner-side drainage also covers an unexpected outer worker unwind. Success owns a CleanStop/RetiredStop receipt plus the same profile; `into_parts()` transfers both. Default Drop and `abort(self)` stop and join without terminal writes. There is no force path, join timeout, detached JoinHandle, reset or clean retry.

`PersistentStartFailure`, `PersistentCloseFailure` and `PersistentReleaseFailure` expose redacted faults and an owning StoppedService. It retains the profile and any original writer guard. `release()` returns the profile; failed descriptor revalidation of a read-only rejected lease instead returns the same capability and exact Quarantine locks. Dirty release never restores Clean. Explicit destruction uses the returned profile's borrowed `destroy` operation. ServiceDiagnostics contains optional validated store metadata and whether a worker was joined. No path, token, panic payload or arbitrary IO message is returned. Rust's existing panic hook can print deliberately injected test panic messages; the service discards the caught payload.

Synchronous filesystem calls may delay ticks and shutdown. Unexpected unwind inside consuming terminal persistence remains outside the retained-result guarantee, as agreed. This is joined thread replacement while the in-process broker capability survives, not public cross-process restart or recovery after broker loss.

## Owner, carrier and approval APIs

`owner()` returns cloneable PersistentOwnerClient. PersistentCommand supports Attach, Hello, Request, Send, Disconnect, OpenPairing, EnableDesktop, RemoveDevice, DrainWork, Finish and DispatchSynthetic. Trusted-owner HostPublicKey, PairingInvitation and AdmissionStatus queries expose synthetic invitation delivery and bounded admission diagnostics. PairingInvitation returns an owned synthetic token only within the open window. It is not available to the carrier capability. There is no Replace command or command that mints a durable retirement receipt.

`owner.carrier(handle, source)` binds PersistentCarrierClient to one generation and trusted source assignment. It accepts only the existing CarrierCommand Hello/Request/Disconnect variants. A compile-fail doctest prevents policy escalation. Relay source assignment does not invent per-phone IP identity. Clients retain bounded empty Shared/status storage after termination, with no profile, writer, runtime slot or successor capability.

`Event::Approval` contains public device metadata, the derived deadline and a non-Clone PersistentApproval. Only `owner.approve(permit)` accepts it; generic submit has no approval variant. Under queue synchronization it checks stop, service scope, deadline, carrier generation and decision state before capacity. The transitions are Live, Queued, Consumed or Cancelled:

- Full returns the exact still-unqueued permit through `ApprovalRejection::Full`. Every retry rechecks eligibility.
- Stopped, Expired, Replaced and Revoked return `Unavailable(ApprovalRefusal)` with no reusable permit.
- Successful enqueue moves the permit once and marks it Queued. Execution rechecks the exact pending ticket before consuming its decision and durable authorization.
- Dropping a live or Full-returned permit cancels its exact decision; automatic maintenance closes that protected carrier. Dropping a successful receipt cannot cancel, reconstruct or replay the queued approval.

Authority tickets stay in the retained worker. Replacement, disconnect, new window, removal, deadline equality and shutdown cancel matching bindings. A stale permit cannot remove or close a newer same-id or same-device association. The default desktop deadline is the remaining 600,000 ms window; approval can outlive the 15,000 ms hello deadline but cannot extend its ticket. Restart restores no window, pending approval or desktop-enable state.

## Scheduling, budgets and unknown outcomes

The worker wakes at the configured 1..100 ms cadence with injected ManualClock or monotonic time. Maintenance runs after waits and before queued continuations. Idle, hello, approval, fragment and request deadlines require no caller polling. Clock/authority failures and authoritative event overflow abort. Advisory closures are dropped/coalesced within the existing bound; WorkAvailable is an edge-triggered readiness observation. Only successful initial DrainWork acknowledges readiness; refused drains and lost receipts cannot lose tokens. Draining does not claim or replay a request.

Data ingress preserves existing count/byte, per-carrier and source limits. The eight control slots share the prepaid 18 KiB reserve. Queues, event leases, profile working storage and every carrier share the same global pool. Frame bytes and their Reservation move into MemoryCarrier once. Removal revokes buffered receive before its durable write, and close drains mailbox packets before terminal acknowledgment. Final accounting retains only the profile's 12 MiB working charge while that capability lives.

Queued commands rejected at stop return NotExecuted. A popped command that panics or completes after stop, or a lost/timed-out receipt, reports UnknownOutcome. Accepted mutations are never replayed. Receipts are published after releasing their ingress lease. A successful later Clean stop does not prove delivery of an earlier unknown result.

Synthetic HTTP retains the existing preflight reservations, response byte preservation, 340,000 ms timeout plus request-lifetime margin and one-shot MemoryHttp. Unknown delivery closes only its target carrier and never resends a frame or invokes HTTP again. A consumed MemoryHttp used with another work token is refused without closing that unrelated carrier. Real fetch, atomic Claim, asynchronous abort and batching remain absent.

## Evidence and remaining gates

The two checkpoints add 29 tests and one compile-fail doctest: seven lifecycle tests, 21 service tests and one service-release descriptor test. They cover pre-write correction, joined replacement, default Drop/abort, injected reservation/spawn/startup failures, poisoned retained slots/queues, worker panic, Abort precedence, every terminal IO stage, failed rejected-release ownership, saturated healthy/abort shutdown, authoritative event overflow, automatic expiry, approval Full retry/drop/refusal, stale permits/re-pair, post-commit unknown outcomes, buffered revocation, late callbacks, global/control reservations and lease drainage. Default 16 carriers times 16 requests use one readiness signal and remain drainable. Manual-clock tests verify 504 delivery at fetch timeout and refusal at request expiry. A 1,000-attach advisory flood does not retire the service.

Validation at this service checkpoint: 209 Rust tests, eight doctests, strict all-target Clippy, formatting and all seven Node fixture checks. Existing descriptor/subprocess tests and Node wire/source fixtures are separate evidence. None proves actual phone interoperability. An earlier lifecycle run saw the existing disposable-supervisor byte-count timing assertion fail once; the full rerun and final suite passed. That unrelated test was not changed.

The reserved control lane can still be filled by duplicate DrainWork, Disconnect admission can still meet carrier limits, and fairness remains unchanged. These P3 gates and real HTTP atomic Claim/cancellation remain separate. No production import, live profile/keys, host restart, mobile/native changes, shared daemon writer, network listener, relay/provider endpoint or push is involved. Node disk-format/metadata differences, broker-loss recovery and existing dense-state JSON compatibility limits remain documented exclusions. Independent review of these checkpoints is still required before production adoption.
