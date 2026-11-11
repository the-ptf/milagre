# Private owner lifecycle: proposed stage 2 split

Status: stage 2A agreed by root after reading this plan; implementation may proceed within its private fixture boundary. Stage 2B still requires separate agreement. Stage 1 is accepted at `bd46a369`: 315 Rust tests, 9 doctests, seven Node checks, strict Clippy/fmt and independent P2 closure. This refines the remaining implementation of [FIXED-OWNER-PUMP-PROPOSAL.md](FIXED-OWNER-PUMP-PROPOSAL.md); [stage 1 ownership](FIXED-OWNER-ADMISSION.md) and [tracked-output evidence](TRACKED-FIXED-OUTPUT.md) remain binding. Exact fence exclusion from generic flush and retained abort/unwind drainage must precede owner core starts.

**Stage 2A connects consuming owner submissions to tracked core start, cancellation, polling and disposal. Ready stays retained without output or Completed. Stage 2B adds actor-owned synthetic peers, delivery, checked completion wakes and the complete fairness guarantee.** Each gets independent source review and validation before the next starts. Both remain private fixture operations on newly created synthetic profiles, with no HTTP, network, host/provider adapter, existing profile or phone authority. Neither depends on Tauri or GPUI; the frontend choice stays separate.

## Stage 2A: ownership and private types

Keep the existing owner API, 512 status rows/32 per device, 16 preparation/reply cells, 16 queued submissions, 16 exact targets and two retained core slots. Accepted submissions never reconstruct an attempt. Queue capacity Full still returns the exact original unqueued permit before core admission.

Replace the row's unconditional `Unclaimed` proof with private lifecycle ownership. Proposed type names describe responsibilities; fields and proof constructors remain private:

```rust
struct OwnerBinding { id: FixedId, shared: Weak<Shared> }
enum RowOwnership {
    Unclaimed(Unclaimed),
    Starting,                  // Construction or claimed start resolution is still owned.
    Retained(CoreId),
    Disposed(Disposed),
    DirtyPending,              // Only whole-authority drainage can discharge this state.
}
struct Disposed;               // Non-Clone, exact owner/core identity, private core constructor.
enum Disposal { Pending, Done(Disposed) }
struct RunDrained;             // Whole-run cleanup evidence; does not grant Clean persistence.
enum Egress { Ordinary, TrackedFence, Closed }
```

The actor moves a queued row to Starting before releasing the queue lock. The core stores its concrete `OwnerBinding` with the installed entry and associates the exact core ID with that row before Begin. This association survives a panic between installation and the start call's return. The authority table remains the sole worker/permit owner; the row holds an ID, not a JoinHandle. Missing rows or missing core IDs are faults, never disposal evidence.

Extend fixed-size observation with Claimed/Running/Ready and terminal Cancelled/TimedOut/Failed, sticky execution NotStarted/MayHaveRun, optional status, delivery None, and cleanup-pending diagnostics. The existing 20,000 ms scheduling deadline applies only before claim. Once Starting/Retained, the owner must stop applying the stage 1 unclaimed-expiry scan; the core's checked claim-time +340,000/+345,000 ms deadlines and exact carrier authorization govern it. Use the same `Shared.clock` for all operations.

Each selected submission enters core start once. A real resource/prior-output/spawn refusal is terminal NotClaimed only through existing `StartFailure::NotClaimed` evidence. `BeginRefused` stays a claimed Cancelled/TimedOut result after actual join and claim removal. `Dirty` preserves the last execution evidence, latches Abort and retains cleanup ownership. It never produces an Unclaimed/Disposed proof or an implicit retry. Two-slot or same-device occupancy delays selection without repeatedly calling start. Any other actual refusal terminates that attempt; a later retry requires explicit preparation of still-eligible Registry work.

## Begin, cancellation and stop synchronization

The normal start entry point gains an optional concrete private owner binding; output-free and directly tracked core tests retain their existing paths. No caller supplies a boolean eligibility assertion, executor closure or cleanup callback.

1. The actor extracts work and changes its row to Starting under `Shared.queues`, then releases that lock before reservation, authority calls, encoding, spawn or join. The entire existing 2,172,416-byte tracked claim remains prepaid before Begin.
2. Final Begin takes session access/epoch, then the worker gate, then briefly `Shared.queues`. It revalidates the exact scope/row generation, retained core association, cancellation and RUNNING stop state. Within that same critical section it records MayHaveRun and opens the real gate. Only a source-owned, bounded state commit may run there.
3. External cancel and Requested/Abort take the same queue mutex and set their real state without acquiring epoch or worker locks. If they win that synchronization, Begin refuses with zero invocations. If Begin wins, cancellation cannot restore NotStarted even when the body has not yet run.
4. The actor collects active cancellation requests under the queue mutex, unlocks, and calls the core. Pre-claim cancellation uses the unclaimed terminal path; retained cancellation keeps its row, execution evidence and slot until cleanup completes. No authority operation, encryption, fsync or waiting join runs while a queue/status lock is held.

Cancellation and stop are checked before selection and again at Begin. Scope/generation reuse cannot satisfy an old binding. Queue/status, gate or epoch poison is sticky Abort; lock recovery is cleanup-only. No queue/status, epoch, mailbox or worker-gate guard is held across an unfinished-worker join. The actor may retain its existing exclusive Runtime Slot guard; writer ownership remains retained throughout cleanup.

## Polling, disposal and retained Ready

Add a private disposal operation returning `Disposal`, while preserving the existing direct core API signatures. Pending retains the exact slot. Done is minted inside the core only after consuming its actual JoinHandle, resolving pre-seal output grants, ending the exact claim, removing the entry and releasing its metadata. Capture terminal/execution evidence before removal and bind the proof to that exact owner row and core ID. Never derive it from `Observation.joined`, a missing ID, token status or acknowledgment.

Terminal status can be visible while cleanup is pending. `ack_terminal` may hide that status, but cannot release its row/lease or reuse its generation until the internal disposal proof and absence of queued/reply ownership permit it. DirtyPending is discharged only by whole-run drainage. A definitive failed-Begin path that removes its entry before returning must also return its internally minted disposal evidence to the owning row.

Normal polling visits at most two retained entries and joins only finished handles. A finished result behind a test exit barrier remains Running and charged. Actual joined 200/502/504 becomes Ready with delivery None. Stage 2A neither calls `emit_fixed`/`consume_fixed` nor invents Completed. Ready retains its core slot and output grant until explicit cancellation, exact carrier closure, completion expiry or service shutdown. Ready discard preserves MayHaveRun and terminalizes the exact work without replay. The following delivery stage will replace that retained stopping point.

## Two prerequisites before the first owner start

**Exact generic-flush classification.** Starting tracked work installs a fence immediately. Add an authority-owned `Egress` inspection using the current exact handle and active fence. `Runtime::flush` skips only `TrackedFence`; it never treats that local busy state as failed transport or drains its packet. Closed and genuine ordinary export/delivery errors preserve current exact closure behavior. A reused numeric carrier ID must not inherit a predecessor's skip. Install this before enabling queue execution; deferring it would let an unrelated command close a valid tracked carrier.

**Drain before dropping row backing.** Healthy `quiesce_for_join` already drains the retained core. Current Abort/unwind paths can call `clear_owned`/`Shared::drain` before owner-side `abort_without_commit` joins fixed workers. That is safe for stage 1, which starts none, and must change before stage 2A. Add an idempotent private dirty-drain operation and an internal `RunDrained` result confirming actual worker consumption, packet/grant drainage and empty retained core/target tables. A discovered panic/poison keeps Abort and the existing typed writer owner even after resources are drained.

Every `Runtime::finish`, worker unwind recovery and owner-side `take_runtime` path must retain rows, mappings, cancellation state and backing until that drainage occurs. Join the actor before owner-side recovery; release queue/status/epoch/mailbox and retained-slot acquisition guards before waiting from that side. Only after core drainage may RuntimeFixed and Shared fixed state be dropped. Clean/Retired additionally requires healthy quiescence and the actual actor join. Abort/Drop never writes Clean, and terminal persistence failure retains the original `StoppedService` writer. No detached cleanup, force success or reset is added.

## Readiness propagation and bounded actor progress

Stage 1's `ReadyInspection` bridge covers preparation expiry. Core inspection still discards its promotion result, `Registry::end_claim` discards `promote` tokens, and `tick` returns Registry tick promotions without those produced by its later core poll. Close all three paths before queue execution.

Use a private coalesced readiness latch owned by Registry/authority, set only after an actual nonempty promotion in the core inspection/end-claim paths. Preserve the existing preparation bridge. This adds one bounded bit, not a new token queue or notification allocation after Begin. The actor takes and publishes the latch after every relevant authority operation, including refusal, poll, cancellation, disposal and reconciliation, before returning a local failure. Normal tick and request readiness continue through the existing channel. For a successful first-page DrainWork, publish/take pending readiness before clearing the existing shared bit; a refused drain clears neither. A notification remains advisory: authoritative DrainWork supplies current tokens, and closures may have invalidated work meanwhile.

The stage 2A actor round performs due tick/reconciliation, active cancellations, polling/disposal of at most two entries, the existing ordinary/control command turn, at most one preparation, and at most one new start. Selection scans at most the 16 queued submissions and skips occupied devices without invoking core start. Use a fixed two-slot occupancy snapshot only to avoid redundant admission calls; final authority checks still decide admission. Rotate skipped entries and preserve accepted entries' ownership until selected or terminalized. Release the queue lock before all authority work, then publish its real readiness effects.

Use the existing 1..100 ms bounded tick and queue Condvar for this increment. Submission wakes the actor; runnable candidates must enter the wait predicate. Queues blocked only by occupied slots must park instead of spinning. Worker completion progresses on bounded ticks without another client command. Stage 2A makes no checked completion-wake or 16-bucket cross-carrier fairness claim. The existing control capacity and out-of-band stop remain reserved. Synchronous command IO and refusal cleanup retain their current latency limits.

## Accounting and regression gate

Recalculate and pin `size_of<State> + size_of<RuntimeFixed> + 4096` before backing allocation/writer acquisition; 161,376 bytes is the stage 1 baseline, not a promised unchanged layout. All owner binding/status/disposal storage must fit the prepaid backing, 2,048-byte status allowance and existing core metadata allowances. Keep original connection/device/global accounting, two workers and one active device claim. No new independent pool or per-attempt channel is allowed.

Required stage 2A regression groups:

1. **Owner lifecycle:** real Attach/HELLO/Request/DrainWork/prepare/submit reaches actual joined Ready for fixed 200/502/504 without direct authority calls. Assert zero response packets and no Completed. Hold both slots and one worker's exit, prove slot/status credit retention and unrelated carrier/control progress; cancel/dispose and then admit fresh eligible work. Duplicate attempts have one authoritative winner.
2. **Begin races and refusal:** saturate command/event lanes and force cancel/Requested/Abort immediately before and after the real Begin transaction. Assert zero calls before, sticky MayHaveRun afterward, exact claim terminalization and no replay. Distinguish pre-claim budget/spawn refusal from claimed failed Begin and dirty panic/poison; preserve another retained worker.
3. **Readiness:** retain stage 1's t=1/t=19,000/t=20,001 regression. Add post-spawn failed admission, claimed failed Begin, joined cancellation and timeout/end-claim promotion of B with inflight=1. Even with events=1, require coalesced WorkAvailable and authoritative drain of B; preserve assembly-based scheduling deadlines and no implicit execution. Failed drains cannot lose the latch.
4. **Disposal and fences:** early acknowledgment hides no cleanup ownership; stale row/core IDs cannot free successors. Ready plus ordinary Request/keepalive/flush keeps the exact fence and carrier alive while another carrier exports. Removal, disconnect, replacement and completion equality cancel only the exact retained work and never report delivery.
5. **Shutdown and budgets:** healthy close, Abort, Drop and actor unwind with two retained workers, an exit barrier, full queues and forgotten handles keep rows/backing/writer until actual joins. Include poison and a panic found only during drain, plus terminal write failure. Assert original-pool needed-minus-one/exact admission and final lease refund. Preserve all 315 tests/9 doctests/seven Node checks, strict all-target Clippy/fmt and example builds.

Expected source scope: `persistent_supervisor/{fixed,service,mod}.rs`, private fixed core/output and Registry claim/composition seams, plus focused tests and evidence documentation. Ordinary public starts and APIs remain unchanged.

## Stage 2B remains a separate agreement

After 2A review, add the already-proposed actor-owned synthetic peer transfer and 4,096-byte original-session peer charge, fixed `/rpc` request fixture, emit/consume/real packet-return completion, and owner eligibility checks at MaySend and peer acceptance. A moved Channel is private fixture state, never caller-supplied proof or an unbounded verification callback.

Then add the checked generation/unpark wake mechanism and the complete actor round: one control and one ordinary command, one preparation and one rotating device bucket per turn. Prove a continuously busy carrier and continuous control/ordinary traffic cannot starve a second eligible carrier within 16 visits when a core slot is free; blocked slots cannot spin. Require wake-before-exit and scan-to-park races, unread/delayed receipt expiry, exact post-MaySend loss closure and joined shutdown with actual packets. Only real join, synthetic peer acceptance and Packet Drop credit receipt can create Completed. No stage agreement authorizes production networking or couples remote ownership to either frontend.
