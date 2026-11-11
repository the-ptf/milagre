# Private owner delivery, wakes and fair turns

Status: root reviewed and agreed increment 2B.1 only. Its charged private peer setup may be implemented; 2B.2 delivery and 2B.3 wake/fairness code wait for separate review. Baseline is stage 2A at `18229be6`: 335 Rust tests, 9 doctests, strict Clippy/fmt and seven Node checks; independent source review found no P1/P2. This makes the remaining [owner-pump proposal](FIXED-OWNER-PUMP-PROPOSAL.md) concrete while preserving [lifecycle ownership](FIXED-OWNER-LIFECYCLE.md) and the [tracked-output contract](TRACKED-OUTPUT-CONTRACT.md).

Use three separately reviewable increments: charged private peer setup; real owner delivery/completion on existing ticks; then completion wakes and fair turns. All remain inside the fresh synthetic fixture. There is no public executor, network/HTTP adapter, existing profile, real phone, provider, mobile or GUI work. Remote remains independent of both frontend candidates.

## 2B.1: move a charged synthetic peer into the actor

Keep existing Attach/HELLO/ACCEPT and mailbox adoption. The fixture consumes ACCEPT with its actual `PendingHello::finish`, then moves the resulting non-Clone Channel into private peer setup. Channel possession is not delivery proof; only later authenticated verification can mint acceptance. No setup accepts an acknowledgment, key string as authority, verification callback or executor.

Proposed private types and operations:

```rust
struct PeerTransfer { handle: Handle, peer: Channel } // Private fixture construction only.
enum PeerRejection { Full(PeerTransfer), Unavailable(PeerRefusal, PeerTransfer) }
struct PeerReceipt;                                // One bounded reply, no Channel export.
struct PeerBinding { handle: Handle, target: TargetId, peer: Channel, lease: Reservation }

fn adopt_peer(transfer: PeerTransfer) -> Result<PeerReceipt, PeerRejection>;
fn request_fixture(target: TargetId, request_id: i64) -> Result<FixtureReceipt, Refusal>;
```

Full before admission returns the same transfer with unchanged channel counters. A reply timeout means unknown setup outcome; it never recreates a Channel or repeats setup. Once accepted, the actor either installs that transfer or destroys it and closes only its exact old carrier. Dropping a reply cannot silently discard an accepted transfer before this resolution. Retain an abandoned operation's cell until actor resolution; late replies cannot target a reused cell.

Adoption requires a current Phone target in this service, consumed ACCEPT, empty ordinary/tracked output, no active claim/fence and no peer already pending or installed. Exact Handle/TargetId/service identity is rechecked by the actor. No rebinding occurs on failure. Closed/replaced generations do not affect successors.

Charge **4,096 bytes from the original session's connection/device/global budget before accepting the moved Channel**. To permit this without exposing Runtime or authority, mailbox adoption publishes a private exact target/budget descriptor into a bounded shared roster. These handles refer to the existing budget; they create no new pool. Peer admission copies the descriptor under the queue lock, unlocks to reserve, then reacquires the queue lock and rechecks stop, exact descriptor generation, peer ledger and operation/reply capacity before moving the transfer. A failed recheck refunds and returns the unqueued transfer. The actor revalidates authorization before installation.

Use at most 16 target descriptors and a separate 16-cell peer ledger. Pending/executing transfers and installed peers share that peer limit. A closed generation with a queued transfer retains its peer cell until that transfer is destroyed; replacing a target cannot temporarily create a seventeenth peer. New setup/refusal replies share the existing 16 operation/reply cells. Runtime holds the installed Channel and moved lease; shared cells retain only identity/state. Include all arrays and inline pending Channels in recalculated prepaid backing, without counting embedded arrays twice.

The peer allowance covers measured Channel/metadata and bounded encoding/crypto scratch for one empty GET `/rpc`; pin capacities and refuse before setup if 4,096 does not fit. `request_fixture` accepts only exact target and i64 ID, encodes one fixed request using the actor-owned peer, then invokes the normal Registry receive path and publishes actual promotions. Registry job/body accounting remains unchanged. An admitted request failure after sealing closes that exact carrier; it cannot replay a consumed sequence number. Generic outbound Send/Finish/MemoryHttp on a peer-owned target refuses locally before invocation/sealing, including between claims. Other carriers retain normal behavior. Generic flush keeps its exact tracked-fence exclusion.

This increment does not deliver output: both peer-owned and existing peerless fixture targets still stop at Ready. Test setup/refund, original-pool needed-minus-one/exact boundaries, 16 combined peer slots across replacement, same-transfer Full retry, abandoned/timeout replies, fixed request counters, malformed/mismatched peer failure and ordinary-carrier isolation.

## 2B.2: deliver once, commit completion only from real returned credit

Enable automatic delivery only for an exact actor-owned peer binding. Existing peerless stage 2A fixtures retain Ready, preserving their independent coverage. Each round considers at most the two retained entries, emits at most once per entry and attempts verification at most once. The actor owns the Channel throughout. Existing direct authority APIs retain their behavior and tests.

Extend the concrete private `OwnerBinding` with three short source-owned commits, all checking exact owner row/core ID, cancellation, RUNNING stop state and the same service clock:

1. **MaySend:** under the existing session-access guard, acquire the queue lock only for recording row/core MaySend immediately before seal. Release it before encryption or mailbox transfer. Cancellation that wins this transaction prevents sealing; cancellation afterward requires exact post-MaySend closure.
2. **Peer acceptance:** under exact session access, take the packet from the mailbox and release the mailbox lock. Decrypt with the actor's real Channel, compare the selected prevalidated fixed bytes and destroy plaintext. Recheck time, then take the queue lock only for the final eligibility check and private acceptance-marker commit. Cancellation/stop during verification prevents acceptance. Never hold the queue lock during crypto.
3. **Completed:** after Packet Drop has destroyed ciphertext, released its lease and published the real capacity-one receipt, reconcile under current session access and a final short queue check. Require actual join, accepted returned credit, current claim/target and strictly unexpired completion deadline. Cancellation between acceptance and receipt processing must win here; an earlier acceptance marker cannot revive a cancelled row.

The Completed commit changes only inline row/core evidence under the queue lock. End-claim promotion and grant disposal follow after releasing it. Acknowledgment in that interval may hide the terminal row but cannot release its retained ownership; a later cancel cannot undo a completion that already won the final transaction.

Lock order is session access/epoch, then mailbox only for packet transfer, or queue/status only for bounded state commits. Release the mailbox before taking queue/status for acceptance. There is no queue-to-epoch/mailbox path and no unfinished join under those locks. These are concrete internal commits, not caller-supplied eligibility or verification callbacks.

The current `consume_fixed` returns `Fault::State` when test-delayed receipt processing has not reached Completed. Add an owner-only typed progress result, such as `Queued`, `AwaitingReturn`, `Completed` or `Closed`, rather than treating that pending result as failure. Track the one consume attempt in prepaid core metadata; an accepted packet awaiting its return processing is never consumed or emitted again. Diagnostics do not construct receipt evidence. Direct `consume_fixed` may map this internal progress back to its existing signature.

Add delivery observation None/MaySend/Returned/Unknown and terminal Completed/DeliveryUnknown. Preserve NotStarted/MayHaveRun and cancellation/timeout causes separately: post-MaySend cancellation or timeout remains that terminal cause with delivery Unknown; a transfer/verifier failure can use DeliveryUnknown. The current owner mapping of core Completed to Failed must be replaced. Core Completed is copied only after its actual evidence path. Disposal then moves the existing exact non-Clone proof; acknowledgment never supplies cleanup evidence.

Post-MaySend seal/transfer/verification failure, cancellation, expiry, unwind or unread shutdown closes and physically drains the exact carrier and mailbox. Pending or late returns cannot affect successors or other carriers. Completion/end-claim still publishes real readiness. Clean requires actual joins, receipt/grant cleanup and whole-run drainage before peer cells, rows or backing are dropped. Panic/poison or terminal-write failure preserves Abort and the original typed writer owner.

Keep the existing tick/Condvar loop for this increment. Name bounded repeated polls honestly: current maintenance, emit and consume each poll up to two core entries. Do not claim one poll per round unless a separate refactor enforces it. Tests must reach 200/502/504 Completed through owner commands only, prove consecutive peer counters, fill every unreserved byte after Begin, and exercise unread packets, delayed returns, bad peers, seal/transfer faults, both sides of all three commits, deadline equality, replacement/removal and joined shutdown. No synthetic flag may substitute for acceptance or Packet Drop credit.

## 2B.3: checked wakes and sixteen rotating queued-device buckets

Prepay a single run-owned `WakeHub` with checked `AtomicU64` generation, overflow latch and an actor `Thread` handle installed before startup acknowledgment. Count its allocation and Arc bookkeeping within measured backing slack before writer acquisition. Fixed State/Runtime own its strong references; Shared's wake access and worker/packet tokens hold only Weak references. Tokens own no writer, Runtime, lease or JoinHandle. Drain children/packets before dropping the hub with fixed backing. Late old weak tokens cannot wake a successor run.

Publish the state or real receipt first, increment generation with checked CAS, then unpark. Overflow sets its sticky latch and atomically records the existing failure/ABORT state through a startup-installed Weak Shared reference, then directly unparks. This path acquires no queue lock and never recursively invokes wake. Admission and all four final commits (Begin, MaySend, acceptance, Completed) also reject the overflow latch in their final eligibility check; exhaustion cannot wait until the next round to disable progress. Cover command/control/approval admission, private operations, cancellation/unsubmitted Drop, stop/failure, child completion and packet return. Keep `changed` for event/status waiters and preserve the ordinary public service's Condvar path.

A stack-only guard in the fixed worker closure wakes on normal return and panic; the wake may precede actual thread exit. Packet Drop releases bytes/lease, publishes returned credit, then wakes without Shared/Registry/epoch locks. Both tokens and all additional receipt/worker bookkeeping are prepared before Begin inside the existing 2,172,416-byte claim allowances. No new persistent allocation, budget reservation or larger claim formula is introduced after Begin; existing bounded crypto/verification temporaries retain their 65,536-byte scratch allowance. If measured bookkeeping does not fit, stop for review rather than raise an allowance.

Sample wake generation before each bounded round. After the round, inspect runnable work under the queue mutex, unlock, check stop/overflow and generation again, then park only if idle and unchanged. Unpark after the final check retains a token across the scan-to-park gap. Generation is a progress hint, never join/receipt evidence. Keep the bounded 1..100 ms tick because a worker can wake before `JoinHandle::is_finished()` becomes true.

Replace submission-ring selection with **16 fixed queued-device buckets**, each containing canonical device, exact submission ID/outcome and checked reuse generation. Free a bucket when selected or terminalized. The two retained core identities remain separate; keeping buckets for old draining active claims as well could require 18 identities during churn. Full still returns the exact original attempt. One queued attempt per device and one active claim per device remain mandatory.

The fixed-mode round checks stop/cancellation/deadlines, progresses the two delivery entries, handles at most one reserved control command and one ordinary command, one preparation and one bucket visit. Take the second command only after the first completes so an unwind cannot abandon an extracted envelope. Recheck stop/maintenance before each command, delivery commit and Begin. The eight-slot control reserve and out-of-band stop remain available.

A cursor visits exactly one physical bucket per round and advances even for empty, cancelled, stale or occupied-device entries. Never reset it or relocate existing queued entries. Allocate vacancies starting at the just-visited slot, behind the next cursor. A continuously eligible bucket is visited within 16 visits despite another carrier's repeated submissions and continuous traffic in both command lanes. Starting additionally requires a free core slot at that visit. This is no preemption or wall-clock guarantee. A bounded all-bucket scan may decide whether to park; two occupied slots, same-device blockage, unread output or delayed return alone must allow parking.

Use deterministic barriers for generation change before the final check and after that check/before park; worker wake before exit; verified/unverified packet returns; delayed return; panic; stale weak tokens; coalesced wakes and counter exhaustion. Under full ordinary/control/event lanes, assert progress without a follow-up command. Record bucket visits while one carrier continuously resubmits and a second remains eligible, including target churn: the second gets a visit within 16, ordinary receipts progress, blocked-only rounds park, and stale bucket generations cannot consume successors.

## Review and regression boundary

Each increment retains all current Rust/doctest, scoped Claim, direct packet/verifier, stage 1 and stage 2A suites; run strict all-target Clippy/fmt, examples and seven Node checks. Pin updated tested layouts and actual original-pool refunds. Source review precedes enabling the next increment. Expected source seams are private supervisor fixed/service/wake modules, retained-core owner/output, Registry claim barriers and tracked Packet return; no unrelated frontend or production source is needed.

The first implementation checkpoint after agreement is 2B.1 only. This document proposes the original-budget descriptor bridge, combined peer ledger, pending-return distinction and final Completed commit explicitly so root can review them before any code changes.
