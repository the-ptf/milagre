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
reply that can fail after it was queued). So answers settle asynchronously:

```rust
fn respond_permission(&mut self, chat: &str, turn: TurnId, answer: AnswerId, request_id: &str, decision: &str) -> Result<(), ProviderError>;
fn answer_question(&mut self, chat: &str, turn: TurnId, answer: AnswerId, request_id: &str, answers: &Value) -> Result<(), ProviderError>;

ProviderEvent::AnswerSettled { chat, answer: AnswerId, outcome: AnswerOutcome }
enum AnswerOutcome { Accepted, NotWaiting, Failed(ProviderError) }
```

Adapter side:

1. Enqueue only. `Err` means refused at once (that session is gone); nothing was handed over.
2. Exactly one `AnswerSettled` per `AnswerId`:
   - `Accepted`: the session took it (Claude: the callback resolved; Codex: the reply was written).
   - `NotWaiting`: nothing waited on that request id (answered, withdrawn, other session): Node's `false`.
   - `Failed(error)`: handing it over failed after queueing (broken pipe, process gone, write stalled).
3. `turn` is the Chat's latest turn (its session generation); answer within that session only.
4. The host validates first: decision is one of `allow`, `allow-for-chat`, `deny`; answers are `null` or at most
   10 question ids with at most 20 strings of 10,000 code units. Secret (`milagre-secret-*`), bug-report
   (`milagre-bug-report-*`) and setup-review (`setup-review-*`) requests never reach a provider.

Host side (`ChatHost::respond_permission` / `answer_question` return an `AnswerTicket`):

- `Settled(false)` at once when the Chat has no live session here (Node's `?? false`).
- `Pending(answer)` otherwise. The answers message is shown first (Node's `recordAnswers`, before the agent has them),
  then `Notice::AnswerSettled { answer, result }` follows:
  - `Ok(true)`: taken.
  - `Ok(false)`: nothing waited; the answers message is taken back.
  - `Err(message)`: failed; taken back too.
- An answer with no settlement after `answer_grace_ms` (30 s) fails as a timeout and is taken back; a later settlement
  is dropped. An answer waiting on a session that closes (forced end, `forget`, `Exited`, quit) fails the same way.
- Duplicate, unknown or other-Chat settlements are dropped (an error from `pump`/`deliver`).

Runtime actor: keep the client's command reply for a `Pending` ticket and answer it from the matching
`Notice::AnswerSettled` (`true`/`false`, or reject with the message). `ChatHost::call` returns
`{ "pendingAnswer": id }` for those two commands so a generic boundary can tell. Never reply `true` before
settlement.

## Owner policy boundary

The owner doesn't port constrained roles (Codex `POLICY-CONTRACT.md`: `AnalysisAdvisor`, `Babysit`, `Escalation`,
`ExecutionAdvisor`), the dispatcher manifest, the 6+2 escalation budget or the wake-scope guard. Sends that would need
them (Routine runs, wake guards, `canStart`, limit routing) are refused with explicit gates. Until those land, every
owner turn is an `Ordinary` session.
