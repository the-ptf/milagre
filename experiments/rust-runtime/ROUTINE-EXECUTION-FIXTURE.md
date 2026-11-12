# Primary Project Chat schedule execution prototype

`routine-execution-fixture` is default-off. Normal `chat-runtime`, including a
feature-on binary opening a normal root, remains paused-storage-only. A separate
explicit `routine-fixture-create` / `routine-fixture-open` preset captures a private
`routineExecutionFixture:true` manifest field on a synthetic-account/fixed-native
root. Only that captured marker plus the actual fixture configuration activates
the periodic actor driver. Ordinary `fixture-create` stays paused-only too.
No installed app, real account/provider, existing production root or normal binary
is changed by this checkpoint.

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

- Public enable/Run-now behavior and normal-root authority remain unavailable.
  The actor timer exists only in the explicit synthetic preset below.
- Worktree and shared-Link targets, broader current model/account/mode policy,
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
predates the retained-teardown regression. That prototype evidence is manual-driver-only. The later actor preset below
adds timer evidence; no execution RPC or installed scheduling is enabled.


## Explicit actor timer preset

The actor's existing 20 ms coalesced tick advances the scheduler after its normal
owner/provider pump. It never consumes the publisher's notices or creates a timer
thread per Routine. `ConfiguredRoutines` owns either the paused store or the
scheduler's same store; it never starts a second concurrent routine writer.
Committed changes emit at most one `routines:changed` event per tick through the
existing bounded publication queue. Startup recovers interrupted Runs before new
claims. Stop closes claim admission, interrupts exact scheduled turns, and refuses
close as `QUIT_PENDING` until saved terminal settlement. Repeated shutdown after
the host has closed does not try to reopen/read that host.

The explicit create preset seeds one backend-created, past-due, existing-Chat,
Claude/Ask schedule with maxRuns 1. Node's real store-open upkeep retimes missed
slots, so the actual wire acceptance waits for the next wall-clock minute with a
75-second deadline. There is no raw-clock RPC, injected result, or manual driver
call. The fixed native child asserts the literal prompt including the pass hint,
emits a real protocol text delta and result, and waits for real cleanup.
`routine-blocked-fixture-create` is a second explicit synthetic preset whose native
child emits init and waits on stdin. It permits a deterministic active-turn Stop.

The execution flag reports true only on these captured roots. Existing CRUD uses
that one writer. Reads can show active schedules; completed schedules stay hidden
as Node's list does. Public creation still requires enabled:false and enabling
updates/Run-now remain refused. This does not claim a usable scheduling UI.

The wire tests require persisted Acted, exact routine-run context and actual saved
reply, one counted completed Routine, process restart with no redelivery, and native
Quit/profile/socket/Project-lock cleanup. A manifest-revocation branch waits for
an actual timer diagnostic, observes closing admission and unchanged saved bytes,
then restores authority, stops, and reopens a new lifetime. Restoring bytes alone
does not clear the actor's existing publication-failure latch. The active-turn
case waits for real native init before Stop, then requires one saved failed Run.
Normal-root activation is refused before creation or reopen. Existing ordinary
fixture wire checks still require executionSupported:false.

Fresh acceptance passes 137 runtime tests (including both actual actor/native
wire cases), feature-on and normal `chat-runtime` all-target strict Clippy, fmt,
JS lint/format and whitespace checks. Logs:
`/tmp/milagre-routine-actor-full-accepted.log`,
`/tmp/milagre-routine-actor-clippy-final.log`, and
`/tmp/milagre-routine-actor-normal-clippy.log`.

The active Stop regression initially exposed repeated cancellation of a native
generation after its worker ended but before owner settlement. Each captured
scheduled Turn now records one accepted interruption, and the actor's generic
cancellation loop excludes that exact scheduled Turn. Repeated Stop continues
pumping/persisting terminal cleanup without resending cancellation. The original
failure remains in `/tmp/milagre-routine-actor-full.log` and
`/tmp/milagre-routine-actor-stopfix.log`; both actual wire cases pass after the fix
in `/tmp/milagre-routine-actor-stop-idempotent.log` and the full accepted run.

Other initial failed logs are retained: `/tmp/milagre-routine-actor-wire*.log`.
Early harness failures assumed an overdue
slot dispatches immediately (Node upkeep retimes it), polled the completed row from
list (Node hides it), and omitted a native text delta. Corrected checks observe the
real store/timer protocol rather than weakening outcome or no-replay assertions.


### Fenced claim with a later user turn

Recovery-close checks the exact captured scheduled TurnId, not any later activity
in the same Chat. A fenced completed schedule A cannot keep shutdown from reaching
generic cancellation of user turn B. The actor regression queues B during A,
emits a bound native-session init and A terminal, observes B start, then replaces
the routine file with a directory to force a real pre-write FinishRun refusal.
It verifies the first Stop interrupts B while the Project lock and private profile
remain owned; A stays running on disk. After B's actual cancellation terminal,
retry closes normally. Fresh scheduler startup classifies A failed with
`daemon restarted`, and provider turn count remains two. This is deterministic
MockProvider event/binding evidence, not a second native or launcher-EOF probe.

The original Chat-wide active checks fail the test cleanly after teardown:
`/tmp/milagre-routine-actor-successor-mutant.log` records zero interrupts instead
of the required B interrupt. The fixed focused test passes in
`/tmp/milagre-routine-actor-successor.log`. The earlier 137-test acceptance
predates this regression. Fresh acceptance passes 138 runtime tests in
`/tmp/milagre-routine-actor-full-successor.log`, plus feature-on and normal
all-target strict Clippy in `/tmp/milagre-routine-actor-clippy-successor.log`
and `/tmp/milagre-routine-actor-normal-clippy-successor.log`. Formatting,
JS lint/format and whitespace checks also pass.


## Fresh primary Project Chats

The default-off captured synthetic-root scheduler also accepts `new-chat` with
`workspace:"project"` for its exact owned Project. The separate
`routine-new-chat-fixture-create` preset seeds this case; ordinary roots, ordinary
fixture presets, public enable and Run-now remain unchanged. No real provider,
production root, new Worktree, Link, computer, fallback or prompt expansion is
admitted.

The actor passes its actual shared content owner into the scheduler and retains
that same authority across scheduler reopen. Before any fresh Chat creation, the
scheduler compares actual owned session count with that content owner's Chat
limit. This is always-fresh admission, so an empty reusable starter cannot bypass
it. Saturation persists a failed Run with `Configured content Chat admission is
full`, with no new Chat, transcript or provider dispatch. The saturated actor
regression uses the actual configured content limit of 1,024.

Ordering is durable ClaimDue, fresh owner Chat creation and flush, durable
AttachChat of the actual canonical Chat and primary Worktree IDs, owner recheck,
then trusted send. It binds the returned Sent session and exact TurnId. It never
reuses the user's empty starter Chat. Node's actual `routineChats.startChat`,
`ChatHost.emptyChat` and `compactProjectState` are the differential oracle for the
fresh session, origin `{routineId,runId,hidden:true}`, generatedTitle, body and
routine-run context (including `label:"Routine · <name>"`). Existing-Chat context
and provider prompt stay unchanged. New-Chat `at` uses the captured claim time;
this bounded synchronous path does not introduce another caller clock.

Creation/write uncertainty, unsuccessful attachment and dispatch uncertainty
fence the scheduler with the running claim retained. Restoring files does not
clear that fence. Restart recovers the claim as failed with `daemon restarted`
and never creates or sends it again. A Chat created before a failed attachment is
kept as hidden origin evidence, not swept or silently retried. Final run naming,
quiet/archive/unread behavior, fallbacks and Worktree/Link creation remain open.

New evidence:

- The actual fixed-native trusted fixture makes a distinct new Chat, saves its
  named hidden origin, exact context and completed reply, stores the actual Run
  attachment, gracefully reopens and sends nothing again.
- A real routines-file replacement with a directory after Chat creation refuses
  AttachChat before provider dispatch. The saved running claim and hidden empty
  Chat survive; verified restart fails the Run without replay.
- Actual manifest revocation after durable AttachChat and before dispatch
  preserves attached IDs and zero native workers. Verified restart fails without
  sending or creating another Chat.
- The real actor timer uses the explicit new-Chat preset with a <=75-second
  wall-clock deadline, then reads the saved Run and transcript through the real
  socket, reopens without replay and exercises revocation/cleanup. This crosses
  actor publication/content membership and configured provider admission, not
  only the manual scheduler harness.

Logs: `/tmp/milagre-routine-newchat-{actor,native,owner,full,owner-full,owner-final,capacity,final}.log`.
Strict checks: `/tmp/milagre-routine-newchat-{final-clippy,final-normal-clippy,owner-clippy}.log`.
Final acceptance passes 148 runtime checks (including all three actual actor/native
wire cases) and 231 owner checks. Feature-on and normal runtime all-target strict
Clippy, owner strict Clippy, rustfmt, JS oxlint/160-column Prettier and whitespace
checks pass. The initial 147 runtime count predates the capacity regression.
The Node oracle needs the existing checkout dependency directory in `NODE_PATH`.
All runtime builds use `/tmp/milagre-routine-execution-runtime-target`; no installed
Preview or ordinary runtime binary is rebuilt by this fixture increment.

## Saved completion effects checkpoint (source, not installed)

The synthetic scheduler now saves the exact routine divider's `quiet`/`summary`
fields before making the durable Run terminal. Quiet summaries use Node's trimmed
first-line/60-UTF-16-unit title rule (57 units plus ellipsis when longer); the
Run title and its own origin Chat's `generatedTitle` agree. A user title wins.
Quiet origin Chats are archived; existing-Chat targets are not archived. The
owner flushes these effects before the routine store finish transaction. Missing
context, owner/write failure, an active successor, or a successor user message
refuses/fences instead of acknowledging completion; restart retains the existing
no-replay recovery rule. A UTF-16 title cut inside a surrogate pair leaves naming
unset, because this fixture's String wire cannot represent that Node result.

This is saved-state parity only. Node's scheduler synchronously annotates live
terminal events before publication; the current polling fixture cannot claim
that ordering. Node also reverts unread only using actual terminal
`markedUnread` mutation provenance. Rust does not yet retain the provenance plus
protection against intervening user unread changes, so this checkpoint deliberately
leaves unread untouched. Quiet archived Chats may therefore retain an unread flag.
Acted-run naming needs the separate model title service and remains deferred;
these Runs keep their Routine name. Worktree retirement and Link scopes stay out.

Evidence includes actual Node `ChatHost.patchMessageContext`/`nameRunChat`
comparisons (including user-title and JS whitespace cases), actual shared Node
`shortTitle` vectors, and a fixed-native quiet fresh-Chat completion/reopen test.
The initial full-session reopen assertion failed because shutdown removes a
transient `suggestionTurnId`; the corrected test compares saved completion fields,
summary and transcript explicitly. That original failure remains in
`/tmp/milagre-routine-completion-quiet.log`. Compilation failures from initial
message-Arc indexing/private test helper visibility remain separate attempt logs.
No normal app/runtime package, real provider or production root is used.

Final frozen-source validation: 150 runtime checks and 232 owner checks pass.
Strict feature/normal runtime all-target Clippy and feature owner all-target
Clippy pass, as do rustfmt and whitespace checks. Logs:
`/tmp/milagre-routine-completion-{final,owner-final,clippy,normal-clippy,owner-clippy-final}.log`.
The full suites run against the final successor-user refusal guard.
