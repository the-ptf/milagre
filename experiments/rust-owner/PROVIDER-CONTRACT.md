# Owner Provider contract (rust-owner ChatHost)

What a provider adapter (`rust-providers`, `rust-claude`) and the runtime actor need from the Rust owner, and what the
owner promises back. Source: `src/chat_host.rs` (`Provider`, `ProviderEvent`, `ChatHost`). Isolated copies only; no
real provider is wired here.

## Rules for every method

- **Nonblocking.** Every `Provider` method returns at once. An adapter does its work on its own tasks and reports
  through `ProviderEvent`s (taken by `take_events`, or pushed with `ChatHost::deliver`). A method that needs a session
  mutex, disk I/O or a CLI round trip must queue that work and settle it later. This applies to Claude's sync callbacks
  and to `ToolImageStore` I/O: neither may run on the owner actor.
- **`Send`.** Adapters and everything they hold are `Send`; the host lives in one actor task.
- **Errors carry no credentials.** `ProviderError { kind, message }`: the message is shown in the Chat.

## Identity

- `TurnId`: assigned by the host per `start_turn`. Every event names one. The Chat's latest turn stands for its
  session's generation.
  - Turn events and turn ends must name the turn running; with nothing running they are dropped.
  - Chat-level events (`session-started`, `session-reset`, `context-usage`, `subagent-update`, `background-tasks`,
    `plan-updated`, `tasks-updated`, `prompt-suggestion`) must name the latest turn; an older session's are dropped.
- `AnswerId`: assigned by the host per handed-over answer (below).
- Turns the agent starts by itself (implicit CLI turns) have no host `TurnId` and stay refused until an allocation and
  ownership contract exists.

## Turns

| Call / event                        | Meaning                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `start_turn(turn, request)`         | Begin the turn. `Err` only for a refusal known at once (folded as `turn-failed`) |
| `Started { chat, turn, result }`    | startTurn resolved (`{ turnId, steered }`); a start of a dead turn is dropped    |
| `StartFailed { chat, turn, error }` | startTurn rejected: the host folds `turn-failed`                                 |
| `Agent { chat, turn, event }`       | One Node agent event, exactly as `agent-runs.mjs` folds it                       |
| `interrupt(chat, turn)`             | Ask the turn to stop; `turn-cancelled` follows. Grace `interrupt_grace_ms`       |
| `close_chat(chat, turn)`            | End that generation's session only; a newer one (Send now) stays                 |
| `Exited { chat, turn, error }`      | That session's process ended: fails `turn` if it runs, closes that generation    |
| `shutdown()`                        | End every session (called by `ChatHost::shutdown` after forced turn ends)        |

The watchdog: `ChatHost::tick(now)` handles waiting events, then forces interrupts past their grace (`close_chat`,
then `turn-failed`), then handles events again. A forced end never starts anything while quitting or closing.

## Answers: asynchronous settlement

Node's `agent:respond-permission` / `agent:answer-question` await `SessionManager`, whose boolean comes from the
session. A Rust adapter can't return that synchronously without blocking (Claude) or lying (Codex queues a JSON-RPC
reply with `write_outcome(frame, None)`: dropping the reply future doesn't withdraw a queued frame). So answers settle
asynchronously, and nothing claims a delivery is undone:

```rust
fn respond_permission(&mut self, chat: &str, turn: TurnId, answer: AnswerId, request_id: &str, decision: &str) -> Result<(), ProviderError>;
fn answer_question(&mut self, chat: &str, turn: TurnId, answer: AnswerId, request_id: &str, answers: &Value) -> Result<(), ProviderError>;

ProviderEvent::AnswerSettled { chat, answer: AnswerId, outcome: AnswerOutcome }
enum AnswerOutcome { Accepted, NotWaiting, Failed(ProviderError), Uncertain(ProviderError) }
```

Adapter side:

1. Enqueue only. `Err` means refused at once (that session is gone): nothing was handed over.
2. Settle each `AnswerId` with one of:
   - `Accepted`: the session took it (Claude: the callback resolved; Codex: the reply frame was written).
   - `NotWaiting`: proven that nothing waited on that request id: Node's `false`.
   - `Failed(error)`: proven not delivered (refused before writing, or removed from the queue unwritten).
   - `Uncertain(error)`: it may have reached the session (written, or possibly written, then the pipe broke, the
     process died or no confirmation came). Use this whenever non-delivery can't be proven.
3. After an `Uncertain`, the adapter may still send one definitive settlement for the same `AnswerId` if it learns
   more (`Accepted`, `NotWaiting`, `Failed`); the host resolves the kept answer with it.
4. `turn` is the Chat's latest turn (its session generation); answer within that session only.
5. The host validates first:
   - decision is one of `allow`, `allow-for-chat`, `deny`;
   - answers are `null` or at most 10 question ids with at most 20 strings of 10,000 code units;
   - the summary is at most `MAX_ANSWER_SUMMARY` code units.

   Secret (`milagre-secret-*`), bug-report (`milagre-bug-report-*`) and setup-review (`setup-review-*`) requests never
   reach a provider.

Host side (`ChatHost::respond_permission` / `answer_question` return an `AnswerTicket`):

- `Settled(false)` at once when the Chat has no live session here (Node's `?? false`).
- A request that already has an answer on its way, or one with an unknown delivery, in the same Chat and session
  generation: refused with `StoreError::AnswerDeliveryUnknown` (code `ANSWER_DELIVERY_UNKNOWN`) before anything is
  shown or handed over.
- `Pending(answer)` otherwise. The answers message is shown first (Node's `recordAnswers`), then
  `Notice::AnswerSettled { answer, result }` follows, with `result` one of:
  - `Accepted`: the command answers `true`;
  - `NotWaiting`: `false`, and the answers message is taken back;
  - `Failed(message)`: rejects with the message, and the answers message is taken back;
  - `Uncertain(message)`: rejects with code `ANSWER_DELIVERY_UNKNOWN`. The answers message stays, and the answer is
    kept to block retries of that request.
- **The host never proves non-delivery itself.**
  - No settlement within `answer_grace_ms` (30 s) settles `Uncertain` ("The agent hasn't confirmed the answer.").
  - A session generation that closes with answers on its way settles them `Uncertain` too: forced end, `Exited`,
    `forget`, quit. Their messages stay, and that generation's kept answers stop blocking, since a new session has no
    such request.
- **Kept uncertain answers**, by `AnswerId`: at most `MAX_UNCERTAIN_ANSWERS` (256), the oldest dropped first (it
  stops blocking; its message stays). Each is removed by:
  - a definitive settlement, told as `Notice::AnswerResolved`, where `NotWaiting` and `Failed` take the message back;
  - its generation closing;
  - eviction.
- Unknown, duplicate or other-Chat settlements are dropped (an error from `pump`/`deliver`).

Runtime actor: keep the client's command reply for a `Pending` ticket and answer it from the matching
`Notice::AnswerSettled`: `true`, `false`, reject with the message, or reject with `ANSWER_DELIVERY_UNKNOWN`.
`Notice::AnswerResolved` is for the Chat only: the reply was sent already. `ChatHost::call` returns
`{ "pendingAnswer": id }` for these two commands. Never reply `true` before settlement.

## JSON boundary

- Provider JSON is raw: `ProviderEvent::Agent { event: RawJson }` and `Started { result: RawJson }` carry plain
  `serde_json` values, strings as the provider produced them. `ProviderError.message` is a plain string.
- `ChatHost::deliver` encodes it once (`RawJson::encode`: every string and key through `jsjson::js_string`, a real
  U+10FFFE doubled). After that, a provider string can't read as the `undefined` marker or decode as a lone surrogate.
  Adapters must not jsjson-encode themselves: the runtime's conversion goes.
- `ChatHost::receive`, `send`, `call` and every value in a `Notice` are encoded (jsjson). Serialize notices with
  `jsjson::to_string`, never with `serde_json`, and decode wire requests with `jsjson::parse`.
- A recorded trace replayed through a provider decodes first (`RawJson::decode`, which refuses an unpaired surrogate).

## Owner policy boundary

The owner doesn't port constrained roles (Codex `POLICY-CONTRACT.md`: `AnalysisAdvisor`, `Babysit`, `Escalation`,
`ExecutionAdvisor`), the dispatcher manifest, the 6+2 escalation budget or the wake-scope guard. Sends that would need
them (Routine runs, wake guards, `canStart`, limit routing) are refused with explicit gates. Until those land, every
owner turn is an `Ordinary` session.
