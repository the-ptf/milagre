# Private fixed owner lifecycle

Checkpoint 3 stage 2A implements [the agreed lifecycle plan](FIXED-OWNER-LIFECYCLE-PLAN.md) on top of [stage 1 admission](FIXED-OWNER-ADMISSION.md). The private fresh-fixture `PersistentSupervisor` now consumes queued attempts, starts the tracked core, polls actual worker joins, applies cancellation and disposes retained entries. Real Attach/HELLO/Request/DrainWork commands supply the work. Ordinary public start exposes no fixed execution capability.

**Joined fixed 200/502/504 results stop at retained Ready.** The actor does not emit or consume a tracked packet, adopt a peer Channel, or produce Completed. Stage 2B still needs separate agreement for delivery, checked completion wakes and the complete cross-carrier fairness guarantee. Remote has no dependency on either frontend and adds no HTTP, network, provider, host adapter, real phone or production/existing-profile authority.

## Begin and exact disposal

The actor marks a selected row Starting under the shared queue mutex, then releases it before core reservation, encoding, spawn or authority work. An installed core entry holds a concrete private `OwnerBinding`; it associates its exact core ID with the exact service-scope/status-slot/generation row before Begin. The real final Begin barrier takes session access, worker gate, then the queue mutex. Under that last lock it checks cancellation, stop, identity and the current service clock, records MayHaveRun and opens the gate. External cancel and Requested/Abort use the same queue mutex. Winning cancellation prevents invocation; losing cancellation cannot restore NotStarted.

Rows distinguish Unclaimed, Starting, Retained(core ID), Disposed(proof) and DirtyPending ownership. A private non-Clone `Disposed` is minted inside the core after actual join, claim termination, grant cleanup and entry removal. It binds the captured observation to the exact owner/core IDs. A claimed failed Begin transfers this proof before returning its definitive Cancelled/TimedOut refusal. Pre-claim refusals remain NotClaimed; dirty failures retain cleanup ownership and Abort. No failure automatically retries. Full at owner submission still returns the original unqueued permit; a core refusal requires a fresh explicit attempt if the Registry work remains eligible.

Terminal acknowledgment can hide a retained result, but the row and reservation cannot be reused until internal disposal and queued/reply ownership checks pass. A missing core ID, terminal label, diagnostic join field or caller acknowledgment is not disposal evidence. Scheduling expiry applies only before claim; Ready follows the core's claim-based completion deadline. MayHaveRun remains sticky after cancellation and timeout.

## Progress, flush and shutdown

Each actor round checks cancellation and deadlines, polls at most two retained workers, processes its existing command turn, handles at most one preparation and starts at most one candidate. Selection scans at most 16 submissions, skips occupied devices and waits when both slots are retained. Unfinished workers, including a body held before thread exit, keep their slot and credit. The existing 1..100 ms tick supplies completion progress without another client command. This stage makes no bounded fairness claim under continuous ingress and adds no completion wake mechanism.

Generic flush asks the authority for exact current-handle egress classification. It skips only a live tracked fence. Other carriers still export normally; stale generations and real authorization/transport errors keep their existing closure behavior. No tracked packet can escape through this path.

Registry inspection and end-claim set a bounded readiness latch only after real promotions. The actor publishes it after start/refusal, polling, cancellation and disposal, alongside stage 1's preparation bridge. Successful first-page DrainWork takes pending effects before clearing shared readiness. Refused drains preserve the bit. Promotion neither executes work nor renews its assembly-based scheduling deadline.

`RunDrained` is internal evidence of actual core/target drainage. Every healthy, Abort and actor-unwind cleanup path retains rows, mappings and backing until it obtains this proof. No queue/status, session epoch, mailbox or gate lock spans a waiting join; the actor may retain its exclusive Runtime slot. Dirty drainage does not authorize Clean. Panic/poison and terminal-write failure preserve Abort and the existing typed writer owner. Actor-side quiescence and owner-side recovery remain joined and idempotent.

## Bounds and evidence

The limits remain 512 status rows, 32 per device, 16 preparation/reply/submission/target slots and two retained core slots. Status costs 2,048 original-session bytes, registration 4,096 bytes and tracked admission atomically prepays 2,172,416 bytes before Begin. Backing uses the checked actual `State + RuntimeFixed + 4096` size before allocation/writer acquisition. The tested 64-bit layout, including test-only fault hooks, is 220,776 + 2,048 + 4,096 = 226,920 bytes; Row/ReplyCell/Pending/Submission are 424/48/136/40 bytes. Production computes its own smaller layout from the same types with test fields excluded.

Twenty added tests cover:

1. Twelve owner lifecycle cases: joined Ready for all three outcomes without response delivery; exact scheduling/completion deadlines; two occupied slots, busy-device skipping and cancellation before selection; explicit retry after resource/spawn refusal; actual pre-Begin cancel/Requested/Abort under full ordinary/control/event lanes while another worker is retained; early hidden terminal ownership; exact disconnect/removal/replacement and successor generations; panic, gate/status poison, healthy close, Abort and actor unwind; forgotten consuming permits, held worker exits, original-pool refunds and typed terminal-write failure.
2. Five Registry cases: exact fence classification across replacement and real authorization/deadline failures; actual inspection/end-claim promotion latching; no duplicate preparation bridge or fabricated readiness from stale disposal.
3. Three authority composition cases: dirty drain retains execution credit and writer through actual exit; an unpolled worker panic found during drain prevents Clean; healthy quiescence permits repeated drainage and a clean close.

The owner readiness cases use inflight=1 and events=1, cover post-spawn admission refusal and claimed failed Begin, preserve the original assembly deadline, and prove a failed drain cannot lose the notification. Existing scoped Claim, tracked packet/receipt, status-cap and same-permit admission suites remain in the regression run. Stage 1's admission-only tests use a test-only dispatch pause; the new lifecycle cases use the real enabled owner path.

Validation: 335 Rust tests, 9 doctests, strict all-target Clippy, formatting, example builds and all seven unchanged Node reciprocal/source checks pass. Independent source review found no P1/P2. These are synthetic fixture results, not live service or phone evidence. Stage 2B remains the next separately agreed checkpoint.
