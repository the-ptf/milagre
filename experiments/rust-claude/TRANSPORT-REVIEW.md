# Transport review follow-up (2026-11-10)

Three findings from the Sonnet Claude transport review, addressed independently of the session port:

- `close()` and `kill()` close handler admission and fire `CancelReason::Closed` before stdin EOF.
  Late callback replies, including a reply already queued when close starts, are discarded. Failure
  handling serializes with the close transition so a late reply cannot SIGKILL the CLI during its
  session-file flush grace. `end_input()` remains the lower-level EOF operation; losing a required
  reply after it is still fatal (`ReplyLost`).
- A write/flush error while the process is alive now kills its group and reports
  `ExitReason::WriteError(String)`. An accepted control frame or handler reply cannot vanish into a
  dead writer while leaving the CLI running indefinitely. All control waiters settle through exit.
  Errors after an explicit close do not cut short its flush grace.
- `connect()` now bounds its additional initialization buffer with
  `Limits::max_initialize_events` (default 1024) and `Limits::max_initialize_bytes` (default 8 MiB).
  The byte count covers serialized event payloads without allocating another frame-sized buffer.
  Exceeding either limit kills the process and returns `ClientError::InitializeBufferFull`.
  The transport event channel and per-frame limits still apply independently. Events within budget
  retain their original order; no event is silently dropped to make initialization succeed.

Regression coverage in `tests/client.rs`:

1. Close with a pending permission, a delayed callback reply and another request after EOF: early
   cancellation, no new handler, successful simulated flush, exit 0 without a signal.
2. CLI closes its stdin but keeps stdout and the process alive: both an outbound control with no
   timeout and an inbound permission reply produce `WriteError`, reap the process and reject later
   sends.
3. Initialize floods output without replying: independent event-count and byte-budget failures
   finish before the initialize timeout. The existing successful pre-initialize buffer test stays.

Only the scripted fake CLI is used. No real turn, credentials, live owner, profile write or push.
