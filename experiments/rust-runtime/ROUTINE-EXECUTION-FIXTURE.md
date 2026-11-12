# Existing-Chat schedule execution prototype

`routine-execution-fixture` is default-off. The runtime composition is additionally
`cfg(test)`: enabling it on an executable installs no actor timer, execution RPC
or scheduling capability. Normal `chat-runtime` remains paused-storage-only, with
unchanged routine methods and `executionSupported:false`. Nothing here updates
an installed app or executes a real provider.

The feature enables a separate fixture-only owner entrypoint. It derives the
message, prompt and routine-run context from the complete durable `{routine,run}`
claim supplied internally. Ordinary `ChatHost::send` still refuses routine
contexts and `canStart`; no wire caller selects trusted admission. A private
typed admission selects the exception instead of stripping context or taking a
caller-provided readiness boolean. Busy, pre-admission refusal and dispatch error
are distinct typed results. An uncertain dispatch fences the scheduler with the
durable claim retained; it is never retried.

## Scope and lifecycle

1. A fixture owns a real dedicated `DataRoot`, its actual root ownership
   check, one `RoutineStore` writer and one `ChatHost` using the captured fixed
   native Claude executable, pinned synthetic account selection and model. The
   fixture never reports authentication readiness. Startup runs `RecoverInterrupted`
   once before claims. Running rows from an earlier lifetime become failed with
   `daemon restarted`, without starting another native turn.
2. An explicit deterministic tick first processes actual owner/provider events,
   finishes saved terminals, then persists `ExpireDue` and `ClaimDue`. The native
   send follows a successful persisted claim. Only existing primary Project Chats
   on captured Claude/model/Ask are admitted. Archived/foreign/missing/shared or
   mismatched Worktrees and different saved providers/models refuse before saving
   a message. Noncanonical keys such as `#01` and `#0001` refuse before busy
   lookup, so they cannot bypass a canonical `#1` run. Busy Chats produce a persisted `skipped-busy` Run, without queueing
   or steering a message into the user's turn.
3. Pending work is bounded by the store's 64-routine limit and binds the actual
   `Sent.turn` plus persisted routine-run context. The kept assistant terminal
   after that exact divider is flushed through the owner before `FinishRun`.
   Completed replies become `acted` or `quiet`; cancellation/failure becomes
   `failed`. The quiet parser is compared with Node's production `parsePass`.
   A summary requiring an unpaired UTF-16 surrogate refuses rather than replacing
   its bytes at the ordinary-Unicode durable boundary.
4. Stop disables new claims before interrupting the exact pending owner turns.
   The writer cannot normally close until real terminal settlement has finished.
   Real owner/store failures fence subsequent ticks, even if the manifest is
   restored. Explicit verified close/restart can reconcile a retained running
   row without fabricating a successful finish or replaying its launch. Fixture
   teardown retains the actual host/store plus data-root and outer-profile leases
   on any failed store close, owner save/shutdown or native drain, even when native
   workers already reached zero. Only exact-root explicit recovery after repair
   releases that parked owner; the same dirty host retries its original save.

## Evidence

Nine fixture tests cover an actual native due turn, durable context/reply/Run,
graceful reopen without replay, busy/no-queue, cancellation after a real native
init frame, expiration, a quiet native reply, a durable claim without dispatch
recovered in another lifetime, and actual manifest revocation before claim and
after native completion but before finish. The last case preserves the completed
Chat reply while the Run stays running on disk, then restart conservatively marks
that Run failed without sending again. Seven quiet-classification vectors come
from the actual production Node parser. Actual failed-close and failed-save
regressions prove retained ownership/profile with native workers already drained,
then successful repair/save using that retained owner. Two owner tests cover
default gates, pre-write busy and alias refusal, exact saved context and
current-state target refusals.

The fixture's first cancellation test originally interrupted before native init
and observed a start failure instead of cancellation. The accepted test waits
for the actual child's init frame and asserts a captured native PID before Stop.
This is not a timing sleep or a relaxed outcome assertion.

```sh
CARGO_TARGET_DIR=/tmp/milagre-routine-execution-runtime-target cargo build --manifest-path experiments/rust-runtime/Cargo.toml --locked --offline --features routine-execution-fixture --bin runtime-fake-claude
NODE_PATH=/explicit/main-checkout/node_modules CARGO_TARGET_DIR=/tmp/milagre-routine-execution-runtime-target cargo test --manifest-path experiments/rust-runtime/Cargo.toml --locked --offline --features routine-execution-fixture
```

Logs: `/tmp/milagre-routine-execution-{owner,owner-full,owner-clippy,runtime,runtime-full,runtime-clippy}.log`.

## Still required

- Actor timer/public capability integration, bounded execution notifications and
  approved enable/Run-now behavior. The installed paused feature is unchanged.
- New Chats, Worktrees, shared Links, broader current model/account/mode policy,
  fallbacks, prompt placeholders/timezone rendering and background work.
- Quiet divider/unread updates and naming, plus broader Node scheduler traces.
- Killed-runtime/process-crash tests and real-provider/application evidence.
  These tests cover graceful restarts and real owner faults, not hardware
  durability, production data adoption, live credentials or phone compatibility.


Final review closes both prototype P2s: noncanonical Chat keys are rejected before
busy checks/send, and any failed close/owner shutdown/native drain retains the
actual fixture root/profile and owners. Regressions fail under the old alias and
teardown behaviors. Saved full runs pass 134 runtime tests and 228 owner tests;
root's focused rerun passes all nine prototype cases. The earlier 133 count
predates the retained-teardown regression. Evidence remains test-only; there is
no actor timer, execution RPC or installed scheduling.
