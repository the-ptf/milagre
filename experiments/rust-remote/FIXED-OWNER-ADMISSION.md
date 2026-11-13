# Private fixed owner admission

This records the accepted stage 1 boundary at `bd46a369`. [Stage 2A lifecycle](FIXED-OWNER-LIFECYCLE.md) now extends it with private owner start/cancel/poll/disposal; delivery and full fairness remain separate.

Checkpoint 3 stage 1 implements the consuming preparation, status and submission boundary from [the agreed owner-pump proposal](FIXED-OWNER-PUMP-PROPOSAL.md). An explicitly opted-in, crate-private fixture mode extends the existing `PersistentSupervisor`. Ordinary public `start` allocates no fixed state and exposes no fixed owner capability. All existing public commands, carrier clients and profile authority remain unchanged.

The real synthetic service Attach/HELLO/Request/DrainWork flow supplies authoritative `WorkToken`s. The actor can adopt its existing mailbox and process one private preparation operation per loop. Submission records an outcome and queues a consuming permit. **This stage never starts a queued worker or delivers its response.** Fair scheduling, synthetic peer adoption, final Begin cancellation synchronization, fenced generic-flush integration, completion wakes and automatic tracked delivery remain stage 2 work. Its review is still required.

## Ownership and refusal behavior

`FixedOwnerClient` holds a weak service reference. `FixedAttempt` is non-Clone and contains one exact service-scope/status-slot/generation ID. Prepared attempts have an original-session reservation and authoritative device, target, work identity and deadline. Dropping an unsubmitted attempt requests cancellation and hides that exact row; it never cancels the underlying Registry work. `FixedReceipt` contains only an ID, and dropping it does not cancel or retry accepted work.

`prepare` reserves one fixed command and reply cell under the same queue mutex as stop admission. The actor validates the current handle, eligible unclaimed work and assembly-plus-20,000 ms scheduling deadline, then reserves 2,048 bytes from the original connection/device/global pool before installing the row. Readiness inspection does not require empty egress or an available tracked fence; execution still uses the separate original preflight. Preparing is observational and does not claim or invoke work.

`WorkToken` remains Clone observational identity. A caller retaining its clone can explicitly retry preparation after Full; that refusal does not change Registry eligibility or enqueue an implicit retry. A later attempt revalidates the token. The reply handle is non-Clone, with `wait` returning either its one result, `WaitFault::Refused`, or `WaitFault::Timeout`. Timeout leaves that same handle live for another wait. Dropping an unread successful reply cancels its exact prepared row. A dropped pending reply is rejected by exact reply generation before preparation, or cancels the row if preparation already finished.

`submit` checks stop, service scope, exact row generation, cancellation, current carrier/work state and deadline before capacity. Full returns the original still-armed `FixedAttempt`. A successful explicit retry consumes it once and records Queued. Queued outcomes have no execution side effect in this stage. Status and cancellation accept exact IDs only. Cross-service IDs and reused generations cannot observe or modify a successor.

The stage 1 status set is Prepared, Queued, or Terminal(NotClaimed(Cancelled/Expired/Stale)). Every row holds a private `Unclaimed` disposal proof because no owner path can start core execution yet. Terminal acknowledgment hides a row; reuse also requires that proof and absence of submission/reply ownership. Acknowledgment supplies no proof. Stage 2 must replace this unclaimed-only state with actual retained core cleanup ownership before it can represent unknown execution or an unjoined worker. These admission tests do not claim to prove that future composition.

## Exact existing-mailbox adoption

The service records an immutable scope and exact `Handle::same` binding when attaching its mailbox. Only Runtime can mint the private `BoundMailbox` from its own current carrier table. The authority consumes it, checks current authorization and empty Registry output, then checks exact service scope, handle and access provenance under the session-access then mailbox lock order. The bound mailbox must have no ordinary or tracked packet and no existing fixed target.

An unread ACCEPT/prior output returns Full without rebinding or retaining a charge. A foreign, pending, replaced, closed or already-adopted mailbox returns Stale. Successful adoption preserves the existing mailbox and access guard and adds the original 4,096-byte registration reservation. Fresh-only `register_fixed_carrier` retains its original rules. The Runtime keeps at most 16 exact target mappings and removes closed generations during maintenance. A synthetic peer Channel is not stored in the actor yet.

## Bounded storage and stop

| Storage         | Bound and charge                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Status rows     | 512 total, 32 per canonical device, including retained terminals; 2,048 original-session bytes each |
| Preparation     | 16 operation entries and 16 reply cells; pending, executing and unread replies share the cell cap   |
| Submission      | 16 entries, at most one queued per device                                                           |
| Adopted targets | 16 exact generations; separate 4,096-byte registration each                                         |
| Fixture backing | On the tested 64-bit target: State 155,232 bytes + RuntimeFixed 2,048 + 4,096 slack = 161,376 bytes |

Backing is reserved from the existing profile global pool before fixed storage allocation or writer acquisition. The tested inline Row/ReplyCell/Pending/Submission sizes are 296/48/136/40 bytes. There is no device-churn map or per-request response channel. Connection/device defaults stay 64 MiB and global stays 256 MiB. Registration, status and backing charges remain separate from the unchanged atomic 2,172,416-byte tracked execution/output claim.

Existing periodic maintenance terminalizes unclaimed cancellation, expiry and stale work, removes dead submissions, and reclaims hidden rows only after disposal checks. Queued deadline expiry requires no later client command. If readiness inspection expires a request and promotes queued work, its result carries those actual promoted tokens separately from the refusal. The actor reasserts coalesced WorkAvailable before returning Expired, without executing or replaying either request. Stop admission is out-of-band and wins before fixed queue capacity checks. Joined service shutdown clears targets, operations, replies, submissions and status leases, even with forgotten handles; RuntimeFixed is dropped before its backing reservation. The existing eight-slot reserved owner control lane remains independent. Stage 1 adds no scheduling-fairness guarantee.

Invalid fixture limits fail before Running and retain corrected-start retry. Post-Running reservation/spawn/startup failure preserves the existing typed `PersistentStartFailure`/`StoppedService` writer ownership and dirty-run quarantine. Ordinary startup has no new public synthetic authority constructor.

## Core refusal evidence and tests

The private core `start_fixed_tracked_evidenced` reports the actual transition as `StartFailure::NotClaimed(Fault)`, `BeginRefused { fault, terminal }`, or `Dirty(Fault)`. A post-spawn pre-claim refusal joins its gated thread before NotClaimed. A claimed failed Begin ends the claim and joins before Cancelled/TimedOut terminal evidence. Poison, failed join, worker panic or clock failure remains Dirty with existing writer ownership. Legacy fixed start signatures preserve their original Fault mapping. Owner submission does not call this entry point until stage 2. Before enabling it, that stage must also forward actual readiness promotions from core start refusal and end-claim paths; the present owner notification bridge covers preparation inspection only.

Added evidence comprises 12 service owner tests, one layout test, four core provenance tests and one private-module compile-fail doctest:

1. Ordinary-mode absence; exact backing charge; existing-mailbox adoption after consuming ACCEPT; unread-output refusal/refund; stale and foreign scope rejection; replacement target generations.
2. Same-permit Full and successful explicit retry; accepted-receipt destruction; 16 unread/pending reply cells; abandoned and timed-out preparation handles; exact generation reuse after disposal.
3. Actual 32-device and 512-global status saturation, including device churn and retained terminals; needed-minus-one and exact original connection/shared-device/global budget admission; pinned layout sizes.
4. Tick-driven queued expiry; an expired preparation at 20,001 ms reasserts readiness for work queued at 19,000 ms behind a drained request assembled at 1 ms, with inflight=1 and its original assembly deadline preserved; 16 queued submissions with 16 pending preparations and saturated ordinary/control lanes; out-of-band stop, physical mailbox close, actual actor join, forgotten-handle drainage and retained writer until terminal ownership transfer; typed startup failures.
5. Pre-claim budget/spawn refusal followed by explicit eligible retry; definitive failed-Begin cancellation/timeout versus an identical legacy Stale fault; zero invocations and real joins on refused Begin; panic/poison/clock dirty ownership.

Validation after the readiness review fix: 315 Rust tests, 9 doctests, strict all-target Clippy, formatting, example builds and all seven unchanged Node reciprocal/source checks pass. The added readiness regression failed before the fix and passed afterward; independent source rereview found no remaining P1/P2. All fixtures use newly created marked synthetic profiles and synthetic keys. This stage authorizes no real HTTP, network, production/existing-profile access, host adapter, provider, real phone, mobile/native build, installed app or push.
