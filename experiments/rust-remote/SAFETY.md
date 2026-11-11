# Review safety checkpoint

Addresses rust-remote P2.1/P2.2 and the requested P3.6/P3.7 cases from `rust-remote-codex-policy-review.md`, read from the review Worktree without changing it. Only this crate changed. No network requests, live keys, profiles, pairing, daemon or service locks, or pushes were used.

## Subsequent policy checkpoint

See [HOST-POLICY.md](HOST-POLICY.md): `authorize` now also requires a last generation callback and enforces a ten-minute monotonic acceptance age; `Channel::open` validates raw JSON before Value allocation. A temporary-only record authority derives service decisions and owns shared device/connection budgets. The original 42-test checkpoint below remains historical; the current total is 59 tests plus three doctests. Rust Ed25519 remains blocked offline.

## Consuming service authorization

`host_accept` now returns a private-field `Accepted`. `device()` exposes immutable sanitized metadata only. No method reveals the reply or channel until `authorize(self, ServiceDecision, still_current)` succeeds. Both success and refusal consume the acceptance; dropping it is also refusal. Compile-fail doctests check reply privacy, channel privacy and inability to authorize twice.

A service constructs an explicit `ServiceDecision::Deny` or `ServiceDecision::Allow` with all observations below. There is no `Default`, `allow_all` constructor or generic success boolean:

| Observation                      | Required check                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_key`                     | Must equal the accepted peer key. Do not reuse a decision for another connection/device.                                                                               |
| `IdentityStatus`                 | Must be `Current`; `Retired` refuses even if cryptography and token match.                                                                                             |
| `StoredDevice`                   | New crypto pairing must still be `New`; known pairing must still be `Known` with the same phone/desktop kind. A removal, kind mismatch or new/known race refuses.      |
| `OwnerApproval`, `DesktopAccess` | Explicit denial always refuses. A new desktop requires `Granted`, and every desktop requires `Enabled` support. Phone pairing does not require desktop owner approval. |
| `Persistence`                    | A new device requires `Committed`; `Failed` always refuses. Known-device seen/name refresh may be best-effort and use `NotRequired`, as Node does.                     |

Only then does the API produce `Authorized { reply, device, channel }`. The service must obtain these observations from the current authoritative record and complete new-device persistence before constructing Allow. It must verify that the connection generation is still current immediately before release. These enums are trusted-service attestations, not proof of database writes or human input: the library cannot detect service code that lies about an external action. No approval dialog, device store, transaction, retirement service or connection-generation registry is implemented here.

`is_known` is called first and `can_pair` is called once even for a known device. Both callbacks must be side-effect-free observations; do not reserve a slot, spend a token or prompt from them. The new Node fixture matrix covers known/new and pairable/closed cases, exact callback order and key arguments, first-pairing results and unknown-phone refusal. Cryptographic acceptance alone is still not authorization.

Decrypted HELLO and ACCEPT must start with a JSON object after JSON whitespace. This prevents serde's positional struct-from-array acceptance. Node and Rust both reject a populated `[token,eph,null,[],"phone"]` HELLO and an authenticated `[eph,peer]` ACCEPT. The HELLO shape rejection happens before callbacks. Unknown object extensions remain allowed; duplicate recognized fields remain rejected.

## Raw frame validation and leases

This is a breaking experimental API change:

- `FrameWriter::write` returns `EncodedFrames`, a non-cloneable owner of the encoded vectors and their memory reservation. It dereferences to a borrowed slice for sending/inspection. There is no owning iterator that silently releases the reservation while transferring buffers.
- `FrameReader::read(encoded, now_ms)` returns `Option<RawFrame>`. `RawFrame::as_bytes` exposes validated UTF-8 JSON without materializing a `Value`. The frame retains its reservation until drop, even if its reader or connection object is dropped first.
- `GlobalBudget::connection` creates a connection handle. Clone that same handle into all readers/writers for one connection. Clone one global pool across connections. `ConnectionBudget::reserve` is also available for service-owned buffers outside the frame module.
- `FrameReader::with_budget(direction, max_bytes, timeout_ms, budget)` sets explicit admission limits. `FrameWriter::with_budget(direction, budget)` shares the same pool. Convenience constructors use a shared process-wide 256 MiB pool, with a fresh 64 MiB connection handle per reader/writer; they cannot infer that separately constructed objects belong to one connection.
- `deadline_ms()` is the absolute first-fragment deadline; `expire(now_ms)` releases partial state and returns true on expiry. Default lifetime is 15 seconds. Schedule it even when no data arrives; `read` also checks it before processing an incoming frame. Later pieces never extend it. On timeout/error the carrier should close. This library runs no timer thread.

Validation first scans raw bytes with no heap allocation, enforcing maximum depth 64 and at most 65,536 lexical tokens (string/container delimiters, punctuation and primitive starts), with a fixed allowance for the outer envelope followed by a separate payload check, then asks serde to validate a borrowed `RawValue`. It never builds array elements, object entries or decoded string values. Fragment envelopes borrow their tag, raw frame and base64 string; tags/base64 must be unescaped JSON strings. Complete fragments are concatenated only under a second reservation, while their pieces remain charged; final validation failure releases both copies. JSON string escapes, lone surrogates, PUA/noncharacter text and numeric lexemes remain raw. Duplicate fields inside an application frame follow the eventual owner's parser; envelope recognized fields are strict.

Reservations cover requested retained payload capacities, output vector metadata, assembly metadata and a fixed bounded formatting-scratch allowance. Global and connection limits are checked before allocation, under shared synchronized counters; failed global admission rolls back the connection reservation. Leases release on success handoff drop, error, reset, expiry and reader drop. They do not transfer into unbudgeted queues. Copies made by callers need their own reservations.

The peer wire limit remains 16 MiB, but raw admission now refuses high-token/deep JSON even if Node could parse it. A large JSON string still fits; a dense multi-million-element array is rejected. This is intentional protection against the prior 16 MiB-to-hundreds-of-MiB `Value` amplification. It is not universal Node JSON compatibility.

The accounting is **not whole-process RSS accounting**. Incoming carrier/decryption buffers, phone assemblers/dispatchers, trusted caller input strings, allocator bookkeeping, budget-handle objects, idle connection counts and the owner's later parsed values are not automatically intercepted. A service must reserve these separately, enforce connection admission, keep the raw lease through owner handoff, and apply its own parsed-object budget before calling `jsjson`. The phone module still has its prior local aggregate limits; it is not automatically attached to this shared pool. No service wiring exists in this checkpoint.

## Evidence and remaining work

The allocation test is a separate one-test binary with an instrumented System allocator; its small unsafe forwarding shim is test-only. The production library still has `#![forbid(unsafe_code)]`. It asserts requested allocation totals rather than claiming an RSS measurement:

| Case                                                              | Assertion                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Writer presented with about 8 MiB of compact array JSON           | Rejects at the token limit with under 16 KiB of allocations, rather than allocating millions of Values.                              |
| Reader presented with 20,001 array elements under the token limit | Allocations stay below raw envelope length plus 16 KiB; largest allocation is no larger than the input.                              |
| Adversarial fragments carrying the dense 8 MiB array              | Rejection allocates below twice the raw size plus 64 KiB, for pieces plus contiguous copy; no Value tree, all reservations released. |
| Envelope with 20,000 fields                                       | Rejects with under 16 KiB allocated.                                                                                                 |

Other safety tests exercise each authorization obligation, the Node callback matrix, positional HELLO/ACCEPT arrays, raw surrogate/PUA/null frames, shared connection/global contention, concurrent reservations, output leases after reader drop, writer rejection without consuming a fragment ID, final-copy budget failure, reset/drop cleanup, exact deadline expiry, drip-fed fragments that cannot extend it, and time overflow. The prior crypto and phone reciprocal checks remain required.

`tests/node-fixtures.mjs` asserts `tweetnacl/package.json` version **1.0.3** (the repository pin), records it with the fixtures, and verifies actual source hashes. An external `NODE_PATH` may supply that exact version only. `cargo test` still checks committed fixtures; run the Node script too to detect production source drift. The extracted Node function bodies and external dependency installation remain trusted test inputs.

The P3 service requirements remain: source/identity admission limits and replay cost controls, pairing-token policy, online token-guessing controls, connection freshness and host lifecycle. Small-order X25519 behavior is unchanged from TweetNaCl/RustCrypto in this checkpoint; no new cryptographic rule was invented. Host proof, LAN/relay lifecycle, HTTP forwarding, actual phone interoperability and the owner's lossless parser integration remain separate work.

## Checks

```sh
cargo test --offline --manifest-path experiments/rust-remote/Cargo.toml --locked
cargo clippy --offline --manifest-path experiments/rust-remote/Cargo.toml --all-targets --locked -- -D warnings
cargo fmt --manifest-path experiments/rust-remote/Cargo.toml --check
cargo build --offline --manifest-path experiments/rust-remote/Cargo.toml --examples --locked
# Set NODE_PATH to an existing trusted node_modules installation if needed; no install is required.
node experiments/rust-remote/tests/node-fixtures.mjs experiments/rust-remote/target/debug/examples/conformance
node experiments/rust-remote/tests/phone-node.mjs experiments/rust-remote/target/debug/examples/phone_conformance
```

Expected: 42 Rust tests plus three compile-fail doctests, both reciprocal Node checks, Clippy and formatting pass. All test keys/messages are synthetic; no endpoint is contacted.
