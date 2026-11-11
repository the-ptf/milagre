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

**Rust owner today.** `split_run_for_steer`, the `steered` flag and the `step-started` split are ported and traced
(the fold side). The send path refuses a steer with the "Steering a running turn" gate, and Send now into a turn that
can steer is gated too.

**Needed.**

- A provider call distinct from a new turn: `steer(chat, turn, request) -> Result<(), ProviderError>`, nonblocking,
  `turn` the running one, settling as `Steered { chat, turn, result }` or `SteerFailed { chat, turn, error }`.
  Events keep the running `TurnId`. Decide whether `SteerFailed` ends the turn (Node) or only refuses the message (the
  reply split is already saved, so Node's behavior loses nothing but ends the turn).
- Admission: steer only into the active turn (generation check), never while quitting or closing, never into a
  wake/escalation turn (Codex roles are immutable per session: see `POLICY-CONTRACT.md`), never while a compaction is
  pending.
- Traces: steer with text so far, steer with running steps, steered first text split, Send now steer, steer
  rejected.

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

- Content writes: the transcript file through the owner's isolated content path with `assert_owned` before writing.
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
