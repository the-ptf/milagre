# Steering and handoff inventory (not ported)

What `agents/chat-host.cjs` does for steering and provider handoffs, what the Rust owner already has, and what each
needs before its gate can go. Both stay explicit gates in `ChatHost::send` until then.

## Steering: a message into a running turn

**Node.** `sendMessage` with a run (or a handoff still preparing) is a steer when the running provider can steer
(Claude, Codex) and none of these hold: `delivery: "queue"`, a compaction request or one in progress, a wake's
escalation turn (`wakeTurns`), a Send-now pick being started, a queued message started without `steerQueued`.

1. The message keeps the running turn's provider and model (`runProvider`, `runModel`), whatever was asked for.
2. It is saved and flushed before anything else; tokens keep streaming meanwhile.
3. `message-sent` with a run splits the reply so far into its own message (`splitRunForSteer`) and marks the run
   `steered`; the first text after it, before the agent goes back to its tools, becomes its own reply (the
   `step-started` split).
4. `startTurn` is called again for the Chat; SessionManager steers the live session and resolves `{ steered: true }`.
   A rejection folds `turn-failed`, which ends the whole running turn.
5. Pending questions are dismissed by the session when a steering message arrives (adapter side).
6. Send now (`sendQueuedNow`) steers a queued message when `canSteerQueued` (run, no handoff preparing, nothing
   starting, no wake turn, provider steers, last user message not a compaction); otherwise it marks it to start next and
   interrupts.
7. A person's message steered into a Routine's turn takes the turn over (`routineTurns`).

**Rust owner today.**

- Fold side ported and traced: `split_run_for_steer`, the `steered` flag, the `step-started` split.
- Admission and save ported behind `SteeringMode` (default `Gated`: production refuses every steer). With
  `SteeringMode::Recorded` (conformance only) a steer is admitted into the running turn only (its generation), never
  while quitting or closing. It keeps the running turn's provider and model, skips the handoff check and the start
  bookkeeping, is saved and flushed, and `message-sent` splits the reply so far above it. Then
  `Notice::SteerRequested { chat, turn, request }` carries exactly what Node hands SessionManager.startTurn. No provider
  is called and nothing settles it. Trace `claude-steering-save` (Node's real ChatHost, its mocked SessionManager
  answering `{ steered: true }`) covers: a steer with finished and running steps, another provider and model asked,
  a duplicate, the first text after the steer split as its own reply, a steer with nothing new to split, and a queued
  send during the turn. All of it matches step for step.
- Still gated: Send now into a turn that can steer (`sendQueuedNow`'s `steerQueued` path), and any steer in
  production.

**Proposed Provider API (not implemented: agree before the Provider shape changes).**

```rust
pub struct SteerId(pub u64); // host-assigned, one per steering message

// Enqueue only. Err: refused at once (no live session for that turn); nothing was handed over.
fn steer(&mut self, chat: &str, turn: TurnId, steer: SteerId, request: &Value) -> Result<(), ProviderError>;

ProviderEvent::Steered { chat, turn, steer, result }        // the running turn took it: { turnId: <native>, steered: true }
ProviderEvent::SteerFailed { chat, turn, steer, failure }   // exactly one of these two per SteerId
enum SteerFailure { TurnEnded, Failed(ProviderError) }
```

- **Logical turn and native turns.** One host `TurnId` per run, from its `start_turn` to its single terminal event.
  - A provider whose steer opens native turns inside the run maps each of them to the run's host `TurnId`, and emits
    only one terminal: the native end after the last accepted steer. Claude may emit a result per user message, and
    those intermediate results are not turn ends.
  - A native turn that begins after the host turn's terminal is never mapped to it. It is an agent-started turn and
    stays gated.
  - The adapter proves the mapping by settling every steer of a turn before emitting that turn's terminal. The host
    drops any `Steered`/`SteerFailed` that doesn't name the running turn and a pending `SteerId`.
- **No optimistic success.** The sender's reply waits for `Steered` (as for answers, a `SteerTicket::Pending`), with a
  deadline (`steer_grace_ms`); no settlement in time counts as `Failed`.
- **`TurnEnded`.** The native turn ended before the message reached it. The message is already saved and split. The
  host starts it as a new turn (a new `TurnId`) once the end is folded, as Node's SessionManager does with an idle
  session, unless quitting or closing (then it stays saved and the sender hears `null`). A turn end folded while
  steers are pending settles them `TurnEnded` too.
- **`Failed(error)`.** Node folds `turn-failed` for the Chat, ending the running turn. **Decision needed:** keep that
  parity (recommended first: the reply so far is saved), or refuse only the message.
- **Admission (cancellable).** Only into the active turn; never while quitting or closing, into a wake or escalation
  turn (Codex roles are immutable per session, `POLICY-CONTRACT.md`) or while a compaction is pending. Stop or a forced
  end settles pending steers `TurnEnded` without starting them.

## Handoffs: switch and restore

**Node.** `handoffKind(state, session, provider)` (`shared/handoff.mjs`):

- `switch`: the Chat's last turn ran on another provider (the last effective divider's target, else
  `session.provider`).
- `restore`: same provider, the Chat has a completed reply, and no `native_session_id` (a resume that failed).

Steps for a send that hands off (never for a steer):

1. A switch waits for the Chat's background work (`processWork`), refusing while it runs.
2. Staged in one save: a divider message (`context: { kind: "handoff", status: "preparing", from, to, catchUp? }`)
   just before the user message, and for a switch `applySwitch`: the left provider's native session is parked in
   `native_sessions[from]` and the entered provider's parked one becomes `native_session_id` (the `resumeId`).
3. `prepareHandoff` (cancellable through an AbortController, `preparing` map):
   - writes the transcript (`renderTranscript` -> `handover.cjs writeTranscript`, a file inside the Project);
   - asks a model for a brief (`handoverTools.brief`, a separate provider call with its own timeout), raced against the
     abort;
   - marks the divider `done` with `brief` and `transcriptPath`.
4. The turn starts with `framedBrief(brief)` ahead of the prompt (`catchUpStart` limits the transcript to what the
   provider hasn't read).
5. Failure or Stop: `abandonHandoff` -> `failHandoff` marks the divider `failed` and `revertSwitch` undoes the session
   change, so the next send hands off again. `cancelHandoff` is Stop's path while the brief is written.
6. A send during preparation waits for it (`waitFor`) and then steers into the started turn, or cancels its own run if
   the handoff never started.
7. Startup: `recoverHandoffs` fails every divider still `preparing` (the summary's `openHandoff` finds them).

**Rust owner today.** `send` computes the handoff kind and refuses both (`handoff`, `handoff restore` gates). Divider
messages already round-trip through storage and reads.

**Needed.**

- Formatting: ported and checked against Node (`src/handover.rs`, `tests/handover.rs`).
- Content writes: Node writes the transcript to `<dataDir>/handovers`, outside the Project; the owner writes it only
  inside its Isolation, after path checks. Lifecycle and the brief model API: `HANDOFF-PROPOSAL.md`.
- A brief job: a nonblocking provider (or model) call with cancel, settling as an event (`BriefReady` / `BriefFailed`),
  bounded by a deadline like answers.
- Session state: `native_sessions` parking (`applySwitch`, `revertSwitch`), divider patches (`updateDivider`,
  `patchMessageContext`), `catchUpStart`.
- Lifecycle: a `preparing` map in the busy set, Stop and forced close abandoning it, startup recovery.
- Steering first (step 6 steers into the handed-off turn).
- Traces: switch, restore, brief failure, Stop while preparing, send during preparation, recovery after a crash.

## Suggested order

1. Steering (provider `steer`, admission, traces): smallest, and handoffs depend on it.
2. Restore (same provider: no `native_sessions` parking).
3. Switch (parking, background-work refusal, catch-up).
