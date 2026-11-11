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
fn answer_question(&mut self, chat: &str, turn: TurnId, answer: AnswerId, request_id: &str, answers: &RawJson) -> Result<(), ProviderError>;

ProviderEvent::AnswerSettled { chat, answer: AnswerId, outcome: AnswerOutcome }
enum AnswerOutcome { Accepted, NotWaiting, Failed(ProviderError), Uncertain(ProviderError) }
```

Adapter side:

1. Enqueue only. `Err` means refused at once (that session is gone): nothing was handed over.
2. Settle each `AnswerId` with one of:
   - `Accepted`: the adapter confirmed the session's transport accepted it (Codex: the reply frame was written,
     `Ok(true)`; Claude: the callback resolved). Not that a tool ran or the agent acted on it.
   - `NotWaiting`: proven that nothing waited on that request id: Node's `false`.
   - `Failed(error)`: proven not delivered (refused before writing, or removed from the queue unwritten).
   - `Uncertain(error)`: it may have reached the session (written, or possibly written, then the pipe broke, the
     process died or no confirmation came). Use this whenever non-delivery can't be proven.
3. After an `Uncertain`, the adapter may still send one definitive settlement for the same `AnswerId` if it learns
   more (`Accepted`, `NotWaiting`, `Failed`); the host resolves the kept answer with it.
4. `turn` is the turn running in the Chat: a request lives in its turn's run (Node drops a run's approvals and
   questions with it). With no turn running the host settles `false` at once and never calls the provider.
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
- **Lifetime.** An answer holds its slot (and blocks retries of its request) only while its turn runs. When that turn
  ends, and when its session closes (forced end, `Exited` naming its latest turn, `forget`, quit, which release every
  answer of the Chat up to that turn), answers still on their way settle `Uncertain` and uncertain ones are released.
  Their messages stay shown. They move to a history (no slot, no block; `MAX_HISTORICAL_ANSWERS`, 1,024, oldest
  dropped, each told as `Notice::AnswerForgotten`, whose delivery stays unknown, so a client shows it as unknown; `ChatHost::answer_history` sets the bound, and lowering it trims the excess, oldest first, at the next release, each told) where a late definitive settlement still resolves them (`AnswerResolved`; proven non-delivery takes the
  message back). A retry after the turn ended is admitted and the provider says whether anything waits.
- **Slots.** Answers on their way and kept uncertain answers share one capacity: `ChatHost::answer_capacity`
  (default `ANSWER_CAPACITY`, 256; the runtime may set it lower, e.g. 32).
  - A slot is checked before anything is shown or handed over and taken when the answer is handed over.
  - At capacity a new answer is refused with `StoreError::AnswersAtCapacity` (code `ANSWERS_AT_CAPACITY`).
  - An unresolved answer of a live generation is never evicted: eviction would let the same request be answered
    twice while that session lives.
  - A slot is freed only by a definitive settlement (`Accepted`, `NotWaiting`, `Failed`, including one told later as
    `Notice::AnswerResolved`) or by its session generation closing. A closing generation keeps the answers messages
    shown (history) and stops blocking. There is no manual clear.
- Unknown, duplicate or other-Chat settlements are dropped (an error from `pump`/`deliver`).

Runtime actor: keep the client's command reply for a `Pending` ticket and answer it from the matching
`Notice::AnswerSettled`: `true`, `false`, reject with the message, or reject with `ANSWER_DELIVERY_UNKNOWN`.
`Notice::AnswerResolved` is for the Chat only: the reply was sent already. `ChatHost::call` returns
`{ "pendingAnswer": id }` for these two commands. Never reply `true` before settlement.

## JSON boundary

- Provider JSON is raw: `ProviderEvent::Agent { event: RawJson }` and `Started { result: RawJson }` carry plain
  `serde_json` values, strings as the provider produced them. `ProviderError.message` and the `chat` keys of events
  are plain strings. Each is encoded once where it enters the host (`deliver`, immediate `Err`s of `start_turn`,
  `interrupt`, `close_chat`, the answer calls).
- Outbound is raw too, and typed: `start_turn(turn, request: &RawJson)` and `answer_question(.., answers: &RawJson)`
  get plain values, decoded field by field (the runtime's policy, 52bc1fb6), never by a broad recursion:

  | Turn request field (SessionManager.startTurn)                                                          | Outbound                           |
  | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
  | `prompt`                                                                                               | free text: lone surrogate → U+FFFD |
  | `provider`, `model`, `permissionMode`, `effort`, `replies` (a style name), `chatId`, `cwd`, `resumeId` | exact, or refused                  |
  | `ultracode`, `fastMode`, `tldrEnabled`                                                                 | exact (flags)                      |
  | `images`                                                                                               | must be empty (images are gated)   |
  | anything else                                                                                          | refused: no rule yet               |

  Answers: answer strings are free text, question ids (keys) and request ids exact; the `chat` argument of every call
  exact. Free text is lossy only in the outbound copy: the saved message keeps it. An exact field holding an unpaired
  surrogate is refused, never replaced, so two different ids can't alias each other or a real U+FFFD id. A refused
  turn fails before any provider call; a refused answer is refused before anything is shown or handed over (its wire
  values are built before the answers message is recorded).

  Adapters pass these values on as they are and never decode again (the runtime's own outbound conversion goes,
  or it would decode twice).

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

## Handoff (gated; contract agreed, being built)

Restore only first; switch stays gated. Both gates stay until the traces and the runtime adapter are verified.
`ChatHost::handoff` is `HandoffMode::Gated` in production; `HandoffMode::Restore` (isolated tests and conformance
only) runs the restore lifecycle:

1. `send` to a Chat whose last turn was on the same provider, with a completed reply and no native session: with the
   handover store leased and a job reservation free (else refused before anything is staged), the divider
   (`{ id: next_id, role: "assistant", body: "", context: { kind: "handoff", from, to, status: "preparing" } }`) and
   the message (`next_id + 1`) are saved in one write and flushed, `message-sent` opens the run, and the turn is
   reserved (`Sent.turn`). Nothing is asked of the provider yet.
2. The transcript job renders the Chat before the divider (Node's `before`, provider set to the one handed from).
   Its commit asks the brief (`safe_brief_request`).
3. The brief (the model's, or the minimal one) marks the divider `done` with `brief` and `transcriptPath`; the turn
   starts only once that save holds (a failed save is retried on `tick`), with `framedBrief(brief)` ahead of the
   prompt (`withLead`). `Notice::Started`/the turn's end settle `Sent.turn` as for any start.
4. Stop while preparing (`interrupt`): the divider fails and the turn ends `turn-cancelled`; no agent is asked.
   A failed job or commit: the divider fails and the turn ends `turn-failed` with the reason. A forced quit or
   forget cancels it like Stop (never `close_chat`: no session runs) and waits for jobs out (`QUIT_PENDING`).
5. `recover_handoffs(project)`, called once the Project and the handover store are open: dividers still `preparing`
   that no live handoff owns fail (a switch's session reverted to the provider it left, native sessions swapped
   back), and `handoverPending` marks go.

A send while a restore prepares is not steered into it (steering is gated); it queues or is refused as any send to
a busy Chat. The
agreed lifecycle, job and brief contracts are in `HANDOFF-PROPOSAL.md` and the negotiation summary.

- **Deliberate deviation: the brief prompt.** Node wraps the transcript in `<transcript>` unescaped and cuts it with
  `slice(-keep)`, which returns the whole transcript once the header (title, worktree path) and the first message fill
  the 60,000-unit limit. The owner keeps both byte for byte in `handover::brief_request`/`cut_transcript` (parity,
  traced), but the live brief invocation uses `handover::safe_brief_request`: `safe_cut_transcript` also cuts a header
  over 4,000 units (its start and end kept, the catch-up line included), then the cut transcript's `<transcript` /
  `</transcript` and Milagre's block tags are written `&lt;…`. The prompt, as the brief boundary decodes it, is checked
  against `MAX_BRIEF_PROMPT_BYTES` (256 KiB) in every build (refused, never sent, if over); `BriefRequest::outbound`
  checks it again.
- **Jobs (host API).** `ChatHost::take_jobs()` hands each `TranscriptJob` over once (callable while quitting or
  closing); the runtime runs it with `job.run()` on a blocking worker. The job reports its own outcome to the host's
  inbox (also when dropped unrun, panicking or cancelled); `pump` handles outcomes and `tick` also retries removing
  temporary files a job left, once per job per tick, only through the folder the job held. A result is committed
  only for the handoff's own turn, with the Project still owned; anything else is removed, never committed.
- **Quit and forget.** `shutdown` stays `Result<()>`. With jobs or temporary files still out it returns
  `QUIT_PENDING`: providers are shut down once, handoffs are cancelled, and every lock and Project is held.
  `quit_state()` says `Running`, `JobsPending { jobs, cleanups }`, `ClosePending` or `Done`; `Done` only once every
  job reported, every temporary file is gone and the states closed. A forced `forget` with jobs out cancels them,
  keeps the Project open, locked and closing (no send taken) and returns `QUIT_PENDING`; `forget` again finishes once
  they report back. A plain quit or forget is refused while a handoff is being prepared, as with a running turn.
- **Brief model** (`src/brief.rs`, not `Provider`). `ChatHost::register_brief_model`. Once a transcript is committed
  the host asks `BriefModel::ask(BriefRequest)` (enqueue only) with `safe_brief_request`: Chat and provider strict
  (an unpaired surrogate refused, the provider one Milagre knows), system and prompt decoded once, lossy. `NoModel`,
  `AtCapacity`, more than `MAX_BRIEFS` (8) out, or a request that can't go out exactly: the minimal brief at once.
  `Replied` is encoded once on entry; over `MAX_BRIEF_REPLY_BYTES` (64 KiB, a deliberate deviation) counts as
  failed. A brief past `brief_grace_ms` (30 s) is cancelled (advisory) and counts as failed; a cancelled, settled or
  unknown id's later answer is dropped. The minimal brief's changed files come from `src/changed_files.rs`: `git status --porcelain` run by the transcript
  job (off the actor) only in worktrees the runtime admitted with `ChatHost::admit_worktree` (canonical, inside the
  isolated copy, a `.git` folder of its own, no `commondir`, no `include`/`worktree`/`fsmonitor` config; checked again
  at each run), with `/usr/bin/git`, a cleared environment (no system or global config, `GIT_OPTIONAL_LOCKS=0`, no
  prompt, `GIT_DIR`/`GIT_WORK_TREE` pinned, discovery ceiling at the copy, hooks and fsmonitor off), in its own process
  group (killed whole on timeout; pipes waited on 500 ms at most), 3 s per run and 6 s per handoff, 1 MiB of Git output
  and 2 MiB of listed files per handoff, aliases up to 256 bytes; the `.git` folder and config identity is compared
  before and after the run. Git never reads the repository's own Git folder as its own: each run gets a private one in `.owner/git` (a plain
  config keeping only an allow-list of `core` read settings, HEAD as its commit, copies of the index and `info/exclude`,
  objects through one alternate) with submodules ignored and no attributes file or excludes of its own, so no filter,
  hook, fsmonitor, include, `worktreeConfig` or submodule the repository names runs; extensions or object alternates
  give no list. Pipes are read without threads. Anything not admitted or failing gives no list, as Node's
  `changedFiles().catch(() => [])`. Lines are read as
  Node reads them (`line.slice(3)`, the alias in front for a Link member); Git's own defaults apply where Node would
  use the person's Git config (`core.quotePath`). Admission is a new runtime API: coordinate before the runtime calls
  it.
- **Job memory.** `TranscriptJobs::job` takes a borrowed `TranscriptSource`: it measures only the Chat's session,
  worktree and messages before the divider (a counting serializer, nothing copied) and refuses a Chat over
  `MAX_TRANSCRIPT_INPUT_BYTES` (32 MiB) or a job that would take the reserved jobs' inputs over
  `MAX_TRANSCRIPT_BUDGET_BYTES` (64 MiB, `TRANSCRIPTS_AT_CAPACITY`) before copying; then it copies only those parts.
  The job renders with a byte limit (`render_transcript_bounded`: every piece is written straight into one buffer
  and refused before it would pass the limit; `String(array)` is streamed element by element, never collected), writes the file, and keeps
  only the brief's prompt (at most 256 KiB). A temporary name needs a random part from `/dev/urandom`; the job fails
  rather than use a predictable one.
- **Commit and debt.** A commit checks the pin and the folder before the rename and again after it; a change in
  between is an error ("where the file is now is unknown"), so the host never names a path that doesn't hold the
  file and treats it as possibly committed. A folder the job makes is fsynced into the handovers folder before
  anything is written in it (plain `fsync`; macOS `F_FULLFSYNC` for every durable save is separate work). A
  temporary file that can't be removed stays the owner's debt, as agreed: its reservation and Project stay held and
  the quit stays `QUIT_PENDING` until it goes; there is no force path that drops it. Two jobs may be out for one
  Chat (a newer handoff before the older job reported); only the one of the handoff's current turn is committed,
  the other is removed.
- **Handover store lease and sweep.** `TranscriptJobs::new` takes a nonblocking exclusive `flock` on the pinned
  handovers folder itself (its descriptor): a second owner is refused at once, and since the lock and the folder are
  one identity, replacing a file inside can't admit one. Every job, outcome and temporary file still to remove holds
  a share, so the lease lasts until the last of them; the last drop unlocks it explicitly, and only in the process
  that took it (a forked child's drop leaves the parent's lock). With the lease held, and the folder's path checked
  to still lead to the folder locked, it removes what a previous owner provably left: exact temporary names
  (`.<session>.<job>.<16 hex>.tmp`) in folders named as jobs name them (12 hex), plain files with one link owned by
  the store's owner, through the folder's descriptor. Committed transcripts, unknown files, links, hard-linked
  files and folders are never touched. Committed transcripts are kept (Node never deletes them either); any retention
  rule comes later, explicit, and never deletes a transcript a divider still names.
- **Notices after a quit.** Stranded locks and job failures are put in the notices before `shutdown` returns (also
  when it errs); the runtime takes the notices once more after the last `shutdown` call.
- **Transcripts** go to `<copy>/.owner/handovers/<sha1(project)[..12]>/<session>.md` through `transcripts::TranscriptJob`
  (bounded, owned, one outcome per job, pinned folder descriptors; see the module docs).
