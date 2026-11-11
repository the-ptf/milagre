# Rust ACP process/protocol checkpoint

Standalone `milagre-acp`, additive to the existing provider crates. This is a process and wire
foundation for Kiro and Antigravity, not a runtime provider adapter or a completed `AcpSession`
port. No proprietary SDK code is included. The transport design and generic regression cases
are adapted from this repository's Rust Codex checkpoint; that crate is neither modified nor a
dependency. Vendor behavior comes from the repository-owned Node ACP sources.

## Implemented boundary

- `AcpRpc`: JSON-RPC 2.0 newline framing, bidirectional requests/responses, raw notifications,
  stdout/stderr line events, bounded diagnostics and one terminal exit event. String and numeric
  request IDs stay distinct. `serde_json` arbitrary precision retains numeric digits without
  float conversion; exponent spelling may normalize. Outgoing integer IDs stay below the JS
  exact-integer limit, are never reused and never wrap. No replay or process restart.
- `AcpClient`: initialize with ACP v1 and host filesystem/terminal capabilities disabled;
  explicit authenticate/new/resume/load/prompt/cancel/config/mode calls. Initialize and session
  requests use Node's 120 seconds, config/mode 15 seconds, raw RPC 30 seconds. Prompt waits for
  its response. Authenticate requires an explicit finite timeout. Results and updates retain
  vendor/unknown fields. No automatic authentication, retry, MCP reduction or session fallback.
- `permission_outcome`: pure Node `pickOption`/`outcome` mapping, including once-only selection.
  This selects an option after authorization; it does not authorize commands, files or tools.
  Only methods explicitly listed in `SpawnOptions::owned_server_methods` reach the caller.
  The default owns none: unsupported requests receive `-32601` through the bounded writer.
  A permission consumer must explicitly claim `session/request_permission` and settle pending
  requests when a turn stops. Owning a method does not authorize its actions.
- `launch`: pure Kiro ACP argument constants and Antigravity environment scrubbing/default
  argument shaping. No executable discovery, installs, account probes, browser or filesystem
  operations. The owner supplies the exact harness, profile, temporary directory and environment.

`AcpRpc::spawn(SpawnOptions)` returns the handle and an event receiver; `AcpClient::connect`
returns client, initialize result and receiver. Drain events while waiting for prompts. Process
errors preserve JSON-RPC code/message/data; only `RpcError::Server` means the agent answered
with a rejection. Transports never turn timeouts or crashes into automatic fallback.

## Bounds, cancellation and cleanup

| Resource             | Default bound / behavior                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Input/output frame   | 8 MiB, excluding newline                                                                                         |
| JSON structure       | 65,536 conservative lexical tokens before allocation; serde depth limit remains enabled                          |
| IDs and method names | 4,096 serialized bytes per ID, 4,096 UTF-8 bytes per method                                                      |
| Client requests      | 64 in flight                                                                                                     |
| Open server requests | 1,024, including answers being written                                                                           |
| Writer               | 128 frames and 16 MiB, including the current write; immediate `WriterFull` on saturation                         |
| Event queue          | 4,096 events and 16 MiB of conservative retained-allocation charges; overflow or receiver loss stops the process |
| stderr               | 8,000-byte tail; each line also has the frame cap and event budget                                               |
| Transport tasks      | Four fixed tasks: supervisor, stdout reader, stderr reader, writer; no task per request                          |

These bound owned buffers and work, not total application RSS. Every queued parsed tree is charged, including both full raw frames and cloned params, string
capacities, vector capacity and conservative per-node/map overhead. No mapper metadata is removed.
The reader temporarily holds one bounded parsed frame and classification copy; pending results
have a separate request-count bound. Callers can retain events or create their own tasks.
Zero/tighter limits fail closed. Extremely large writer limits are clamped to semaphore limits.
An exact final exit event may exceed the event count budget by one.

Only the writer touches stdin. Dropping or timing out a queued request removes its ID and skips
its frame if writing has not begun. A partially written frame finishes intact; stalled writes
kill the process instead of corrupting later frames. Notifications accepted into the writer
queue may complete after the caller stops waiting. Responses to unknown/already claimed IDs
fail; duplicate incoming IDs while unanswered/in-flight are protocol violations. A full writer
leaves an unsent permission response retryable. Dropping a response future once claimed stops
the process, because delivery may already have begun. Delivery is **uncertain** after cancellation
or write failure: a complete permission reply may already have reached the peer and authorized a
tool. Process kill cannot retract that reply or prove non-execution. A successful response means
the pipe write completed, not provider acknowledgement. Never replay an uncertain answer.

Client prompts serialize. Dropping a prompt future kills the process rather than leaving an
unowned turn. `cancel` only writes the ACP notification. `cancel_and_wait` additionally waits
within a caller-specified grace, excludes another prompt during cancellation and kills on error,
timeout or cancellation of its own future. The caller must still drain and settle permission
requests; no host policy is implemented here. Direct raw RPC access bypasses client prompt
serialization and is a trusted-host escape hatch, never a renderer/agent API.

Unix children lead their own process group. Close/drop/pipe failures stop that group and reap
the leader; natural leader exit also kills remaining same-group children. Close signals without
waiting behind a blocked stdin write. Reader tasks are joined or aborted before the final event.
A child that escapes the process group is **not** tracked. Windows currently kills only the child;
there is no Job object or `.cmd` launcher support. Antigravity's harness can create separate
command groups, so this checkpoint is insufficient for real Antigravity process-tree cleanup.

## Launch privacy and intentional Node differences

`SpawnOptions::new` uses an empty environment and no vendor arguments. `env(...)` replaces the
entire environment; assigning `None` explicitly opts into ambient inheritance. Debug output
redacts command, arguments, cwd and environment values. No profiles or temporary directories
are created by this crate. Environment scrubbing does not establish private directory permissions
or a sandbox; the owner must choose and enforce those paths before any real launch.

Node `AcpRpc` accepts absent/unknown `jsonrpc` versions and null request IDs as notifications;
this transport retains that envelope compatibility. The client separately checks the negotiated
ACP protocol version. Invalid boolean/object/array IDs, duplicate unanswered IDs, oversized
headers, JSON complexity, queue overflow and abandoned answers fail closed instead of preserving
Node's permissive/unbounded behavior. Fractional/exponent IDs retain numeric value/type. Equivalent numbers such as `1`, `1.0` and
`1e0` share identity without float conversion; string `"1"` remains distinct. Exponents outside
an i64 normalization range are explicitly refused. No zero-filled expansion is allocated.

Node forwards non-JSON/scalar stdout lines, ignores unrecognized objects/arrays and passes all
nonblank stderr lines. Rust follows that distinction, bounded by the limits above. Line events,
raw payloads and exit details can contain sign-in URLs or secrets printed by a child; they are
sensitive diagnostic data, not sanitized user transcript text. Nothing opens a URL. The default
exit label is `ACP agent`, rather than Node's caller-provided vendor name. stderr retention is
bytes rather than Node's UTF-16-unit tail. Malformed permission options without string IDs
produce cancellation rather than a malformed selected outcome.

## Validation

```text
cargo test --offline --manifest-path experiments/rust-acp/Cargo.toml
cargo clippy --offline --manifest-path experiments/rust-acp/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/rust-acp/Cargo.toml --check
node experiments/rust-acp/scripts/record-traces.cjs --check
```

This checkpoint passes 50 Rust tests. The recorder executes repository Node ACP helpers and fake agents only. It captures 11 outgoing
frames, 12 envelope cases, 128 permission outcomes, 3 environment cases and 10 full fake-session
traces (including Kiro tool shapes, load history, edits, questions, thought chunks and plans).
Checkout-root path prefixes alone normalize to `/fixture`; source hashes detect drift. Rust
replays the raw session events and response shapes, not their eventual Milagre UI mapping.
Node is required for those tests; they do not silently skip.

Rust fault-injection tests cover out-of-order answers, timeouts/late replies, mixed and large IDs,
partial frames, queue and parse budgets, stderr floods, EOF, closed stdin, child/grandchild
cleanup, cancellation during initialization/prompt/reply, response retry after writer saturation
and exact bytes after mid-write timeout. Tests never launch Kiro/Antigravity, use a real account,
read a profile or connect to an MCP endpoint. URI strings in fixtures are inert test data.

See [INTEGRATION-GAPS.md](INTEGRATION-GAPS.md) before proposing runtime wiring.
