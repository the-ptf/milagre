# HTTP transport dependency and allocation audit

Status: source-only prerequisite audit after proposal `c2a244578ee07c3b1ada288aaf677906dc17c6ce`. No code, manifest, lockfile, counter, listener or Begin changed. No HTTP/network execution, build or allocation measurement was run. The private 128 MiB connection/device target is accepted; ordinary 64 MiB limits and the original 256 MiB global pool remain unchanged.

Accepted by root after independent source review found no P1/P2. Root independently
verified all 19 archive checksums and the fixed/reference arithmetic below. The next
authorized implementation is a standalone offline allocation/ownership probe only,
under `fixtures/http-transport-check`, with its own manifest/lockfile and pinned graph.
It cannot open a listener or connection, import production authority, or enable HTTP
Begin. Measurement and source-derived bounds must be reviewed before any later adoption.

**Conclusion: keep Hyper's HTTP/1 parser, prefer a retained thread with a small safe IO driver, and do not authorize HTTP Begin yet.** The source identifies bounded containers and a small dependency set, but neither the existing builder settings nor this audit certify a complete worst-case heap charge. Container growth, hidden parser allocations and new adapter layouts still require a focused offline allocation/ownership prerequisite. The fixed payload/stack/output arithmetic fits one or two claims with substantial room; that room is not an invented transport allowance.

## Source freeze and dependency closure

Repository source is the remote tree at `e5827fb733a50f231247bfd1d729674b32a28910`, plus the accepted proposal above. The concurrent fairness test edit was not used as allocation evidence. Local compiler: `rustc 1.99.1`, commit `58cf8f9c35b355199727627d07ae34a4e2846d67`, host `aarch64-apple-darwin`. Installed standard-library source is absent. No portability or allocator-RSS guarantee follows from this target-specific audit.

Registry root: `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`. Archive root is the corresponding `registry/cache/` directory. I compared every regular file of each of the 19 archives listed below with its extracted source; all matched. SHA-256 values below are the `.crate` archive checksums that belong in Cargo.lock, not invented versions or hashes of dependency names. No resolution was run, so a future locked offline resolver/feature-tree check is still required.

The smallest candidate's complete registry dependency closure has these 13 packages. Direct public-to-module dependencies would be Hyper, http, http-body, bytes and httparse; Tokio remains required transitively for synchronization. Exact lock pins and feature isolation must prevent another feature from silently activating a runtime or connector.

| Package | Required effective features | Archive SHA-256 |
| --- | --- | --- |
| `hyper =1.12.0` | `client,http1`; defaults empty | `2c3e324da4c95177d6291d4c8730197c0d1822f8a9766814a4a44fa5ab797c9c` |
| `tokio =1.54.1` | `sync`; defaults empty | `b52fd3255258d26fac7264ab5a76b53c13367136dc011d3d6ad4f8ed070396a3` |
| `bytes =1.12.1` | `std` | `fc652a48c352aef3ea3aed32080501cf3ef6ed5da78602a020c991775b0aff04` |
| `http =1.5.0` | `std` | `918d3568bebf352712bc2ef3d46a8bcf1a75b373be6539de198e9105cbbf9ce0` |
| `http-body =1.1.0` | none | `ca2a8f2913ee65f60facd6a5905613afaa448497a0230cc41ce022d93290bc2c` |
| `httparse =1.10.1` | `std` | `6dbf3de79e51f3d586ab4cb9d5c3e2c14aa28ed23d180cf89b4df0454a69cc87` |
| `futures-core =0.3.34` | `std,alloc` | `92d699e522242e69e3003b94ecc1f960f3a5e015aa7c5d7486e65ad01dd94f5e` |
| `atomic-waker =1.1.2` | none | `1505bd5d3d116872e7271a6d4e16d81d0c8570876c8de68093a09ac269d8aac0` |
| `itoa =1.0.19` | none | `3bd1574e617a9a6c1f8f8181bd7e841e1f20e4277607ef28945765188d6284d4` |
| `pin-project-lite =0.2.17` | none | `a89322df9ebe1c1578d689c92318e070967d1042b512afbe49518723f4e6d5cd` |
| `smallvec =1.16.5` | `const_generics,const_new` | `149309498a5f7334b12ddae0cad8aba81ce785fe91755068867e017cf98fee46` |
| `want =0.3.2` | none | `ec4cdd0dd910afe868b7ef477227d8d538b46b3075031afee8a9f2acb0a2ed0b` |
| `try-lock =0.2.5` | none | `e421abadd41a4225275504ea4d6566923418b7f05506fbc9c0fe86ba7396114b` |

No `http-body-util` is required: implement a private bounded Body over the retained request and poll response frames through `http_body::Body`/`std::future::poll_fn`. No `futures-util`, Tokio macros, Hyper server, HTTP/2, TLS, URL connector, proxy, cookie, decompression or retry package is required. The synthetic server can use httparse over fixed request-head storage, exact known Content-Length and fixed scenario output. It must refuse chunked uploads; the client knows the retained POST length and emits a fixed-length body. This is a stated fixture restriction, not a custom unsafe HTTP parser or general server implementation.

The owned Tokio alternative adds these exact packages on this Mac; the two Windows packages are conditional lock-closure pins, not Mac allocations:

| Package | Features for the alternative | Archive SHA-256 |
| --- | --- | --- |
| `hyper-util =0.1.21` | only `tokio`, which also enables Tokio `rt,time` | `ddc03d96684f9226b8a787cdb71488417b53ab5ea8fdb1dac946cb9431cc8bff` |
| `mio =1.2.4` | `os-poll,os-ext,net`; disable default `log` | `1788edb87fdc09c7e26304471e2f5be8cdefb1b6930d6e3985fc02ff53bf86ee` |
| `socket2 =0.6.5` | `all` | `c3d1e2c7f27f8d4cb10542a02c49005dbd6e93095799d6f3be745fae9f8fedd4` |
| `libc =0.2.191` | `std` | `65cd87c9a6d60536580b316ad985726104730a5151c99845f2490428ef91240a` |
| `windows-sys =0.61.2` | conditional OS features requested by Tokio/Mio/socket2 | `ae137229bcbd6cdf0f7b80a31df61766145077ddf49416a728b02cb3921ff3fc` |
| `windows-link =0.2.1` | none | `f0805222e57f7521d6a62e36fa9163bc891acd422f971defe97d64e70d0a4fe5` |

Tokio's effective alternative features are `sync,rt,net,time` plus their libc/Mio/socket2 edges. `io-util`, `macros`, `rt-multi-thread`, `process`, `signal`, `fs` and `parking_lot` are unnecessary. Use only Hyper-util's `TokioIo`, never `TokioExecutor` (its implementation calls `tokio::spawn`). Driver/response/body futures remain inside one owned root future. `TokioIo` does not allocate separate backing; the wrapped runtime does. Optional non-Mac/WASI targets would need their own exact closure before support is claimed.

## Smallest retained execution stack

Hyper `src/client/conn/http1.rs:574` returns a connection future; it does not spawn it. HTTP/1 production code uses Tokio's mpsc/oneshot synchronization in `src/client/dispatch.rs`, not Tokio net/time/runtime. Those channels are runtime-independent. Therefore the smallest candidate retains the existing requested **2 MiB OS thread stack per claim**, a private `Wake`/`Waker` tied to that owned thread and bounded socket/HTTP state. Use safe `hyper::rt::ReadBufCursor::put_slice` from a prepaid initialized scratch block. Do not add unsafe application IO casts or reimplement Hyper's HTTP decoder.

The blocking variant performs one `TcpStream::connect_timeout` to the private literal endpoint, with a proposed 100 ms connect sublimit, then sets the stream nonblocking. A connection failure is terminal after Begin, with no retry. The connect sublimit is an additional fixture restriction and delays cancellation observation during that call; it does not reset or extend the claim's 340,000 ms deadline. Immediately after connect returns and before any request write, recheck the shared clock/deadline and cancellation; a late or cancelled connection closes without writing and retains MayHaveRun. A fully interruptible nonblocking connect would require socket2 plus a separately reviewed pending-connect driver. Do not imply that read/write cancellation can interrupt an in-progress std connect call.

After connect, each owned thread turn polls connection and body state with a fixed IO allowance, checks cancellation/time, and uses a bounded `park_timeout` only when no progress is available. The same worker drives its IO; no detached timer, reactor or socket task exists. Pending IO must register its task waker and arrange the next timed probe. Cancellation and deadline notification register/recheck as in the proposal, then wake the worker's stored waker; the owner's WakeToken remains a separate signal. Spurious/self wakes never bypass the turn's byte/work allowance. Normal owner turns never join a running worker.

This driver is a recommendation for the offline prerequisite, not proved code. Its Pending/wake protocol, manual-clock deadline propagation and blocking-connect cancellation window must be tested before selection. If these are harder to prove than the owned Tokio alternative, retain Tokio and pay for the actual runtime layout instead of claiming the thread driver works already.

The server remains one separately joined thread with two generation/device-bound inline exchange cells, plus one bounded rejected-accept cell. Each slot retains its original claim budget and canonical-device occupancy through destruction of its socket/futures and a private completion receipt. Driver panic retains unresolved charges until real driver join. No new client can reuse a slot merely because the old client returned or its status was acknowledged.

## Source-derived HTTP allocation census

These are simultaneous storage objects and their count constraints, not an assumed flat allowance. Paths below are relative to the pinned crate shown; package archives above pin all their bytes.

| Allocation or work | Source and concrete finding | Required bound or unresolved proof |
| --- | --- | --- |
| Hyper read storage | Hyper `proto/h1/io.rs:229-250` reserves `min(next,max-len)` but exposes the whole remaining BytesMut capacity to IO. Bytes `bytes_mut.rs:626-806` can grow/reclaim by offset and retain shared backing after split/freeze. | `max_buf_size(65_536)` is a length/read-strategy control, not a 65,536-byte backing-capacity proof. Clamp actual IO reads to at most 65,536 and one read per driver turn; account for old/new backing during reallocation and every live alias. Exact byte ceiling is still unproved. |
| Read aliases | Hyper `body/chan.rs:11-29` allocates one Arc containing one data item, one pending error and one trailer map. `Incoming::poll_frame` moves a frame out. | Keep at most one application frame, copy it into staging and drop it before polling connection again. Account for channel-held frame, application frame, mutable read tail and any response-header slices. Bytes lengths are not their backing capacities. |
| Final/interim header parser | Hyper `proto/h1/role.rs:1042-1163` uses 100-element `HeaderIndices` and httparse-header SmallVecs, then allocates HeaderMap/name storage. Noncanonical reason phrases are copied and inserted into Extensions. | Keep default/explicit 100 header count, 65,536-byte final head, no case/order preservation or lenient parser options. At 100, SmallVec `src/lib.rs:2055` stays inline despite the Builder docs' generic heap-allocation statement; arrays consume stack. More than 100 would spill. Names, reason, Extensions and maps remain heap. |
| Response/trailer HeaderMap | http `header/map.rs:561-582,752-782,1751-1830` rounds raw capacity and stores boxed indices, entry Vec and duplicate-value Vec. With at most 100 total fields, initial reserve rounds to 256 indices/192 usable entries; incremental trailer insertion also reaches at most 256 indices. Collision thresholds are 128 displaced entries/512 forward shifts per insertion and cannot be reached by 100 distinct entries in a fresh map. | A response/trailer map bound is `256*size_of(Pos) + 192*size_of(Bucket<HeaderValue>) + duplicate_capacity*size_of(ExtraValue<HeaderValue>) + owned-name/value bytes`. Duplicate capacity needs the pinned Vec growth rule; it must not be substituted with duplicate length. Include old/new storage during growth. Private layout sizes and allocator-capacity growth require evidence. |
| Trailer parser | Hyper `proto/h1/decode.rs:277-285,533-674` accumulates BytesMut, then allocates `vec![EMPTY_HEADER; count]`, copies names/values into a new HeaderMap and can format a bad header into an error String. | At most 100 trailer fields; with `max_header_size(65_536)`, the `>=` check rejects the byte reaching 65,536, so accepted trailer storage is **strictly below** 64 KiB. Source's aggregate chunk-extension ceiling is also strict: fewer than 16,384 bytes. Include raw trailer buffer, parse array, output map/copies and error formatting at the same time. |
| Request serialization/map | Hyper `proto/h1/role.rs:1226` reserves an estimate, then extends the serialized request-head Vec. `proto/h1/io.rs:535-591` starts at 8,192 bytes; flattening can copy body data, while queued writes retain a VecDeque. Existing `http_dispatch::header_bytes` charges 128 per caller field within 65,536, giving at most 512 caller fields; count up to 515 with generated Host/Authorization/Content-Length. | Force queued writes. Bound serialized request head to 98,304 bytes (16 KiB path, 64 KiB admitted header representation and framing/synthetic fields); check before Begin. Request maps can cross collision thresholds: with <=515 distinct fields, danger growth can reach 4,096 indices/3,072 usable entries before the load-factor rule switches to safe hashing. Include this capacity, duplicate values and old/new tables in P, plus URI and serialized head simultaneously. The response's 256-index figure does not apply here. The 64 KiB buffer setting is not a request-head cap. |
| Request body queue | Hyper `proto/h1/io.rs:30,586` limits queue count to 16 and tests bytes **before** adding the next buffer. | Return at most one 64 KiB `OwnedRequestChunk` per driver turn. Implement Data as a private `Buf` borrowing the retained immutable request holder, so the queued payload remains the original charged upload. A <=64 KiB chunk can overshoot the 64 KiB write threshold; queue payload length can approach 128 KiB. Charge up to 16 descriptors plus deque growth, not a second 8 MiB body. No Full/collect helper. |
| Dispatch channels | Hyper `client/dispatch.rs:29-44,109-142` creates an unbounded Tokio mpsc internally but permits one HTTP/1 buffered request; this adapter submits exactly once. Tokio `sync/mpsc/list.rs:59` allocates an initial block; `mpsc/mod.rs:140` sets 32 slots on this target. One send allocates an Arc-backed oneshot. | Prepay one 32-envelope block even for one request, channel Arc/cache padding, want Arc, one oneshot Arc, Hyper's boxed body slot (`proto/h1/dispatch.rs:85`) and error/callback objects. Never clone/export the sender or resubmit after error. Exact instantiated envelope/body sizes are not known until the private Body is defined. |
| Wakers and receipts | Atomic-waker stores one AtomicUsize and Option<Waker>; Hyper body channel has two. Tokio channels/oneshot retain their own wakers. A std Waker can share one owner-created Arc. | Repeated registration may clone the same Arc without payload duplication; prepay the owning allocation, all waker fields, cancellation cell and checked generation. A stale waker must keep its backing paid or be revoked before slot reuse. The final owner type/layout does not exist yet. |

Hyper allocates some of these objects after Begin even if the handshake was prepared earlier. Charge their worst simultaneous capacity in advance; do not call the path allocation-free. Ordinary allocation/process abort remains outside typed recovery, as in the existing crate. A fallible pre-Begin staging failure must still join any dormant worker and return all exact grants.

## Exact caps and bounded polling

Keep GET/POST, 8 MiB upload, 16 KiB path and 64 MiB decoded response. Set `max_buf_size(65_536)` and `max_header_size(65_536)` together; never then call `read_buf_exact_size`, since the Builder setters unset one another. Leave count at 100, disable HTTP/0.9, case/order preservation, obs-fold, whitespace-before-colon and invalid-header tolerance. Reject unsupported content/transfer coding. No redirect is followed.

The retained forwarded-header arena limits the final string representation, including names and joined duplicate values. Latin-1 response bytes can expand when represented as UTF-8; preflight that conversion into the fixed arena and select the prepaid refusal/error if it does not fit. Do not allocate an oversized intermediate String. Conversely, request `HeaderValue::from_str` does not establish Node fetch's ByteString normalization for non-ASCII input. Preserve the existing stated compatibility gap and add actual Node comparisons before claiming that subset.

The proposal's **eight informational responses and 64 KiB aggregate raw informational heads cannot be enforced exactly from Hyper's public informational callback**. It exposes normalized status/version/headers, not raw head length or reason phrase. It also returns no error to stop parsing buffered 1xx responses. A concrete safe prerequisite is a fixed 64 KiB response-head gate using the already pinned httparse: parse each complete head in bounded borrowed storage, count exact raw bytes/1xx before releasing that head to Hyper, reject the ninth/aggregate excess and reject upgrade, then switch to bounded body passthrough. This duplicates header parsing, not body framing, and adds the explicit fixed gate buffer in the arithmetic below. It requires its own chunk-boundary/normalization tests. If that gate is declined, amend the cap contract explicitly; a callback counter is not equivalent evidence.

Limit inbound HTTP bytes to 72 MiB including head/framing, with a one-byte observation in existing scratch to detect overflow. Count actual reads, not Content-Length. The 64 MiB+1 data byte never enters response staging. Exact final-head 65,536 and trailer 65,535/65,536 behavior need separate tests. The server request-head buffer is 96 KiB because request path and headers have separate maxima; reusing the client's 64 KiB response-head buffer would silently narrow admitted requests.

Hyper `proto/h1/dispatch.rs:166-190` limits its outer dispatch loop to 16 iterations, but `role::Client::parse`, head parsing, extension parsing and trailer decoding have inner loops. A bounded driver turn therefore also needs at most one 64 KiB socket read, one <=64 KiB write, one request Body frame and one response-frame copy, with cancellation/time checked before and after. Further IO polls return Pending with a scheduled next-turn wake. Existing buffered data can still be parsed in the same poll; its source-derived maximum must be included in the offline instruction/allocation traces. A single poll must not consume unlimited ready socket input, regardless of self-wakes. For the two-cell server, visit each physical cell once and cap rejected accepts to one per turn.

These bounds cap work units, not OS scheduling latency. The connect sublimit, allocator calls and synchronous terminal joins are not hard real-time guarantees. A runtime timer must never replace the service's manual/monotonic Clock or extend the original claim deadline.

## Owned Tokio alternative: extra retained state

Tokio `runtime/scheduler/current_thread/mod.rs:139-198` allocates an Arc Handle, boxed Core and a 64-slot task deque even with no spawned task. `runtime/blocking/pool.rs:270-310` allocates the blocking-pool control Arc even when no blocking thread is used. `runtime/io/driver.rs:122-155` allocates Mio events, poll/waker/registry state; the default event capacity is 1,024 (`runtime/builder.rs:311`) and must be reduced explicitly for the bounded fixture. `runtime/io/registration_set.rs:33-107` allocates a 16-entry pending-release Vec and one Arc ScheduledIo per socket; shutdown can build another Vec of registrations. `runtime/time/mod.rs:145` adds timer-wheel state when enabled by Hyper-util.

No runtime allowance is certified here. Set a concrete small event capacity during an offline constructor probe, retain the runtime itself through worker join, and account for delayed registration release/shutdown allocations. Repeated request/socket churn can leave driver-owned allocations after the application drops a socket. A diagnostic `active_sockets == 0` cannot refund the runtime. The smaller thread driver avoids those objects; it still owes its own exact waker/state/park accounting and cancellation proof.

Kernel socket buffers, listener backlog, kqueue descriptors and OS thread implementation overhead are not Rust allocation leases. Keep their counts bounded and report them separately. For either driver, accepted known sockets are at most two; a rejected-accept cell adds at most one temporary socket. Client sockets are at most two. The listener stays owned until all authorized client/server work drains. OS buffer defaults are not claimed to equal a guessed byte allowance.

## Pre-Begin arithmetic and fit conditions

The table is a **proposed fixed storage layout with exact byte arithmetic**, not measured peak heap. Large arrays should be fixed boxed slices or equivalent stable storage; derive wrapper/Arc/container overhead with `size_of` and allocation evidence. Do not add pointer tables twice if they are inline in a charged enclosing struct. The 64-byte-per-block margin below comes from the existing standalone model's `required_bytes`; it is an accounting margin, not measured allocator metadata.

| Per claim fixed storage/charge | Bytes |
| --- | ---: |
| 1,024 response blocks of 65,536 | 67,108,864 |
| 1,024 eight-byte block pointers | 8,192 |
| Existing model's 64-byte block margin | 65,536 |
| Requested worker stack | 2,097,152 |
| Two prepaid ciphertext buffers of 1 MiB | 2,097,152 |
| Separate small error-frame backing | 1,024 |
| Three 1 MiB codec regions: plaintext, temporary crypto result, verifier plaintext | 3,145,728 |
| One base64 256 KiB chunk, `4 * ceil(262144 / 3)` | 349,528 |
| Retained forwarded-header byte arena | 65,536 |
| Safe IO scratch | 65,536 |
| Raw response-head gate | 65,536 |
| Server slot: 96 KiB request head + 64 KiB read + 64 KiB generated-write scratch | 229,376 |
| Existing status charge | 2,048 |
| **Fixed subtotal F** | **75,301,208** |

For the output bound, the existing `http_dispatch::bounds` formula gives `349528 + 6*65536 + 512 = 743256` wire bytes for one maximum part. The two 1 MiB packet regions cover that conservative estimate. They need **three** real Registry/mailbox credits including the small error slot; the same buffers transfer between owners, so Registry plus mailbox do not mean twice the payload allocation. Additional Packet/receipt/grant/slot metadata is still required. MaySend remains disabled for the first execution checkpoint, but these grants/backing must be prepaid.

The three codec regions cover simultaneous payload storage in the existing one-part shape: JSON plaintext, crypto's temporary result before final-frame copy, and verifier plaintext. They do not certify current whole-response APIs: `phone::response_parts` builds a Vec of all frames and cannot be used; `Channel::seal_encoded` currently allocates crypto output then copies it into another Vec. A bounded slice writer and one-part encoding path need capacity assertions. Do not treat the accepted fixed 65,536-byte scratch as sufficient for multipart HTTP.

Let `R_i` be the actual retained request body capacity plus metadata capacity, reconciled against its owned reservations rather than inferred from request length. The assembler's requested body reservation is at most 8,388,608, but `phone.rs:405-414` calls `reserve_exact` without checking the resulting capacity. That API is a minimum guarantee, so this audit cannot equate the charged target with actual capacity. The prerequisite must inspect actual capacity, prove it fits the existing lease or reserve any gap before claim, and refuse before Begin if it cannot. Let `P_i` be all additional request-plan/URI/map/serialized-head capacity. Let `T_i` cover the source-audited transport containers and transient overlaps above. Let `D_i` cover new wrapper, allocation-holder, receipt/grant, socket/waker, server-cell and row-layout overhead beyond F. These are still unresolved measured/layout terms, never zero by default.

The complete per-connection accounting condition is:

`F + R_i + P_i + T_i + D_i + other_connection_charges <= 134217728`.

Using the 8 MiB requested body charge as a reference, F plus that charge is **83,689,816 bytes (79.812828 MiB)**. It leaves **50,527,912 bytes** for any actual-capacity excess, request metadata, P/T/D and other connection charges. This demonstrates space for an auditable implementation; it does not prove those terms fit. Admission must reserve the additional terms atomically against the original counters while keeping R charged exactly once.

For a transparent global reference calculation, current non-test fixed backing is 214,000 bytes and a proposed server thread requests another 2,097,152-byte stack. With those **2,311,152** reference bytes, no other load and 8 MiB requested request-body charges:

| Concurrent full claims | Fixed reference total | Remaining from 268,435,456 bytes |
| --- | ---: | ---: |
| One | 86,000,968 | 182,434,488 |
| Two | 169,690,784 | 98,744,672 |

These reference totals exclude P/T/D, original request metadata, the server listener/driver/accept-cell structs, policy/Registry/session backing, extra status rows and every other producer. Actual admission uses the live original GlobalBudget, not this reference subtraction. For example, 510 other retained 2,048-byte status rows alone use 1,044,480 more bytes. Old-generation client/server claims remain charged and occupy the same device/execution bounds. Resource saturation is a typed pre-claim refusal, not permission to shrink response storage, borrow another pool or start without output credits.

## Remaining blockers and next authorized decision

1. **No certified T/D total.** Installed Rust std source is absent; Vec capacity growth, hidden private type layouts and allocator peak overlap have not been measured. Source shows exactly where the missing terms originate. An arbitrary 1/2/4 MiB transport allowance would be unsupported. The next prerequisite should instantiate the candidate offline over bounded in-memory IO, assert exact type/capacity counts, and record all allocations through worst-case header/trailer/body/error/cancellation traces before selecting a total. It must include old and new storage during reallocations and allocations after Begin-equivalent gate opening.
2. **Driver choice remains unproven.** Prefer the sync-only retained-thread candidate for that offline probe. Prove its register/recheck/timed-probe wake contract, one-connect semantics, manual-clock behavior and retained runtime/request/body ownership on panic. If selecting Tokio instead, add the exact alternative pins and measure current-thread constructor/IO/drop/shutdown storage. No network/listener is needed for either offline proof.
3. **Exact raw-head and output prerequisites remain work.** The httparse head gate must enforce raw informational caps before Hyper; malformed/header/trailer boundaries must match their documented fixture refusal. The three-slot output grant, bounded one-part codec and layout census must exist before any actual Begin. A current fixed-frame fence or whole-response Vec is insufficient evidence.
4. **Review evidence before enabling HTTP.** Require allocator high-water traces, retained-capacity assertions, leak/panic/join traces, source-pin/feature-tree verification and exact needed-minus-one/exact original-pool tests. Independent review should reject early lease refunds, buffer-capacity substitution, body collection, detached futures, ignored server occupancy or unbounded inner poll loops. Current source review is not that runtime evidence.

No dependency addition or offline implementation is performed by this audit. The concrete next action is review and authorization of the **offline allocation/ownership prerequisite only**. Listener construction, real HTTP Begin, MaySend, Completed, production profiles/credentials/routes, mobile changes, frontend wiring, pushes and host restart remain outside this checkpoint.
