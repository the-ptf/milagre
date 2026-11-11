# Synthetic phone HTTP dispatch contract

`http_dispatch` ports the forwarding contract in `apps/daemon/src/phone-channels.cjs` without a fetch implementation, listener, configurable URL, credential reader, or callback. Its target and bearer token are fixed public synthetic constants. It is not a bridge router or evidence of phone interoperability.

## API and owner boundary

- `prepare(&phone::Request) -> Plan` borrows raw body bytes, constructs the synthetic URL, removes Node's eight blocked headers, and adds the synthetic Authorization header. GET and empty POST omit the body. It preserves JavaScript numeric-property ordering and ignores a string `__proto__` assignment like Node's plain header object.
- `response(id, Outcome) -> phone::Response` maps the fake response or error. Only content-type and etag are forwarded. Timeout maps to 504, unavailable and oversized response to 502, with Node's exact JSON messages. Response parts use the existing 256 KiB splitter and encrypted channel.
- `MemoryHttp::new(Outcome)` creates a one-shot fake exchange. Clones share consumption and `calls()` observation. It takes no target, token, arbitrary closure, transport or existing-store argument. `TooLarge` represents an observed response beyond 64 MiB without allocating it in Rust; `Timeout` represents a fake timeout, not an asynchronous timer.
- `Registry::dispatch_synthetic(token, http, now)` and owner-only `Command::DispatchSynthetic { token, http }` revalidate generation, revocation, request state and deadline before invocation. The command returns `Reply::Dispatched(DispatchRecord)` containing request id, method, sent-body byte count/hash, status and number of response parts. The narrow `CarrierClient` cannot invoke dispatch. There is no request-body export to an external worker.

Invocation consumes the fake outcome once. Response framing, encryption and queue insertion complete before the work token becomes Completed and queued work is promoted. Delivery then uses the supervisor's existing one-attempt carrier flush. Completion is distinct from phone receipt: `DeliveryUnknown` closes the carrier without replay, including when HTTP invocation already happened. A duplicate token cannot invoke again; a consumed MemoryHttp also cannot execute a different job. A spent fake is rejected outside carrier-failure handling, so misuse cannot close another live carrier or cancel its requests. Dropping a command receipt does not cancel/replay an accepted operation.

## Bounds and cancellation

Constructor checks bound retained body capacity to 64 MiB and retained header map/string capacity to 64 KiB. Synthetic response header names must be ASCII HTTP tokens and values must be Latin-1 without NUL/CR/LF. Plan metadata is limited to 64 KiB headers and 16 KiB path; request bodies retain the existing 8 MiB cap. All these checks are additional Rust admission constraints, not claims that Node has identical limits or accepts exactly the same header inputs.

Command admission charges the fake outcome's retained capacity against the shared command/global pool before enqueue. Caller allocations before submission and copies retained by the fake's caller remain caller-owned. Before invocation the worker atomically reserves encoding/encryption scratch **and every final frame lease** against the Session's shared connection/device/global budget. Each ciphertext and its lease move into the mailbox without copying or reacquiring budget. Preflight checks response frame count and estimated wire bytes against available output capacity. Insufficient capacity refuses before invocation and leaves the token/carrier and fake outcome intact. A later attempt after capacity becomes available may proceed. An execution failure after invocation is never retried.

The default 32 MiB command/output queues and 64 MiB connection budget mean this implementation can reject responses smaller than Node's 64 MiB response limit. It does not stream responses through a real writer. Codec support for a 64 MiB response is not a service-level promise to accept that response under concurrent budgets. Existing raw JSON depth/token limits and strict schemas also remain explicit compatibility differences.

Dispatch is synchronous and bounded; it creates no per-request thread or task. Revocation guards surround the fake invocation and every channel operation. A stale, removed, disconnected, expired or disposed work token cannot invoke it. Worker shutdown joins all owned work, and deadline ticks continue while idle. There is no asynchronous fetch to abort: actual external task cancellation and unknown side-effect outcomes still require a separate integration contract. Node's active fetch continues on disconnect and suppresses late output; the existing lifecycle oracle records that difference.

## Actual Node evidence

`tests/http-node.mjs` extracts the actual Node `forward` and `respond` function bodies plus their constants, imports actual `relay-rpc.mjs` splitting, and injects fake fetch and a fake timeout-signal constructor. It never imports the service startup graph. The oracle records source hashes and six traces in `tests/fixtures/http-node.json`: mixed-case blocked headers and GET body omission; POST bytes containing a lone-surrogate escape and literal PUA; empty POST with multipart response; timeout; unavailable; and response exceeding 64 MiB. Node's real Headers object supplies response-header normalization. Oversize allocates only synthetic bytes and never contacts an endpoint.

The Rust `http_conformance` example consumes those case descriptions on stdin. Verification compares request plans, body hashes, status/headers, and every serialized response-frame hash against Node. Fixture bodies are raw bytes, never reserialized JSON; lone-surrogate/PUA body content remains unchanged. Unicode-unrepresentable paths/headers still have the documented strict-decoder limitation.

```sh
cargo build --offline --locked --manifest-path experiments/rust-remote/Cargo.toml --example http_conformance
node experiments/rust-remote/tests/http-node.mjs experiments/rust-remote/target/debug/examples/http_conformance
```

Use `node experiments/rust-remote/tests/http-node.mjs --record` only after reviewing an intentional source-contract change. The normal check compares committed fixtures first.

Rust regressions cover multipart encrypted delivery, one-shot invocation across repeated/distinct tokens, stale/expired/removed/disposed refusal, unknown delivery without replay, queued promotion, response-budget preflight, command-capacity admission, malformed header shapes, allocation amplification, route bounds, and exact error bytes. This checkpoint brings the crate to 135 tests and six compile-fail doctests, plus six Node compatibility checks.

## Still unwired

Production HTTP fetch and bridge authentication/routing, owner authorization UI, existing device/profile persistence and restart recovery, LAN discovery, relay proof/reconnect/hibernation, socket ingress/egress backpressure, live subscriptions, provider dispatch, asynchronous cancellation and real phone tests remain absent. No production listener, endpoint, profile, key, daemon lock or mobile file was touched. Invalid/oversized/over-quota requests still close a carrier instead of Node's per-request 400/413/429 responses. Batch scheduling and real-frame token census remain separate work.

## Pre-invocation budget safety follow-up

`MemoryHttp::required_bytes(request)` exposes the conservative additional byte requirement for diagnostics; it is not a reservation. Dispatch holds the fake's internal mutex from preflight until it consumes the outcome, preventing concurrent consumers from changing the outcome behind the bound. A single atomic reservation covers four times the wire bound, 512 bytes per frame, three times request metadata, and 4096 bytes overhead. Frame leases are split from that existing reservation without counter release/reacquisition. Remaining scratch is released after encoding. The supervisor moves ciphertext plus its lease into the mailbox, so no allocation or budget reservation is introduced by handoff. Mailbox count/byte caps and disconnect/unknown delivery still apply, without replay.

An exact threshold regression fills the real 64 MiB connection budget leaving required-minus-one bytes: invocation count stays zero and the work remains live. With exactly required bytes free, both multipart response frames queue successfully. A separate test fills the whole global pool after dispatch and still delivers the prepaid frame. Boundary/escaping tests compare the wire estimate with actual encrypted-frame lengths over chunk boundaries and control-character metadata. Existing shutdown/revocation tests verify transferred leases release on close.

Plan validation failures also return before invocation without closing unrelated work. A future real worker must translate invalid requests to per-request errors. Response size is known only because this is an injected fake; real fetch integration must reserve a bounded completion/error path before the side effect, enforce a streaming response cap and produce Node's 502 error when the body does not fit. It must not close and invite a POST replay as its size-control strategy. A claimed external POST must never be started twice. None of that worker/network behavior is implemented here.

Oracle scope remains pre-fetch plans and fake outcomes. Real fetch normalization for differently cased duplicate request headers, invalid/non-ASCII header names, URL percent-encoding, 204/304 bodies and statuses below 200 is not demonstrated. HEAD/PUT remain rejected by the GET/POST transport codec. Existing query-string fixtures cover literal target concatenation only.

## Timeout delivery and future claim contract

Node's fetch timeout remains `TIMEOUT_MS = 340_000`. The default registry completion lifetime is now `REQUEST_LIFETIME_MS = 345_000`: fetch timeout plus `DELIVERY_MARGIN_MS = 5_000`. Promotion begins that lifetime. A timeout result arriving at promotion plus 340 seconds can still be encoded and delivered; at the request deadline it is refused. Custom short registry lifetimes remain available for synthetic tests and are not valid real-fetch configuration.

The synchronous fake has one serialized claim point: after token/generation/deadline validation and complete reservation, PreparedExchange consumes the one-shot outcome under its mutex. Preflight errors do not claim, consume or cancel work. After invocation the result is completed once or fails without replay. There is no asynchronous fetch, public async Claim ticket, or detached callback introduced here.

Before a real worker is wired, it must add an atomic request-level `Claim` transition from InFlight to Dispatching, return a single-use continuation, and retain ownership of cancellation and completion/error capacity. A lost claim receipt must be observed again, never repeated as another POST. The real fetch deadline must start at claim, and completion expiry must be claim time plus timeout plus delivery margin; delayed unclaimed jobs need their own bounded scheduling deadline. Thus the five-second margin is not permission to start an arbitrarily late 340-second fetch against the current promotion deadline. That async lifecycle is an explicit integration prerequisite, not implemented functionality.

A manual-clock regression keeps the normal 45-second carrier idle deadline alive with other encrypted requests. It receives and decrypts the exact Node 504 at 340 seconds and at completion deadline minus one millisecond. At the exact completion deadline, invocation count remains zero and the token is TimedOut while the carrier stays active. The test does not enlarge the idle limit or disable periodic expiration.
