# Private owner delivery and returned credit

Checkpoint 3 increment 2B.2 implements the delivery portion of [the reviewed plan](FIXED-OWNER-DELIVERY-PLAN.md) over accepted peer setup `fd467e61`. Only the fresh private fixed fixture automatically delivers to an exact actor-owned synthetic Channel. Public start is unchanged; peerless fixture work still retains joined Ready. Increment 2B.3 completion wakes and rotating fairness remain separate. There is no frontend, production/existing-profile, network, HTTP, provider, real phone or mobile authority.

## Three commits on the shared evidence paths

The retained core's concrete OwnerBinding carries exact service/status-slot/generation/core identity. MaySend, authenticated acceptance and Completed run inside `emit_fixed`, Packet verification and output reconciliation respectively. Poll, cancel and maintenance therefore cannot bypass owner checks by reaching reconciliation without the actor delivery loop.

Each transaction holds exact Registry session access, then takes the owner queue mutex for inline evidence only. It checks sticky failure, RUNNING stop, exact retained ownership, cancellation and a fresh service clock under that mutex. The Registry captures the exact minimum claim/job, idle and active reader-fragment deadline under its guard; the commit also limits it by completion expiry. Equality refuses. Begin now uses this same deadline capture, further limited by its HTTP deadline. No queue-to-session/mailbox acquisition or waiting join is introduced.

MaySend changes row/core evidence immediately before sealing and releases the queue before crypto/transfer. Packet verification takes the packet under the mailbox mutex, releases it, decrypts with the actor's real Channel, compares the selected fixed bytes and destroys plaintext. Only its subsequent concrete acceptance transaction can mint the private marker. A caller flag, status observation or receipt acknowledgment supplies no evidence.

Packet Drop destroys ciphertext, releases the moved 1,536-byte lease and publishes capacity-one returned credit. Reconciliation requires accepted returned credit, actual join and current exact authorization, then commits row/core Completed under the same session/queue transaction. End-claim promotion and grant destruction follow after both guards are released. Completed resists later cancellation. An acknowledgment in the interval before disposal hides the row but retains exact ownership until the non-Clone disposal proof arrives.

A prepaid consume-attempt bit prevents a second mailbox take/decrypt while credit processing is delayed. The owner receives typed AwaitingReturn/Completed progress; the legacy direct API may report State for pending without cancelling it. Emit/consume resample time after polling, since another entry's reconciliation can advance Registry time. Effective idle/fragment/job expiry outside a transaction preserves TimedOut, while removal/replacement remains cancellation. Post-MaySend cancellation/timeout keeps that cause with delivery Unknown; seal/transfer/verifier failure reports DeliveryUnknown. Dirty unwind keeps Abort and the original writer.

## Bounded actor work and drainage

The existing tick loop considers at most two retained core entries and only exact installed peer targets. Each entry emits once and consumes once. Current maintenance, emit and consume can each poll up to two entries; this is bounded repeated polling, not a one-poll-per-round claim. No new wake mechanism, submission scheduler, fairness promise or automatic retry is added.

Post-MaySend failure, expiry, cancellation, removal, replacement and unread shutdown close and physically drain only the exact old carrier/mailbox. Late or delayed credit cannot complete a cancelled entry or affect a successor. Completed enters the same actual joined disposal path as other terminal entries. Whole-run drainage retains rows, peer cells and backing until core/packet cleanup is proven. Actual end-claim promotions still publish readiness.

## Accounting

Per-status 2,048, peer/registration 4,096 each, tracked claim 2,172,416 and its scratch/packet/receipt allowances are unchanged. The two-entry scans use inline arrays. Measured core/packet/receipt sizes still fit their pinned allowances.

On this 64-bit target the test layout, including fault gates, is State 235,760 + RuntimeFixed 5,760 + 4,096 slack = **245,616 prepaid backing bytes**. Row/ReplyCell/Pending/Submission are 440/56/248/40 bytes. The separately compiled non-test layout is State 202,984 and Row 376, giving **212,840 bytes** with the same RuntimeFixed/slack. Backing uses actual `size_of` before allocation/writer admission, including embedded arrays once. Its increase is actual inline storage, not a larger resource allowance.

## Evidence and limits

Twelve owner integration tests cover:

- Actual 200/502/504 peer acceptance, consecutive channel counters, one join, Completed immunity, terminal acknowledgment and original-pool refunds; delivery also succeeds after all otherwise unreserved global bytes are filled after Begin.
- Delayed return across repeated maintenance without replay, the real 1,536-byte Packet Drop refund before reconciliation, cancellation after acceptance, and acknowledgment after Completed before exact disposal.
- Cancellation before all three commits and after MaySend/acceptance/Completed; stop before and after each commit; idle and fragment equality during all three final queue transactions and between maintenance ticks.
- Seal failure, unknown transfer, a different real synthetic verification Channel, unread shutdown, exact replacement/removal with surviving carriers, and unwind before/after authenticated verification with joined Abort and the original writer.

Six Registry tests cover effective minima/equality, legacy barrier results, clock rollback, old claims, exact Registry/generation/authorization, timeout cause without successor damage, and refusal before sealing. Fragment tests parse a real partial FrameReader through private test injection: the Phone request path does not populate that reader. The peer-setup Ready-only test explicitly holds delivery with a test-only gate; independent peerless stage 2A tests retain their original behavior.

A root regression run caught premature owner expiry publication: the clock could advance after Registry tick but before owner row maintenance. Owner NotClaimed(Expired) now requires the Registry token's actual TimedOut status; explicit cancellation remains first, and other closed/non-InFlight work remains Stale. A deterministic two-gate regression keeps the row Queued/InFlight across that gap, then verifies actual timeout, one promoted-work notification and the successor's original scheduling deadline. Restoring the old clock branch makes that regression fail. The original failure and mutation evidence remain at `/tmp/milagre-remote-delivery-root-test.log` and `/tmp/milagre-remote-expiry-mutant.log`.

Final root validation after the expiry fix: 365 Rust tests and nine doctests pass with locked offline dependencies, including the existing scoped Claim, direct tracked-packet and peerless lifecycle suites. Strict all-target Clippy, formatting, rebuilt examples and all seven Node checks pass. Root logs are `/tmp/milagre-remote-delivery-root-final-{test,clippy,examples}.log` and the seven `/tmp/milagre-remote-delivery-root-final-{node-fixtures,policy-node,restart-node,registry-node,http-node,phone-node,host-proof-node}.log` files. Agent full output is `/tmp/milagre-remote-delivery-expiry-agent.log`. Independent source review of delivery and the expiry fix found no P1/P2. Increment 2B.3 is not implemented.

Three bounded P3 follow-ups remain. Owner queue-crossing tests cover idle/fragment equality, not claim/completion equality; Registry tests cover the minima. Owner post-queue clock rollback lacks a dedicated race test. Duplicate preparation can retain an observer row past its original 20-second deadline if another attempt has claimed the same WorkToken and extended its Registry lifetime. Submission/start still revalidate, so this grants no replay authority; a dedicated duplicate-attempt lifetime test remains for the next scheduler checkpoint.
