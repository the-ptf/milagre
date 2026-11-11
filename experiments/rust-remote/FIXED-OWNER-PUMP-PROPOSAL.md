# Checkpoint 3: private fixed owner commands and actor pump

Status: agreed by the parent after the checkpoint 2 review. Implementation is authorized as two separately reviewed commits. Only stage 1 (consuming owner preparation/status/admission and exact existing-mailbox adoption) proceeds now; fair pump, automatic delivery and completion wakes remain gated on stage 1 review. Baseline is the retained executor and tracked-output chain through `0febbd3a` and `e69819b0`: 298 Rust tests, eight doctests, seven Node checks, and independent source review with no P1/P2. This refines checkpoint 3 of [the fixed-Claim contract](FIXED-CLAIM-SUPERVISOR-PROPOSAL.md); [tracked-output ownership](TRACKED-FIXED-OUTPUT.md) remains mandatory. Earlier review summaries in those contracts and the current source are the evidence used here; the separately named historical review files are not present in this checkout.

The smallest executable boundary is an explicitly opted-in **private fixture mode of the existing PersistentSupervisor**. Real Attach/HELLO/Request/DrainWork commands produce authoritative WorkTokens. Private consuming owner commands prepare and submit fixed 200/502/504 work. The existing actor starts, polls, emits, verifies and disposes it without direct test calls into the authority. Ordinary `start`, `PersistentCommand`, `PersistentOwnerClient` and `PersistentCarrierClient` gain no public dispatch capability. There is no arbitrary executor, HTTP client, path/URL, production profile, real phone, host adapter or network.

## Private types and one complete flow

All following types and methods are crate-private in `persistent_supervisor::fixed`; fields and constructors remain module-private. `FixedOutcome` has only Success, Unavailable and Timeout. An ID contains a fresh service scope, status-slot index and checked generation, with no Arc/lease/worker ownership.

```rust
struct FixedFixture;                  // Explicit internal opt-in, no public constructor.
struct FixedOwnerClient;              // Weak service reference, no retained Runtime.
struct FixedId { scope: [u8; 16], slot: u16, generation: u64 }
struct FixedAttempt;                  // Non-Clone: ID plus weak service reference.
struct PrepareReceipt;                // Non-Clone handle to one prepaid reply slot.
struct FixedReceipt { id: FixedId }   // Observation only; Drop has no effect.
enum SubmitRejection {
    Full(FixedAttempt),               // Exact original, still unqueued permit.
    Unavailable(SubmitRefusal),       // No reusable permit.
}
enum SubmitRefusal { Stopped, Expired, Replaced, Revoked }
enum PrepareRefusal { Full, Stopped, Expired, Stale }

impl PersistentSupervisor {
    fn start_fixed_fixture(profile: SyntheticProfile, limits: Limits,
        clock: Clock, fixture: FixedFixture) -> Result<Self, PersistentStartFailure>;
    fn fixed_owner(&self) -> Option<FixedOwnerClient>;
}
impl FixedOwnerClient {
    fn prepare(&self, token: WorkToken) -> Result<PrepareReceipt, PrepareRefusal>;
    fn submit(&self, attempt: FixedAttempt, outcome: FixedOutcome)
        -> Result<FixedReceipt, SubmitRejection>;
    fn observe(&self, id: FixedId) -> Observation;
    fn cancel(&self, id: FixedId) -> Result<(), StatusRefusal>;
    fn ack_terminal(&self, id: FixedId) -> Result<(), StatusRefusal>;
}
```

`PrepareReceipt::wait(&mut self, timeout)` takes its result at most once and returns `Result<FixedAttempt, PrepareRefusal>`; timeout is an observation timeout, not a new attempt. The attempt exposes its ID before submission. Observation is fixed-size: Prepared/Queued/Claimed/Running/Ready/MaySend/Terminal, execution NotStarted/MayHaveRun, optional HTTP status, delivery None/MaySend/Returned/Unknown, and diagnostic cleanup-pending state. Terminal distinguishes NotClaimed(reason), Cancelled, TimedOut, Completed and DeliveryUnknown. Missing, acknowledged and previous-service IDs report Forgotten/Stopped, never NotStarted.

A fixture runs the existing handshake and consumes ACCEPT, then moves that actual synthetic peer Channel into the actor through private `adopt_peer(handle, peer)` setup. Its bounded setup rejection returns the same unqueued transfer on Full. An accepted setup failure destroys the moved peer and closes only that exact carrier; it cannot silently reconnect. The actor owns at most one peer per exact carrier. A private `request_fixture(handle, request_id)` command seals only an empty GET `/rpc` using that peer and applies the normal Request path. It supports later requests and keepalive traffic without a caller-owned mutex, closure or borrowed Channel crossing the worker thread. Arbitrary ordinary replies are outside this peer fixture; normal service behavior on other carriers stays intact.

The test then receives WorkAvailable, drains authoritative tokens, prepares an attempt, submits its fixed outcome and observes its ID. The actor emits when the core is actually joined and Ready, then calls the existing verifier with its owned peer. Only the real packet-return receipt permits Completed. Default fixture peers consume; a `cfg(test)` read barrier can leave a packet unread or delay receipt processing. No command accepts an acknowledgment, joined flag, delivery boolean or cleanup assertion. The existing direct `consume_fixed` still returns metadata only and exports no packet or peer.

## Bounded ownership and admission

| Storage            | Fixed bound and ownership                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status rows        | 512 globally, 32 per authoritative device, including prepared, queued, active and retained terminal rows. The run owns their backing and reservations.                              |
| Preparation        | 16 command entries and 16 reply cells; reply cells count queued, executing and unread results. Handles own no cells. Forgotten receipts can occupy this finite capacity until stop. |
| Submission         | 16 entries; at most one queued submission per device in addition to its one active claim. A full device queue returns the original attempt.                                         |
| Execution/output   | Existing two retained core slots, at most one active claim per device. A slot remains occupied through actual join and output cleanup.                                              |
| Carrier scheduling | At most 16 exact registered targets/peer slots. Device counts and scheduling use scans of fixed arrays, not a device-churn map.                                                     |

`WorkToken` is a Clone observational identity, not a consuming execution capability. The caller may retain a clone before `prepare`; a Full refusal leaves Registry eligibility untouched and never enqueues or retries implicitly. A later explicit prepare revalidates that same exact token, deadline and generation. If this type becomes non-Clone, preparation refusal must instead return the original token.

`prepare` admission reserves a command/reply cell under the same `Shared.queues` synchronization used by stop. The actor checks the actual WorkToken, device identity and assembly-plus-20,000 ms scheduling deadline, then installs a charged status row. Preparation does not claim, spawn or invoke. An unread successful preparation dropped with its receipt cancels that exact row. Dropping an unsubmitted attempt cancels only that attempt, leaving eligible Registry work untouched. A deliberately forgotten handle can retain only a bounded status/reply slot until stop.

Split current `Registry::inspect_claim` into a private authoritative readiness inspection and the existing execution/output preflight. Readiness returns fixed-size canonical device identity, exact work/carrier identity, ready deadline and the original ConnectionBudget; it does not borrow request bytes. It must allow preparing another eligible request while the same device has an active fenced claim. It does not bypass scheduling expiry, claimed-job exclusion or current authorization.

`submit` checks stop, scope, row generation, cancellation, carrier and deadline before capacity. Success atomically changes Live to Queued and moves ID/outcome into the submission ring. Full leaves the exact attempt live and returns it. An accepted receipt is only status observation; losing it never cancels, reconstructs or re-enqueues work. Multiple attempts may refer to one WorkToken, but authoritative Registry claim has one winner. Losing attempts become NotClaimed(Stale), with zero invocations.

The scheduler waits only for the existing two-slot/one-active-device occupancy to clear. On a selected attempt, an actual budget, prior-output, spawn or definitive admission refusal produces terminal NotClaimed when the core proves it remained unclaimed. It does not silently retry. The owner may explicitly prepare anew only while the original work remains eligible. Slot saturation is scheduling, not a repeated start call. Expiry while queued is NotClaimed(Expired), without claiming or cancelling another attempt's winning work.

## Three composition changes required by current source

**Adopt the same mailbox.** `Runtime::apply(Attach)` currently binds MemoryCarrier before HELLO, and `Runtime::complete` installs its access guard. Fresh-only `register_fixed_carrier` correctly refuses that mailbox. Add a private single-use `BoundMailbox` capability minted by Runtime for its exact `(service scope, Handle::same, mailbox Arc identity)` after completion. Store that exact carrier identity during service binding. The authority consumes this capability to register the existing mailbox after checking the current session, matching access provenance and empty Registry/mailbox output under access-then-mailbox lock order. Never accept only a numeric carrier ID or device key. Preserve fresh-only registration and tests. Setup refuses locally if ACCEPT/prior output remains unread, with no rebinding or new target charge. Successful adoption retains the existing separate 4,096-byte registration lease and close capability.

**Serialize real cancellation, stop and refusal evidence.** Each prepared row contains a prepaid cancellation cell. The core receives only a private exact scope/row-generation reference, never a caller-supplied assertion. External cancel sets that cell under `Shared.queues` and wakes the actor; it acquires no epoch or worker gate. The final Begin barrier takes session access, then the real worker gate, then briefly the shared queue/status lock. It checks the exact row, cancellation and Running stop state and records MayHaveRun before opening the worker gate. Cancellation or Requested stop that wins this shared synchronization prevents Begin with zero invocations. No path takes epoch/worker-gate locks while holding the queue/status lock. The same private eligibility cell is rechecked at MaySend and peer-acceptance commit; stop/cancel between sealing and acceptance causes exact loss cleanup. Only these short state commits run under the final queue/status lock, never encryption, verification, fsync or join. Ordinary authority calls enter with that lock released. Add a private structured start result distinguishing pre-claim refusal, claimed-but-Begin-refused cleanup, and dirty Worker failure. Bare `Fault` and WorkToken status cannot certify NotClaimed. A claimed failed-Begin request stays terminal and never becomes retryable.

**Skip fenced output during generic flush.** Current `Runtime::flush` calls `take_output_owned` on every Active carrier and treats any error as failed delivery. Add an exact private egress classification so a live tracked fence is skipped, not added to its failed-delivery list. Unrelated Request/keepalive commands must not return DeliveryUnknown merely because the tracked fence exists. Actual transfer failure still closes the exact carrier. The private fixed pump uses only `emit_fixed`/`consume_fixed`; it never routes tracked bytes through generic receive or flush. Existing ordinary command flush semantics remain unchanged, including their finite carrier/frame bounds and synchronous latency.

## Actor round, wake and fairness

In fixed fixture mode, each round performs the following bounded work. Queue entries are moved out under synchronization; authority work happens after unlocking.

1. Check stop, apply all bounded cancellation latches, run due maintenance, reconcile exact closures, and poll the two retained workers. Cancellation/deadlines precede delivery and new Begin.
2. Visit each occupied core slot once: emit at most one joined Ready frame, consume at most one enabled synthetic peer packet, process its actual return, copy terminal evidence, and call `discard_fixed` only when cleanup can complete. Preserve a slot on pending join or receipt.
3. Preserve the existing eight-slot/18 KiB reserved owner control lane and out-of-band stop; execute at most one existing control and one existing ordinary command, with the existing maintenance/stop check before each. Neither lane drains completely ahead of the other. Process at most one preparation.
4. Visit one of 16 rotating device scheduling buckets and consider its one queued submission. Rotate even on a blocked, expired or invalid candidate. New device buckets enter behind the cursor; reclaimed slots retain a checked generation. A fixed array scan resolves carrier identity.
5. If runnable work or a new wake generation exists, repeat; otherwise park for at most the configured 1..100 ms tick. A queue blocked only by active slots does not create a busy spin.

With an eligible queued device and a free core slot, at most one 16-visit round reaches it despite continuous control/ordinary traffic or another device's submissions. Two active or unread-output claims may still delay everyone until real cleanup/deadline; there is no preemption or wall-clock guarantee. Each device has only one queued submission, so carrier selection within that device is the owner's explicit queued choice; there is no hidden multi-carrier backlog to bypass. Prepared but unsubmitted attempts are not scheduler candidates. General source ingress fairness, revocation admission against duplicate DrainWork and saturated Disconnect admission remain separate gates.

Use a private `WakeToken` containing a weak run-owned wake hub, a checked atomic generation and the actor's non-owning `std::thread::Thread` handle. Commands, cancellation, fixed-worker completion and packet return increment the generation and `unpark` the actor. Token saturation aborts rather than wrapping. Fixed-mode waiting uses `park_timeout`; its retained unpark token closes the check-to-sleep race without making Packet Drop lock Shared/Registry/epoch state. The actor samples generation before scanning and rechecks before parking. The existing Condvar path stays available to the ordinary service and status waiters. This avoids relying on a Condvar notification from Packet Drop without the waiter's mutex. A completion wake before actual thread exit leaves the slot charged; the next bounded tick checks `is_finished` again and performs the real join.

Use the one `Shared.clock` clone for prepare, core start, poll, tick, emit and consume. External status/cancel APIs accept no timestamp. This prevents new time-base ambiguity but does not claim to repair the existing poll-cadence-dependent result selection. Core cleanup, expired inspection and end-claim promotion reassert coalesced WorkAvailable; refused drains never clear it. Events, including `events: 1`, are not the completion or status channel.

## Accounting, retention and stop

Runtime startup failures retain the existing `PersistentStartFailure`/`StoppedService` writer ownership, including dirty failures after Running. No new public synthetic-authority constructor is added.

Before allocating fixed-mode backing or acquiring the writer, reserve `checked(size_of::<FixedShared>() + size_of::<RuntimeFixed>() + 4096)` from the profile's existing global pool. These types contain the inline status, ring, reply, scheduling and peer arrays; do not count embedded arrays twice. Pin the resulting number and all contained sizes in tests. Static fixed-mode limits require at most 16 carriers, at least one frame/1,024 bytes, and the tracked mailbox maximum of 32 MiB; rejection preserves corrected-start retry.

Charge each occupied status row 2,048 bytes from its original connection/device/global budget before per-attempt/token bookkeeping allocation. Charge each adopted synthetic peer an additional 4,096 bytes from that same session budget for the fixed-size Channel, bounded request encoding and crypto scratch; refuse if measured fixed-type/capacity bounds exceed this allowance. Registration stays separately 4,096 bytes. A tracked start still atomically prepays exactly 2,172,416 bytes; no status, response, wake or return storage is acquired after Begin. Default 64 MiB connection/device and 256 MiB global limits stay unchanged. Shared backing, per-status retention, peer fixture storage and execution/output are separate charges, never a second independent device pool.

Terminal status may remain after the core slot is disposed. `ack_terminal` hides only a terminal record; it never clears unknown execution or unjoined cleanup. Its row/lease and ID generation cannot be reused until an internal disposal proof confirms actual core cleanup and pending queue/reply ownership is gone. A visible terminal label or caller acknowledgment is never that proof. It accepts no caller cleanup proof. Status lookup on a hidden/reused ID cannot report NotStarted or cancel its successor. Shared clients/receipts use weak references and small scope/generation values. Stop removes all fixed backing and original-session leases even if handles are forgotten.

Out-of-band Requested/Abort disables preparation, submission and Begin before queue capacity is considered. Cancel queued attempts, revoke access, physically drain mailboxes, cancel retained workers, and reject queued commands under existing NotExecuted/UnknownOutcome rules. No queue/status/epoch/mailbox lock spans a waiting join. The retained Runtime survives actor unwind; owner-side recovery still joins the actor, then drains any remaining core ownership before terminal persistence. Healthy Clean/Retired requires real worker joins, packet return receipts, grant release and empty run-owned tables. Poison, worker panic, clock error or ambiguous persistence remains sticky Abort with the original typed StoppedService/writer ownership. No reset, force close, detached cleanup or automatic replay is added.

## Required implementation tests and agreement boundary

1. **Owner flow and types:** real synthetic service Attach/HELLO/Request/DrainWork through prepare/submit to verified 200/502/504; no direct authority calls in the integration assertion. Compile-fail/visibility checks forbid carrier-client escalation, arbitrary executors, cloned attempts, packet access and worker/writer escape. Fresh-only registration remains independent; adoption rejects foreign, stale, already-adopted and nonempty mailboxes without charge or rebinding.
2. **Admission and bounds:** deterministic Full returns the same attempt/ID/cancellation cell and succeeds once after retry; duplicate attempts invoke once; abandoned prepare replies and unsubmitted Drop reclaim exact rows; lost accepted receipts do not replay. Pin 512 global/32 device/16 prepare/16 submit/16 carrier bounds, needed-minus-one/exact original-budget accounting and device churn. Early terminal acknowledgment cannot free an unfinished core slot or affect reuse.
3. **Fair turns and wakes:** a continuously busy carrier plus continuous controls/ordinary traffic cannot starve a second eligible carrier within 16 visits; blocked devices do not spin or monopolize the cursor; 16-carrier work readiness remains coalesced and drainable. Force wake-before-exit, wake-between-scan-and-park, packet-return wake and wake-counter exhaustion. Completion/delivery and manual-clock expiry progress without a subsequent client command; one-slot approval coexistence remains valid.
4. **Cancellation and delivery:** race cancel on both sides of Begin with saturated command/event lanes; no output after winning cancellation. Hold unread output, fill every unreserved byte, exercise error/timeout output and exact 345-second equality with keepalives. Fenced generic flush is benign; bad peer, seal/transfer failure, delayed return, remove/re-pair and same-ID replacement close only the old target, retain execution evidence and do not replay. Lost-output observations are Unknown, not Completed.
5. **Joined stop and regression:** saturate all queues with two active/queued-output slots, forget all handles, and request healthy stop/Abort/Drop. Prove physical packet drainage, real child and actor joins, released status/wake budgets and busy writer ownership until terminal transfer. Inject retained/status/gate poison, worker panic and typed terminal write failure. Preserve all 298 tests/eight doctests/seven Node checks, scoped Claim tests, strict Clippy and formatting; report synthetic evidence only.

The parent agreed to this private fixture boundary, exact admission/status bounds, actor-owned peer setup, checked wake/unpark mechanism and original-session charges. Implement two separately reviewed commits: consuming owner preparation/status/admission plus mailbox adoption, then fair pump/wakes/delivery/shutdown composition and integration tests. Neither agreement nor implementation authorizes real HTTP, production/existing-profile access, network/relay/provider use, host lifecycle, phone/mobile/native builds, credentials, batching, persisted request replay or broader ingress/revocation policy changes.
