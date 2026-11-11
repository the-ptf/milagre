# Rust owner wire foundation

This crate implements Milagre's local daemon protocol in Rust and checks it with the **unchanged production Node client and desktop runtime client**. It only binds newly created temporary profiles. Its executable serves synthetic fixture commands, not a Milagre application backend.

There is no connection to the installed daemon, no Project ownership acquisition, no access to existing Chat databases, and no provider execution. The separate [isolated read runtime](../rust-runtime/README.md) now connects this wire layer to `milagre-owner-store` on embedded temporary copies. The Node owner remains required by the Rust desktop. This is stage 2 of [the backend migration plan](../rust-desktop/BACKEND-MIGRATION.md), not a completed backend migration.

## API and ownership boundary

```rust,ignore
let profile = IsolatedProfile::create()?;
let server = Server::bind(profile, Arc::new(my_handler), Config::default())?;
// Connect clients to server.profile_path() using the existing paths.cjs convention.
// Publish state changes through context.events.transaction(...).
server.shutdown()?;
```

`IsolatedProfile` has no constructor from a path and no mutable path access. It creates a private `milagre-rust-wire-*` temporary directory under canonical `/tmp`, independently of `TMPDIR`. The socket name uses the same canonical-profile SHA-256 hash as `apps/daemon/src/paths.cjs`; it is a distinct endpoint under `/tmp/milagre-<uid>/`. That shared directory is validated, never chmodded or removed when it already exists. Binding refuses existing endpoints. Cleanup removes only the inode this instance bound, then drops its own temporary profile.

Background workers acquire `profile.lease()` before the profile moves into `Server::bind`. The cloneable `ProfileLease` keeps the temporary directory alive through worker cleanup, joins and unwinding, even if forced server destruction follows `QUIT_PENDING`. It exposes only the directory path and cannot bind another server. The last profile or lease removes the directory; socket cleanup remains owned by the server. A lease does not claim a successful save or graceful shutdown. Handlers must retain it for every worker that can outlive the server; this is an explicit adapter responsibility.

The public `Handler` trait provides:

- `methods()` and `invoke(method, args, context)` for explicitly registered services. There is no unrestricted command forwarding.
- `snapshot(context)` for an object representing one consistent handler state. This method is required; the wire layer supplies its `eventSeq` watermark.
- `decode_request(bytes)`, `encode_request_id(value)` and `string_len(text)` pair the incoming representation with echoed IDs and UTF-16 limits. Default handlers use serde Unicode. The runtime opts into its owner lossless JSON decoder; wire rejects nesting beyond 128 levels before invoking it.
- `encode_result(value)` for domain JSON serialization, including JavaScript lone-surrogate escapes. Ordinary results, snapshot captures and event payloads use it; page fragments bypass it because they are already serialized text.
- `view_changed(context)`, `disconnected(client_id)` and `shutdown()` lifecycle hooks. `disconnected` must not block, publish events or reenter the server. Resources that need draining belong in `shutdown`.
- `shutdown_attempt()` returns a typed `ShutdownError`. Its default maps every legacy shutdown error to `Incomplete`, which keeps admission closed for a later stop retry. An owner may return `Refused` only when that exact attempt left it running and normal admission is safe. The wire reopens admission only for this explicit refusal; save failures, pending cleanup and ambiguous errors remain closed.

Once the owner confirms shutdown, the server marks itself stopped before sending the acknowledgement or stopping event. A disconnected caller or event-encoding failure still closes clients and allows profile cleanup. The initiating call can receive a delivery error even though the owner has stopped. Both deliveries are attempted; if both fail, only the first error is returned. A repeated stop never calls the stopped owner again.

`ClientContext` supplies a generated connection ID, its own `ClientView`, connection status and an `EventSink`. Request arguments never choose the acting client. View state tracks the selected Project or Link, Chat and focus. A Project switch on one socket cannot change another socket's view. Disconnect discards that socket's view and page captures.

For a state mutation, use `context.events.transaction(|publication| { ... })`, acquire the handler's state lock **inside** that closure, mutate, and call `publication.emit(...)`. Snapshot holds the same publication lock while reading the handler and capturing its watermark. A handler that mutates independently of this boundary can produce inconsistent snapshots; this crate cannot make unrelated store writes atomic for it.

The separate `rust-runtime` adapter accepts embedded fixture copies only and maps specific read methods to `ProjectReader`. Production profile binding, owner locks and persisted mutations require a separate ownership cutover under ADR-0003. Do not add an arbitrary profile-path constructor to bypass that work.

## Protocol implemented

| Contract                | Implementation                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Socket admission        | Private 0700 profile/socket directory, 0600 socket, same-UID peer credentials (`getpeereid` on macOS/BSD, `SO_PEERCRED` on Linux)                                                                |
| Handshake/status        | Protocol v1 `daemon:status`, methods and truthful capabilities; the local production protocol has no unsolicited hello frame                                                                     |
| Optional authentication | Production two-step mutual HMAC-SHA256 handshake, fresh client/server nonces, constant-time verification, private temporary token, authentication deadline and 32 unauthenticated peers          |
| Framing                 | Newline-delimited UTF-8 JSON; 16 MiB default frame bound; positive JS-safe integer or <=128 UTF-16-unit string IDs; bounded method names and array arguments                                     |
| Multiplexing            | 32 in-flight requests per client, 256 globally; out-of-order replies, duplicate-ID rejection, structured errors, no automatic command replay                                                     |
| Paging                  | Numeric connection-owned page IDs, sequential reads, result and snapshot page methods, per-connection byte/capture budgets, expiration and release after the last page                           |
| Events                  | Monotonic sequence, production `{"v":1,"event":...}` prefix, oversized state omission with `stateTooLarge`, snapshot watermark under the publication lock                                        |
| Views                   | `daemon:focus`, `chat:set-open`, successful Project/Link selection tracking, connection-local `project:current` routing                                                                          |
| Shutdown                | Stop admission, drain accepted commands, run the handler's shutdown, acknowledge stop, emit `daemon:stopping`, flush/close clients; failed shutdown retains the listener for explicit stop retry |

The only advertised capabilities are `result-pages-v1` and `snapshot-pages-v1`. It deliberately does not advertise `desktop-v1`, `computer-management-v1`, state patches, lean Chat pages or provider support. A normal installed desktop must not discover this fixture as its production owner.

Output is bounded by both a 64-frame queue and twice the configured frame size per client. A stalled reader is disconnected. Pages expire after 30 seconds without a read by default; a sweep also releases idle captures. There are at most 32 captures, 1024 pages per capture, and 128 MiB of retained page text per connection. There are 64 clients by default, configurable up to 128. These are protective foundation limits, not performance tuning results.

## Verification

```sh
cargo test --manifest-path experiments/rust-owner-wire/Cargo.toml
cargo clippy --manifest-path experiments/rust-owner-wire/Cargo.toml --all-targets -- -D warnings
node --check experiments/rust-owner-wire/tests/node-compat.cjs
```

Cargo runs seven Rust unit checks and one Node interoperability suite. Node is required, along with this repository's production module dependencies. The suite launches the fixture executable twice, each with a fresh profile, and removes both profiles/endpoints afterward. It uses the real `apps/daemon/src/client.cjs`, `runtime-client.cjs`, `protocol.cjs`, `paths.cjs` and `local-auth.cjs`.

The Node suite exercises ordinary and structured-error replies, 70 queued client calls, a held call answered out of order, Unicode/escape-heavy paging, lone-surrogate output through the domain serializer (inline/results/events/snapshots), connection-scoped captures, wrong page order, numeric result/snapshot IDs, ID reuse, duplicate IDs, 33 simultaneous requests, malformed and oversized frames, event sequence/watermark, omitted-state hydration, independent views, lost-acknowledgement no-replay behavior, reconnect restoring Project/Link/Chat/focus, mutual authentication, nonce replay rejection, pre-authentication event suppression, authentication deadline and accepted-command shutdown draining. Unit checks cover frame/ID bounds, page expiration/budgets, refusing existing endpoints, preserving a replaced endpoint, failed-shutdown retry and stalled-reader backpressure.

This evidence covers wire interoperability with a synthetic in-memory handler on macOS. It is not evidence of migrated Chat execution, persistent state parity, a working Rust desktop connected to this server, or performance improvement.

## Remaining gaps and deliberate differences

1. **No production owner.** There are no Project locks, registries, stores, providers, terminal processes, Git operations, account services, mobile/peer transports, update management or startup supervision. A handler that writes real data would need to implement and prove those contracts first.
2. **No Windows transport.** The HMAC exchange is tested on a Unix socket. Named pipes, Windows ACLs and process/lifecycle handling are not ported. Linux peer-credential code exists but this run validates macOS only.
3. **No state patches or lean projections.** Whole states and oversized-state rereads work. `daemon:state-patches`, epochs/versioned state, `state:read`, transcript tails and archived-subagent summaries belong to later services and are not advertised.
4. **Paging bounds differ.** Rust splits at UTF-8 character boundaries rather than JavaScript UTF-16 slices; joined JSON is equivalent, but page counts need not match. It enforces byte and page-count bounds and returns `PAGES_BUSY` immediately when retained captures fill the budget. Node waits for capture slots and permits a single result larger than its ordinary budget. The default serde request decoder rejects incoming unpaired surrogate escapes; the actual `rust-runtime` adapter supplies a lossless decoder and paired ID/length hooks. Its real Node-client tests prove input/output compatibility for lone UTF-16 units, real marker characters and PUA values. Wire imposes a 128-level nesting bound before either decoder.
5. **Foundation lifecycle limits.** Each accepted handler runs on a bounded set of request threads rather than an async service runtime. The shutdown timeout bounds accepted-command draining, not an arbitrary blocking `Handler::shutdown`. Dropping the server after a failed drain closes sockets but cannot forcibly cancel arbitrary handler threads. No production data should be attached until cancellation, service cleanup and ownership release are designed together.

Direct dependencies are `serde_json` (ordered objects), `sha2`, `hmac`, `hex`, `rand`, `libc` and `tempfile`. Exact versions are in this crate's `Cargo.lock`; it does not add dependencies to the desktop or the owner storage crate.

## Executable teardown

A fixture executable whose EOF task holds an `Arc<Server>` should finish with `Server::finish(server)` instead of calling `shutdown` and immediately returning from `main`. `finish` first performs normal shutdown, consumes remaining executable Arc owners, then waits for the fresh profile's own destructor. The configured shutdown timeout bounds that wait. It never deletes a supplied path or steals a lock. Polling `is_stopped()` and dropping the server is insufficient: the stopped flag precedes notification delivery. `finish` waits through the shutdown lock so the acknowledgement is not cut short. This also prevents background stop/EOF references from skipping temporary-profile cleanup when the process exits. A unit test deliberately retains both a Server reference and an internal request-owner reference and verifies that finish waits for actual removal.

## Pure state-patch foundation (not advertised)

`state_patch::diff(previous, next, Limits)` generates the production `v`, `o`/`d`, and `a`/`s` patch shapes. It preserves JavaScript integer-key enumeration, double-number equality, depth replacement and the greater-than-eight/majority array replacement rule. Structurally unchanged cloned subtrees are omitted; JavaScript's identity-based generator may emit empty patches for those clones. No patch is `None`, distinct from replacing a value with JSON null.

Input traversal is limited to 128 levels, a shared node count and a logical byte charge for both borrowed trees. The default is 262,144 nodes and 32 MiB of charged value/key/text data. This is not an RSS measurement or a budget for caller-owned allocations. Patch recursion defaults to four levels (maximum 64). A borrowed patch plan is measured through a non-allocating serde JSON writer, default 8 MiB, before replacement payloads are copied into the result. Plan metadata and integer-index strings remain bounded by admitted input, not by that smaller output limit. A separate allocation regression rejects a 2 MiB replacement under a 64-byte output cap without allocating 64 KiB. This is a targeted regression, not a total heap bound. A domain serializer such as jsjson can expand output further; the publishing layer must still enforce its own actual encoded-frame limit.

An invalid limit, exceeded input/output budget, or `__proto__` object key returns an explicit error. The latter is refused because the current JavaScript reducer assigns object keys, which invokes that legacy setter. A future caller must select whole-state resync on refusal, never report an empty successful patch. Inputs are already-decoded domain values; this helper neither decodes nor re-encodes sentinel strings, and it cannot recover lone surrogates rejected earlier by a serde request decoder.

A Rust integration test feeds generated patches to the actual production `diffState` and `applyStatePatch` in Node. It compares exact patches after sharing unchanged subtrees, checks both independently cloned Node and Rust patches against the target, compares recursive applied key order against the shared-state Node result, and verifies the prior state was not mutated. The 3,600 synthetic cases include array shrink/reorder/thresholds, changed/deleted object fields, nested state, scalars, integer-key order, Unicode and JavaScript numeric rounding. Another 924 cases use consecutive run-state projections from all 231 steps of the actual Node ChatHost trace runner at four patch depths. That runner uses scripted providers and fresh temporary Projects; this is not live-provider or complete persisted-state coverage. Bounds and prototype-key refusal have separate tests.

This adds no `state-patches-v1` capability, negotiation command, per-client base/epoch/version state, lean projections, publication caching or wire path. Those remain required before production clients may receive these patches. The existing server still sends whole states and truthful paging-only capabilities. No runtime performance claim follows from the pure helper.
