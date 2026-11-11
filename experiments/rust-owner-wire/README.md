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

The public `Handler` trait provides:

- `methods()` and `invoke(method, args, context)` for explicitly registered services. There is no unrestricted command forwarding.
- `snapshot(context)` for an object representing one consistent handler state. This method is required; the wire layer supplies its `eventSeq` watermark.
- `decode_request(bytes)`, `encode_request_id(value)` and `string_len(text)` pair the incoming representation with echoed IDs and UTF-16 limits. Default handlers use serde Unicode. The runtime opts into its owner lossless JSON decoder; wire rejects nesting beyond 128 levels before invoking it.
- `encode_result(value)` for domain JSON serialization, including JavaScript lone-surrogate escapes. Ordinary results, snapshot captures and event payloads use it; page fragments bypass it because they are already serialized text.
- `view_changed(context)`, `disconnected(client_id)` and `shutdown()` lifecycle hooks. `disconnected` must not block, publish events or reenter the server. Resources that need draining belong in `shutdown`.

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

A fixture executable whose EOF task holds an `Arc<Server>` should finish with `Server::finish(server)` instead of calling `shutdown` and immediately returning from `main`. `finish` first performs normal shutdown, consumes remaining executable Arc owners, then waits for the fresh profile's own destructor. The configured shutdown timeout bounds that wait. It never deletes a supplied path or steals a lock. This prevents background stop/EOF references from skipping temporary-profile cleanup when the process exits. A unit test deliberately retains both a Server reference and an internal request-owner reference and verifies that finish waits for actual removal.
