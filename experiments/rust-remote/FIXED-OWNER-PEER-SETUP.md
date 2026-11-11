# Private actor-owned peer setup

Checkpoint 3 increment 2B.1 implements only the peer setup/request portion of [the agreed delivery plan](FIXED-OWNER-DELIVERY-PLAN.md), on top of stage 2A at `18229be6`. A fresh private fixture can move its real synthetic Channel into the existing owner actor, then request an empty GET `/rpc` through the real Registry receive path. Public start and carrier clients gain no fixed capability.

**Results still stop at joined Ready.** The actor does not emit/consume a response, construct acceptance evidence or report Completed. No completion wake or fairness behavior changes. Increments 2B.2 and 2B.3 remain separately gated; remote has no dependency on either frontend, network, HTTP client, production/existing profile, provider, real phone or mobile/GUI work.

## Consuming setup and exact identity

`PeerTransfer` contains an exact Handle and non-Clone Channel from the fixture's completed HELLO/ACCEPT flow. Its constructor is restricted to the private supervisor scope. Setup accepts no caller delivery assertion, peer-key authority, verifier callback or executor. A mismatched Channel can pass opaque setup but cannot produce a valid request; authenticated Registry receive closes that exact carrier when it fails.

Mailbox adoption publishes an exact target/original-budget descriptor only for a current Phone with empty Registry and mailbox output, no active claim/fence, and valid access. The authority checks target plus Handle identity and takes session access before the mailbox lock. Desktop targets can retain ordinary fixed registration, but receive no peer-setup descriptor. Inspection returns the existing budget handle and does not rebind or allocate another pool.

Peer admission looks up that descriptor under the queue mutex, unlocks to reserve **4,096 bytes from the original connection/device/global budget**, then locks again to recheck stop, current descriptor identity, peer capacity and operation/reply capacity before accepting the Channel. A refusal refunds the transient reservation. Full and other pre-admission refusals return the original transfer with its Channel unchanged. The actor checks current authority, empty output and absence of a claim again before installation.

Once accepted, setup owns the transfer until installation or exact-carrier closure and destruction. Pending and installed peers share one 16-cell ledger. A closed generation's queued transfer retains its cell and charge until actor resolution; replacement cannot reclaim that cell early or close the new generation. Installed peer cleanup removes only the exact ledger serial and target. The Runtime holds the Channel and its moved reservation; shared cells hold identity/state only.

Peer setup and fixed requests share the existing 16 operation/reply cells. Accepted operations pin their exact reply cell until resolved. Dropping a pending reply marks it abandoned; it does not discard the accepted operation or make its slot reusable. A timeout leaves the same receipt available for a later wait. Losing a reply supplies no permission to replay. Unread success or abandoned setup can retain one bounded installed peer until exact closure or service shutdown.

## Fixed requests and output isolation

`request_fixture` accepts an exact installed target and i64 request ID. The existing phone codec still restricts IDs to JavaScript's safe integer range. It encodes only empty GET `/rpc`, seals using the actor-owned Channel and calls normal `receive_request`; actual promotions feed the existing coalesced readiness path. Registry job/input accounting remains unchanged.

A pre-seal codec refusal leaves channel counters usable. From the seal attempt onward, any stop, capacity, decryption, duplicate-request or receive failure closes and drains the exact carrier. The operation is never retried automatically. Another carrier and a successor generation remain usable. Requests can continue while a tracked response is retained Ready, subject to normal Registry limits.

Ordinary Send, Finish and MemoryHttp dispatch against an installed peer target return local Full before sealing, invoking HTTP or consuming work, including between tracked claims. Other carriers preserve ordinary behavior. The generic flush's stage 2A tracked-fence exclusion is unchanged. No output bypass or peer Channel export is added.

## Accounting and validation

The unchanged 4,096-byte allowance is checked before fixed backing allocation/writer acquisition and again before accepting a transfer. It bounds the larger queued/runtime peer representation, Request metadata, at most 256 plaintext bytes, two 281-byte crypto/wire buffers and 1,024 bytes for codec containers/path/scratch. Tests measure the actual safe-ID-extreme encodings, vector capacities and request path/body allocations. No allowance was increased.

On the tested 64-bit target, including test-only hooks, backing is **237,424 bytes**: State 227,568 + RuntimeFixed 5,760 + 4,096 slack. Row/ReplyCell/Pending/Submission sizes are 424/56/248/40 bytes. Backing includes the 16 target descriptors, peer ledger and inline operation/Runtime storage once. Production computes its own actual layout. Status remains 2,048 original-session bytes, registration 4,096 bytes and tracked claim admission 2,172,416 bytes.

Ten owner integration tests plus one allowance test add evidence for:

1. Consecutive real fixed requests at safe ID extrema; unsafe-ID pre-seal refusal; fixed 200/502/504 staying Ready with no response packets; exact peer lease release on closure.
2. Connection/shared-device/global needed-minus-one and exact setup charging; unchanged Channel after Full retry; foreign-service and Desktop refusal; abandoned and timed-out setup/request replies retaining bounded accepted effects.
3. Eight installed plus eight pending peers, all 16 operation/reply cells occupied, forgotten consuming handles and joined stop drainage; queued old-generation charge retained across a real Attach replacement until resolution.
4. Ordinary producer refusal without work/HTTP consumption; bad Channel, duplicate request and post-seal connection-budget exhaustion closing only the exact target; unread ordinary output and active-claim setup refusal; mailbox poison retaining the joined typed writer owner.

Validation: 346 Rust tests, 9 doctests, strict all-target Clippy, formatting, example builds and seven unchanged Node reciprocal/source checks pass. Existing scoped Claim, tracked packet/receipt, owner admission and stage 2A lifecycle tests remain independent. These results establish private synthetic setup and request ownership, not actor delivery or live interoperability.
