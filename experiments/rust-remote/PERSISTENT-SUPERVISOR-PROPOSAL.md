# Proposal: joined persistent synthetic supervisor

Status: round-1 contract revision accepting all five parent refinements. The agreed scope and exact refinements below are concluded before supervisor implementation; this checkpoint changes documentation only. Baseline is local 77e15f51 + 4584bd1e, integrated by the parent as 49de7c16 + 09ce423c. No runtime/API change is made here. The 159 tests, seven doctests and seven Node checks reported for that baseline do not validate this proposed supervisor.

## Scope and current composition

Add a separate persistent supervisor over a fresh SyntheticProfile and injected MemoryCarrier/Clock. Keep the existing disposable Supervisor API and behavior. Start one joined Rust thread; add no subprocess launcher, async runtime, real HTTP executor, socket, production profile locator, imported keys, mobile change or shared daemon writer. Cross-process store evidence remains the existing private test harness. This checkpoint supervises thread replacement while the in-process synthetic broker capability survives.

| Existing source                                                      | Current behavior                                                                                                                                                                                              | Required composition                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supervisor.rs`: Supervisor::spawn_synthetic / Actor                 | Constructs TemporaryAuthority and a separate Registry. Captures both in the spawned closure. Drop retires them; shutdown joins a `JoinHandle<()>` and ignores its panic result.                               | A persistent worker must use the Registry already owned by PersistentAuthority. Retain the authority/writer outside the unwind scope, inspect join results, and return an owning outcome. Never construct a second registry.      |
| `supervisor.rs`: accept_ticket / complete / reconcile                | Keeps Ticket in a bounded worker map. Extends a pending desktop carrier to the ticket deadline, emits a consuming Approval, and gives the mailbox an opaque Session access guard before flushing.             | PersistentAuthority currently hides the needed pending-deadline, access-binding and owned-output hooks. Add narrow crate-private composed operations; do not expose its registry, Session or writer.                              |
| `supervisor.rs`: maintain / flush / OwnerClient                      | Periodic ticks run without caller polling. Readiness is edge-triggered, closures advisory, approval delivery prioritized. Queue counts and bytes are bounded; mailbox transfer moves an existing frame lease. | Reuse these mechanisms against persistent operations and the store's existing global pool. Preserve guard-before-mailbox lock ordering and stop checks before delivery.                                                           |
| `policy/persistent.rs`: resume / close_for_restart / retire_identity | Resume writes Running before Ready. Explicit close revokes runtime, commits terminal state, releases writer locks and acknowledges the retained broker. Prior fatal retirement prevents Clean.                | Terminal persistence belongs after worker join. Add an internal quiesced state that revokes runtime without confusing an intentional healthy handoff with fatal retirement. No bool supplied by callers grants clean eligibility. |
| `synthetic_store/mod.rs`: acquire_writer / acknowledge               | Non-Clone profile capability pins root/marker/lock identities; non-Clone writer retains both locks. Successful acknowledge restores ledger eligibility and releases locks immediately.                        | Supervisor owns the profile while active; clients cannot reacquire it. Do not call acknowledge in a live worker. Keep the existing acknowledgment contract by calling terminal authority close only after joining.                |

The temporary constructor's capture-by-value is unsuitable for persistent startup: `thread::Builder::spawn` failure would drop the captured authority and writer. Likewise, copying Actor::Drop's unconditional retire into a healthy persistent stop would make close_for_restart reject the handoff. Neither path is to be reused unchanged.

## Proposed public ownership contract

All new ownership fields remain private and non-Clone. Names below are proposed signatures, not implemented APIs. Limits reuses `supervisor::Limits`; its authority and registry fields map to PersistentLimits. StoreLimits remains attached to the fresh profile.

```rust
pub struct PersistentSupervisor; // profile + retained state slot + one JoinHandle
pub struct PersistentOwnerClient; // cloneable trusted owner command surface
pub struct PersistentCarrierClient; // bound Hello/Request/Disconnect only
pub struct PersistentStartFailure;
pub struct PersistentCloseFailure;
pub struct PersistentReleaseFailure;
pub struct StoppedService;       // joined/no worker + profile + optional owning guard
pub struct CleanServiceStop;     // joined + CleanStop + profile
pub struct RetiredServiceStop;   // joined + RetiredStop + profile

impl PersistentSupervisor {
    pub fn start(
        profile: SyntheticProfile, limits: supervisor::Limits, clock: Clock,
    ) -> Result<Self, PersistentStartFailure>;
    pub fn owner(&self) -> PersistentOwnerClient;
    pub fn close_for_restart(self) -> Result<CleanServiceStop, PersistentCloseFailure>;
    pub fn retire_identity(self) -> Result<RetiredServiceStop, PersistentCloseFailure>;
    pub fn abort(self) -> StoppedService; // stop, join, revoke; NO terminal write
}
impl CleanServiceStop {
    pub fn into_parts(self) -> (CleanStop, SyntheticProfile);
}
impl RetiredServiceStop {
    pub fn into_parts(self) -> (RetiredStop, SyntheticProfile);
}
impl PersistentStartFailure {
    pub fn into_parts(self) -> (StartFault, StoppedService);
}
impl PersistentCloseFailure {
    pub fn into_parts(self) -> (CloseFault, StoppedService);
}
impl PersistentReleaseFailure {
    pub fn into_parts(self) -> (StoreFault, StoppedService);
}
impl StoppedService {
    pub fn diagnostics(&self) -> ServiceDiagnostics;
    pub fn release(self) -> Result<SyntheticProfile, PersistentReleaseFailure>;
}
```

`start` takes only an existing **freshly created capability**, never a directory spelling, arbitrary descriptor, keys or serialized state. It owns that capability until joined termination. Cloned clients contain queue/stop/status handles only and cannot extract the profile, authority or writer. `StoppedService::release` explicitly releases any held Quarantine, RetiredProfile or StoppedAuthority and returns the same profile for diagnostic acquisition or safe `destroy(&mut self)`. Release neither repairs an uncertain ledger nor resets data. A distinct pre-write rejection described below is the only path that can return the prior unstarted eligibility; it is never used after a Running write or write attempt. Dropping StoppedService releases its guard/capability without a write or implicit destruction; callers wanting cleanup explicitly release and destroy through the returned capability. Destroy errors retain the profile using the existing borrowed API. An error before writer acquisition (invalid limits, Busy) has no new writer guard; the original profile is still returned. If Busy is caused by a lease the caller created earlier, ownership of that preexisting lease remains with its original caller.

StartFault/CloseFault are closed redacted enums: invalid configuration, store fault, quarantined, retired, spawn error kind, worker panic, invalid worker exit, stopped without clean eligibility. No IO path, panic payload, snapshot, token or arbitrary source error escapes. StoppedService diagnostics distinguish a pre-start idle profile from a joined dirty guard and report only validated public state. Returned CloseFailure is decomposed into its fault and StoppedAuthority and **moved into StoppedService**, never converted to a string or dropped as an error-mapping side effect.

Use a separate PersistentCommand enum with the common Attach, Hello, Request, Send, Disconnect, OpenPairing, RemoveDevice, DrainWork, Finish and DispatchSynthetic operations, plus explicit EnableDesktop and bounded admission diagnostics. Approve uses the dedicated owning-rejection method below, not the generic submit-by-value command path. PersistentOwnerClient has no Replace(SyntheticIdentity) command and no command that reports durable retirement through `Reply::Done`. Durable retirement is the consuming supervisor method above. An in-memory stop request, if exposed on the owner, means stop/abort only; it cannot mint CleanStop. WorkToken retains its existing bound-handle shape. PersistentApproval is a separate non-Clone permit with the same profile/identity/boot/runtime binding plus a worker-owned decision-state guard and absolute deadline; existing disposable Approval behavior remains unchanged. Sources remain trusted adapter assignments; Source::Relay does not identify a phone's IP.

## Persistence prerequisites and pre-write ownership

These are three separate safety commits before supervisor wiring, based on `rust-remote-synthetic-persistence-review.md`. They use fresh synthetic capabilities only.

1. **InvalidLimits can be corrected.** Add pure `PersistentLimits::validate()` and supervisor static validation before writer acquisition wherever possible. A limit depending on stored active-device count still requires a read under both locks. `OpenedAuthority::Rejected(RejectedAuthority)` owns a typed **unstarted** lease after that read-only rejection. This is distinct from Quarantined. No write attempt, Running generation change, terminal write, malformed snapshot, missing prior acknowledgment or ambiguous IO can create this proof. Proof checks include PID, both original locks, pinned identities, exact prior validated stamp, current attempt, unchanged last stamp, an unpoisoned broker ledger and a sticky never-written state. Poisoned validation state is never recovered into restart eligibility.
2. **Interrupted transaction cleanup.** Keep quarantine read-only and release its writer explicitly before profile destruction. `SyntheticProfile::destroy(&mut self)` takes both locks and can adopt the exact reserved `transaction` entry for **deletion only** when an interrupted authorized worker did not update the surviving broker's inode ledger. Open relative to the pinned marked root with NOFOLLOW/CLOEXEC, retain that descriptor, require regular file/expected UID/0600/single link, compare descriptor and current directory-entry identity, and recheck before unlink. If the broker already recorded an expected inode, substitution is refused rather than falling back to adoption. Validate the complete bounded directory inventory before deleting anything. Unknown names, symlinks, hard links, wrong owner/mode/type or replaced root/marker/lock remain refused without deletion. Adoption never parses, promotes, replays or acknowledges transaction contents. A partial or empty owned transaction is valid cleanup input. Cleanup errors retain the capability and both original lock descriptions for explicit retry/release; Drop does not sweep. This relies on exclusive ownership of the reserved name in the fresh private namespace, not protection against a malicious same-UID process able to manufacture a matching replacement. There is no existing-directory cleanup API, general temp scan or automatic restoration to Ready.
3. **Retired snapshot contains no retained credentials.** Before serializing terminal Retired, overwrite the candidate's box_secret and pairing_token with zero bytes. Validate that a retired snapshot has these zeroed fields. The retired status remains terminal; zero bytes are never used to admit a connection. Successful RetiredStop proves the current named snapshot was replaced and synchronized without the original credentials. A typed write/sync fault keeps its exact stopped writer locks and never claims erasure or retirement success. Nothing is zeroized in memory, and there is no claim of secure deletion from old inodes, filesystem snapshots, backups or freed blocks.

The proposed pre-write API is:

```rust
impl PersistentLimits { pub fn validate(&self) -> Result<(), StoreFault>; }
// Added to existing enum: OpenedAuthority::Rejected(RejectedAuthority)
pub struct RejectedAuthority; // non-Clone validated unstarted ownership proof
pub struct RejectedReleaseFailure;
impl RejectedAuthority {
    pub fn diagnostics(&self) -> StoreDiagnostics;
    pub fn retry(self, limits: PersistentLimits, rng: &mut impl CryptoRngCore)
        -> OpenedAuthority;
    pub fn release(self) -> Result<Released, RejectedReleaseFailure>;
}
impl RejectedReleaseFailure {
    pub fn into_parts(self) -> (StoreFault, Quarantine);
}
```

`retry` moves the same lease back through validation, so corrected limits do not require dropping a guard or reacquiring locks. `release` rechecks the unstarted proof and restores **only the previous acknowledgment** while releasing the lease. It writes no snapshot and mints no CleanStop. On failed recheck it returns the still-owning Quarantine; its Drop cannot restore eligibility. Dropping RejectedAuthority performs the same read-only proof checks and returns the previous eligibility only if they succeed; a validation failure on Drop fails closed. Thus an ordinary read-only InvalidLimits error, even if the rejection is dropped, does not poison a still-valid clean profile. Generic WriterLease Drop and all post-write guards keep their current uncertain/dirty semantics. Any commit attempt permanently consumes the unstarted proof before touching storage, including a failed Running commit. CryptoRngCore denotes the existing RngCore + CryptoRng bounds, not a dependency change.

For the supervisor, static validation failure returns the untouched profile in StoppedService's pre-start state. A snapshot-dependent rejection remains typed inside that returned owner; `StoppedService::release` must now return `Result<SyntheticProfile, PersistentReleaseFailure>` because returning an unstarted proof can fail its descriptor recheck. `PersistentReleaseFailure::into_parts()` returns `(StoreFault, StoppedService)` with the same capability and exact quarantine locks. Successful release then allows a corrected `start(profile, ...)`. The ordinary dirty/retired/quarantine release path releases its guard and returns its profile without restoring eligibility. No error drops ownership as an implicit conversion.

Tests for these commits must cover invalid static/registry/active-count limits followed by corrected retry/reacquire; rejected Drop; descriptor substitution on rejected release; any Running write attempt refusing restoration; a subprocess killed with an empty/partially written transaction; exact-name deletion-only adoption and recorded-inode substitution refusal; unknown entries and hardlinks left untouched; failure during partial destruction retaining locks; and serialized retired bytes excluding both former secrets. Capture only public metadata or equality assertions in logs. Other source-review P3s (cold diagnostics/short marker reads, narrow create cleanup failure, broker loss, quota reset and permanent profile token) remain documented separate follow-ups unless fixed within one of those bounded commits.

## Worker retention, join and failure ordering

1. **Start:** validate all static authority, registry, queue, byte and cadence configuration before acquisition, and reserve known startup resources before Running wherever possible. Snapshot-dependent checks such as active-device count use the typed pre-write rejection above. Acquire the writer and resume authority into a broker-owned retained slot. Create queue/control/event reservations from that authority's existing global pool, including the store working charge. The slot retains the authority plus carrier/pending maps and startup/exit state. The spawned closure captures only references/Arc handles to this slot and Shared, not the sole runtime value. A startup RAII owner holds the profile, slot and any created JoinHandle immediately, including while waiting for startup; its Drop aborts and joins. On spawn failure or a reservation failure after Running, no admission is exposed: convert the retained Ready authority into a stopped guard without committing Clean. Neither is a pre-write rejection. Quarantined/Retired startup returns its original guard. A successfully spawned worker must send a startup outcome through a capacity-one handoff before start advertises Running; startup panic or refusal is joined before returning failure.
2. **Run:** one worker exclusively borrows the authority and its private Registry; it never consumes the authority or performs terminal close. Place `catch_unwind` around the mutable run-loop borrow while the owning slot and its guard remain outside the caught closure. On unwind, reject new admission, revoke runtime and mark the retained state permanently aborted. A poisoned retained-slot mutex is also fatal even if the run-loop catch reported success: recover its owned value with PoisonError::into_inner solely for revocation, joining and guard extraction. Do not unwrap that mutex, clear its poison to resume, or accept a previously cached healthy flag. Apply the same fail-closed rule to poisoned persistent queue/handshake state: recover only to stop, reject/drain commands and preserve ownership. Admission cannot continue through poison recovery. Startup RAII and normal Drop inspect join failure without unwrap, and retain the JoinHandle until it is joined. Do not continue processing a potentially half-applied command. A panic payload is discarded without logging. The broker can recover the retained slot after join even if the worker's startup/exit notification failed. Do not hold a slot/queue mutex on the broker thread while joining the worker.
3. **Quiesce:** a private authority state transition, derived from its healthy internal state, changes Running to QuiescedEligible, revokes all issued access, cancels every ticket and registry job, and closes owned carriers. Prior IO fault, fatal retirement, worker panic, clock failure or authoritative event overflow instead yields Aborted. Close every MemoryCarrier mailbox and release packets before worker exit; reject all queued commands, clear events/readiness and release ingress/control/event leases. The worker makes no terminal snapshot write. Its final status means quiesced/finished, not joined or clean.
4. **Join, then close:** explicit close_for_restart/retire_identity first disables admission through an out-of-band stop latch, wakes the thread and joins it. Inspect both the worker outcome and JoinHandle result. Only a joined healthy quiescence permits taking the retained authority and invoking the matching terminal authority method on the joining owner. This requires a private phase-aware refactor of PersistentAuthority's stop eligibility; a quiesced state is not an externally assertable persistence/approval bool. Successful terminal IO then acknowledges the broker and releases the writer. Only now return CleanServiceStop or RetiredServiceStop. The profile cannot be handed to a successor before this point.
5. **Abort, Drop or failure:** default Drop requests abort, joins and revokes, then releases guards without writing Clean. It never invokes close_for_restart or silently retries terminal IO. Explicit abort returns a joined StoppedService. Any worker panic/error makes explicit clean close return a joined dirty guard, even if disk happens to contain a visible Clean state. Returned terminal IO errors retain both writer locks in the existing StoppedAuthority. No method returns a detached JoinHandle, and a join wait cannot be converted into a timeout that abandons its worker.

The implementation must add an internal `abort_without_commit` extraction path: revoke/clear runtime and move the WriterLease into StoppedAuthority without terminal IO. It must also separate intentional quiescence from terminal identity retirement and fatal policy retirement. All regular authority operations refuse once quiesced. Standalone PersistentAuthority::close_for_restart keeps its existing public contract and can use the same phase logic.

A caught **worker** panic is recoverable as a joined stopped guard because the worker never owns a consuming close. Expected terminal write failures are returned as CloseFailure and preserve ownership. Process abort, allocator abort, machine death, or an unexpected unwind inside the consuming terminal-close implementation are explicitly accepted as outside this recoverable-result guarantee; ordinary unwinding still must not detach a live worker or write Clean from Drop. Fault hooks for terminal IO must return typed faults, not promise arbitrary panic recovery from a moved WriterLease. There is no retained-result recovery claim, force-close path or clean retry for that case. All returned terminal typed faults must nevertheless retain the exact original root and writer-lock descriptions, not reacquire substitute locks.

Filesystem writes/fsync remain synchronous. The worker cannot preempt a currently executing durable mutation, and periodic ticks cannot run while that IO blocks. Stop disables further admission immediately, waits for that call, then quiesces; it does not claim a hard shutdown duration. Test stop-after-commit-before-command-reply explicitly: command outcome may be unknown, but neither the operation nor the request is replayed. A healthy later Clean close does not turn an earlier unknown command result into proof of delivery.

## Approval, transport and budget composition

Add crate-private composed hooks on PersistentAuthority, never raw mutable Registry access:

- `prepare_pending_approval(handle, ticket, now)` checks the current pending carrier and ticket, derives the ticket's absolute deadline, extends/protects that carrier through Registry::wait_approval, and returns bounded public device metadata. It accepts no caller deadline. An error cancels the ticket and closes the carrier. The exact predicate remains `now < deadline`; no renewal is added by approval or queue delay.
- `complete_for_carrier(handle, ticket, decision, fresh_clock)` consumes an internal decision enum (`PhoneOrKnown` / `ApprovedDesktop`) derived by the trusted actor's pending map. It consumes the authority ticket, rechecks authoritative records/kind/window and the fresh post-IO time, establishes internally and returns only an opaque access guard for mailbox gating. No Session/reply/channel is exposed. Installing the guard precedes transferring any reply; all failure paths cancel any remaining ticket and close the pending carrier.
- `take_output_owned` forwards the existing ciphertext plus Reservation under the session access check. Add guarded send/close-reason/read-only pending-state and shared-global access only as needed by the actor. `tick` already composes policy expiration and registry deadlines. No second GlobalBudget and no copy of prepaid ciphertext is introduced.

A worker pending entry owns exactly one Ticket and checked approval serial. A PersistentApproval event contains its non-Clone handle/serial permit, deadline and opaque decision-state guard; it contains no Ticket or channel. The dedicated owner method preserves ownership on an unqueued Full rejection:

```rust
impl PersistentOwnerClient {
    pub fn approve(&self, permit: PersistentApproval)
        -> Result<Receipt, ApprovalRejection>;
}
pub enum ApprovalRejection {
    Full(PersistentApproval), // never queued; caller may retry this same permit
    Unavailable(ApprovalRefusal), // no reusable permit
}
pub enum ApprovalRefusal { Stopped, Expired, Replaced, Revoked }
```

Under queue synchronization, check stop, monotonic deadline, bound carrier and decision state before checking capacity. A live Full refusal returns the exact unqueued permit, without copying or reconstructing it. Full means it was eligible at the check; the returned capability can expire or be revoked concurrently, so every retry rechecks. Successful enqueue transfers it once and changes the shared decision state from Live to Queued. Execution consumes Queued once after the actor revalidates its exact pending entry. Stop/expired/replaced/revoked refusals return no retryable permit. Their decision guard is cancelled, and maintenance removes only that matching ticket/carrier, never a newer one. Dropping a live returned permit also cancels its exact decision guard; the worker reconciles on its next tick, subject to the documented synchronous-IO delay. This bounded metadata change uses the existing control-lane reservation and adds no retry queue or new unbounded notification lane. Existing generic Receipt timeout/drop semantics remain unchanged: a successfully enqueued approval is never reconstructed or replayed.

When Approve executes, remove the matching pending entry before attempting completion. An old/replaced permit must not remove or close a newer entry for the same carrier id or device. On failed approval, expired ticket, cancellation, disconnect, new pairing window, removal or stop, reconcile both authority ticket and protected carrier immediately. Already delivered stale Approval events may remain in a caller's hands but cannot deliver ACCEPT. The default desktop ticket deadline is the remaining 600,000 ms pairing window; normal pending carriers keep their configured hello deadline. A protected approval cannot outlive its ticket. Restart restores no approvals/windows/desktop-enable state.

Continue waking at the configured 1..100 ms cadence, using injected ManualClock for semantic time and the real condition-variable wait for scheduling. Run maintenance after wake and before each continuation, as now. A manual-clock test must prove approval and idle expiry without a client command or caller tick. Successful initial DrainWork alone acknowledges readiness; pages, refused drains and stale cursors do not silently discard work. Request deadline/504 margin and MemoryHttp preflight reservation behavior stay unchanged.

MemoryCarrier.receive must keep its epoch guard even after an encrypted packet has moved out of the registry into its mailbox. Removal revokes before persistence, so a concurrent receive cannot observe a stale buffered reply during that write. Flush must transfer the same frame lease, enforce mailbox bounds and attribute DeliveryUnknown only to the command's own target. Unknown delivery closes that carrier, never reinvokes MemoryHttp, and never resends a frame. Caller-owned bytes already returned by receive cannot be recalled; later access is refused.

## Cancellation, events and acceptance gates

The stop/abort request uses an out-of-band latch, independent of the eight-slot control lane and its 18 KiB prepaid reserve. Distinguish a requested healthy quiescence from Abort; Abort dominates and cannot be downgraded. Keep a separate sticky fatal worker outcome so a previously recorded Requested stop cannot hide a later panic, clock error or storage fault. The consuming owner selects Clean versus Retired only after join; a shared stop intent never proves clean eligibility. Admission must check it under the same queue synchronization that determines enqueue success. All commands still queued at quiescence receive NotExecuted; a command popped but interrupted/panicked during execution is UnknownOutcome, never falsely NotExecuted. Receipt timeout/drop does not cancel or replay an accepted mutation. Event-queue saturation cannot block terminal ownership transfer: worker completion and the final guard are held in the retained slot, not sent through the ordinary event queue.

Keep existing authoritative Approval events, advisory Closed dropping/coalescing, and edge-triggered WorkAvailable. Preserve queue, byte, source and per-carrier limits. Do not enlarge queues to hide the existing P3s. The profile's working reservation remains charged after service stop while the returned profile capability lives; all supervisor/connection/carrier reservations must be released. Cloned stale clients may retain only bounded empty Shared/status storage and cannot start a successor.

Before a runtime checkpoint, add tests for:

1. **Lifecycle ownership:** fresh start, clean joined replacement, terminal retirement, default Drop/abort quarantine, invalid configuration with corrected retry, injected startup reservation failure after Running, spawn refusal, startup panic, worker panic while a command is owned, poison discovered while recovering the retained slot, and stop with all queues full. Busy must hold while the worker/quiesced slot owns the writer. A fresh attempt is possible only after joined terminal acknowledgment or explicit guard release. Existing lock replacement/inherited-FD subprocess tests remain required.
2. **Failure guards:** typed faults at every terminal IO stage and removal ambiguity; returned StartFailure/CloseFailure retain profile and any acquired writer. CloseFailure::into_parts moves the exact stopped guard. No hidden clean retry, no consuming error drops a guard, and diagnostics contain no token, path, payload or panic text. Prove all mailbox/jobs/approval leases are released before Clean acknowledgment with an ordered test trace.
3. **Approval deadlines:** approval beyond normal hello timeout but before its derived window deadline succeeds; equality at the deadline fails. Expiration runs without polling. Repeat replaced approval, closed-carrier completion, stale approval across restart, failed approval cleanup, old window, removal/re-pair, Full-returned-permit retry, Drop cancellation of an unqueued permit, non-retryable expired/replaced/Stop rejection and newer-ticket survival tests through the persistent supervisor.
4. **Cancellation and delivery:** queued/inflight requests cancel on removal/disconnect/abort/restart; late Finish cannot invoke or deliver; an accepted command with a lost receipt is not replayed. Saturated advisory events cannot prevent a joined outcome or lose authoritative work. Test buffered mailbox receive during a blocked removal write and unknown delivery followed by close/restart. Verify shared-pool accounting includes store, queues, mailbox and connection reservations exactly once.
5. **Regression and scope:** preserve all existing 159 tests/seven doctests/seven Node checks and strict Clippy. Add persistent-supervisor tests without starting real listeners or loading profiles. Record separate results for thread supervision, existing subprocess store harness and Node fixtures; none is actual phone interoperability or production recovery.

Implement only after agreement, in bounded checkpoints: internal phase/approval/transport composition with focused tests, then the retained joined-worker owner and synthetic lifecycle tests. The three persistence P3 fixes below land in separate tested commits first. Sonnet found no P1/P2 in the reviewed persistence chain; any new P2 would still take priority.

P3 gates remain separate: reserved revocation versus duplicate DrainWork saturation; Disconnect admission under carrier saturation; command/dispatch fairness; atomic real HTTP Claim and asynchronous cancellation. This proposal does not claim those fixed. Persistent supervision, production import/network/mobile/host wiring and broker-loss recovery remain unimplemented.
