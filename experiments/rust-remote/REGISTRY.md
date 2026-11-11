# In-memory established-session registry

`registry::Registry` owns established crypto sessions and synthetic carrier state. It has no listener, socket, fetch implementation, profile/device-store access, restart loader or shared daemon writer. Persistence and authorization remain in the separate temporary authority model. The registry consumes an already authorized `policy::Session`; it never treats crypto acceptance as pairing approval.

## Ownership and revocation

`open_carrier(carrier_id, now_ms)` creates an opaque, registry-bound generation handle. A repeated OPEN removes the old entry before release and creates a new pending generation. `establish(&handle, session, now_ms)` only accepts that still-pending generation. A late authorization callback, repeated establish, stale close, or response continuation cannot replace or close its successor. Handles and work tokens contain only identities/status atoms, never channels or request bytes.

`close(handle, reason)` removes the entry before it drops the channel, upload assembly, peer fragments, queued/in-flight requests and ciphertext queue. Drop cancels outstanding work tokens and releases registry-owned connection/device/global reservations and session admission permits. Carrier write failure follows the same close path. Dropping the whole registry retires every entry. Already completed tokens remain Completed; queued and running tokens become Cancelled.

`TemporaryAuthority::remove(&mut registry, key, now)` now composes removal: advance the device's shared opaque epoch, close matching registry entries, invalidate tickets, then persist the tombstone. There is no public independent `Registry::remove_device` or registry deny set. A later window can authorize and persist a fresh Session with the new epoch. Previously completed Sessions retain their old epoch and cannot establish, seal, open or deliver, even after re-pairing. An authority's retirement or drop also invalidates its Sessions. If a caller passes another registry, shared epoch checks still refuse old operations; `tick` reclaims that other registry's stale resources.

Epoch state is bounded by the authority's record cap, not a second lifetime-removal cap. The default 64-record/tombstone policy may refuse a new record at capacity, but removing more than 64 devices with a larger configured record bound never retires the registry or disconnects unrelated sessions. The test covers 70 distinct removals and later re-pairing.

A shared read/write guard linearizes guarded crypto, request borrowing and delivery against revocation: removal waits for an already-started guarded operation, then later operations refuse. Low-level borrowing callbacks must be short and must not reenter authority mutations; the synthetic supervisor uses no arbitrary executor callbacks. A previously returned ACCEPT slice or caller-owned byte copy cannot be recalled. Managed queued bytes and work leases are reclaimed by composed removal. Persistence failure remains fail-closed; no restart transaction or production store is implemented.

`Session` no longer exposes a raw mutable Channel. Its `seal_encoded` and `open_encoded` operations refuse after `revoke`; `reply`, `reader` and `writer` now return Result and also refuse after revocation. In the managed path the registry consumes Session and returns no channel/reader/writer to callers. Previously created unmanaged frame objects or arbitrary caller copies are outside registry ownership; they cannot operate the registry's revoked channel.

## Data and work APIs

- `send_encoded` and `send_peer` queue bounded encrypted output. `take_output(handle, now, callback)` borrows one ciphertext for an in-memory carrier and drops its lease after the callback. A failed callback closes the carrier. No owning buffer escapes the API.
- `receive_peer` authenticates and feeds the same-connection frame reader. Completed JSON stays raw/lossless and is borrowed by a synchronous callback. No daemon RPC executes here.
- `receive_request` authenticates a phone request part, uses budgeted upload assembly, and queues completed requests. It returns tokens for requests that can start immediately. `with_request(token, now, callback)` borrows a running request; it never lends an owned body to a detached task.
- `finish_request(token, encoded_response, now)` checks current carrier generation, request serial, status and deadline before parsing/sealing any response. A reused request ID has a new serial, so an old completion cannot finish its replacement. Serialized response/domain correctness is the future bridge adapter's responsibility; this checkpoint performs bounded raw JSON validation but no HTTP forwarding, authentication headers or RPC allow-list work.
- `WorkToken::status` exposes Queued/InFlight/Completed/Cancelled/TimedOut. Cancellation is cooperative for future adapters. Tokens retain no payload/lease, so holding a late callback token cannot pin a request body after disconnect. A caller that copies a borrowed payload must reserve and cancel its own copy.

Defaults are 16 carriers, 16 running and 64 queued requests per established phone, 16 MiB queued-body admission, and 256 outbound frames/32 MiB ciphertext. Request/body/local assembly limits retain the previous module's bounds. Combined upload+queued+running count is bounded; duplicate active IDs are refused. Quota/protocol failure closes this synthetic carrier, whereas Node can emit 400/413/429 for individual requests. Error-response mapping is separate work.

## Idle deadline processing

`tick(monotonic_now_ms)` must be driven periodically even while no frames arrive. `next_deadline_ms` exposes the earliest pending deadline for an eventual event loop. Tests drive this clock with no network input. There is no hidden timer thread or production event loop.

Tick expires pending HELLO at 15 seconds, established silence at 45 seconds, incomplete desktop frames at their fixed first-fragment deadline, incomplete uploads and queued requests at their 20-second local deadlines, and in-flight work at 340 seconds. It releases expired state and returns newly promoted work in queue order. Operations independently refuse expired/stale handles and request completions, and clock rollback refuses rather than extending a lifetime. Authenticated input or a trusted carrier `heard` event extends silence only; it never extends an incomplete frame deadline. Outgoing traffic does not extend silence.

These are explicit local admission policies. Node relay-host checks socket silence with `>` on a 20-second ping interval and shares the relay socket's liveness across its devices; this synthetic registry uses per-carrier `>=` boundaries. A real relay adapter must decide how to fan socket liveness out to multiplexed carriers. No per-phone transport heartbeat claim is made.

## Shared memory reservations

Every active entry uses the existing Session connection handle. All reader/writer output, retained fragments, carrier ciphertext, decrypt scratch, request parsing scratch, upload metadata/body capacity and queued/in-flight request ownership are charged to that connection's device/global hierarchy. Failed reserves roll back and the carrier closes.

`RequestAssembler::with_budget` and `receive_budgeted` return `LeasedRequest`, which retains metadata/body reservations through dispatch. The old unbudgeted `receive` method refuses on a budgeted assembler, so it cannot silently discard a lease during handoff. Managed parsing validates the raw depth/token bound before allocating headers, reserves conservative `32 * encoded_length + 4096` scratch, and accounts retained string/map capacity. Body growth reserves the new allocation while the old one is still charged, then transfers the lease. The registry reserves fixed entry/job/queue metadata allowances too. Over-reservation can reject a request before nominal wire maximums are reached.

These are allocation admission bounds, not whole-process RSS accounting. Caller-owned inputs/copies, allocator bookkeeping and unrelated temporary-authority records are not intercepted. A reservation deliberately held by a caller remains held after registry close; tests distinguish that external ownership from registry leaks. Observational `ConnectionBudget::global_used`/`device_used` aid synthetic assertions. Managed token-cap rejection is an additional restriction on dense phone metadata, and the real-frame census remains required before integration.

## Node evidence and tests

`tests/registry-node.mjs` extracts the exact `release`, `dropConn`, `dropOwn`, `sendEncoded`, `flushBatch`, `forward` and `onFrame` bodies from `apps/daemon/src/phone-channels.cjs`. It runs them with synthetic records, fake timers, deferred fetch and in-memory frame delivery; it never imports the service graph or starts a daemon. The committed fixture includes the production source hash.

Observed Node contract: remove the old record before cleanup; abort pending owner approval; clear queued requests/batches/timers; close live/peer channels; late record callbacks cannot touch a replacement. **Node does not abort an already-running fetch on disconnect.** It keeps the request timeout and suppresses the late response. The registry intentionally strengthens this by cancelling its owned in-flight token immediately; a future real fetch adapter must honor that token/abort signal. No remote cancellation message is invented.

Thirteen registry tests cover these rules, successful bidirectional fragmented peer transfer, lone-surrogate/PUA phone bytes, fixed fragment expiry despite activity, upload lease handoff/expiry, exact queue/request/idle deadlines, session revocation, reused request IDs, foreign handles, capacity failure, carrier failure and global/device/connection release while stale handles/tokens remain alive. The allocation suite also rejects dense managed phone headers before constructing a map.

The epoch safety checkpoint totals **83 Rust tests and four compile-fail doctests**. Existing three reciprocal Node checks remain required; the fourth Node check is the lifecycle trace, not a signature or app interoperability test:

```sh
cargo test --offline --manifest-path experiments/rust-remote/Cargo.toml --locked
cargo clippy --offline --manifest-path experiments/rust-remote/Cargo.toml --all-targets --locked -- -D warnings
cargo fmt --manifest-path experiments/rust-remote/Cargo.toml --check
node experiments/rust-remote/tests/registry-node.mjs
```

Service listeners, persistent revocation/restart, live-subscription bridging, real fetch cancellation, owner RPC dispatch, heartbeat integration and actual phone/relay interoperability remain separate. No production endpoint/profile/mobile change was made.
