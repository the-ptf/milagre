# Handoff lifecycle and API proposal (not implemented)

What the owner needs to run a handoff (switch or restore) end to end, now that the formatting is ported. Nothing here
changes `Provider`; the `handoff` and `handoff restore` gates in `ChatHost::send` stay until this is agreed.

## Ported (src/handover.rs)

The pure parts of `agents/handover.cjs`, compared with Node's own over 131 cases (`tests/handover.rs`):

- `render_transcript(state, session_id, after, clock)`: header (title, provider, worktree or Link workspace), sender
  headings for Delegations, Delegation reports, Negotiation agreements, Advisor results, PR pills and Linear issues
  (Routine Runs too), dividers (handoff, notices, Routine runs, compactions), assistant steps without thinking,
  legacy `handoverBrief`, catching up after an id. Unknown and malformed contexts read as the user's message.
- `cut_transcript`: 60,000 UTF-16 units, the first message (up to 6,000) and the tail; halves of emoji kept.
- `transcript_path(dir, project_path, session_id)`: `path.join(dir, sha1(project)[..12], "<id>.md")`.
- `framed_brief`: the `<handoff_brief>` block with Milagre's tags defused (`neutralize_tags`).
- `brief_request` (what the model is asked), `parse_brief`/`extract_json` (how its reply is read) and `brief_text`
  (the brief with its pointer, or the minimal brief: last request and changed files).

Where Node throws (a `null` body used for the title, `steps` that aren't a list, a handoff without `from`, a Routine
run time `Intl` refuses) the port returns `StoreError::Invalid`. One deliberate difference: a Session looked up by a
name of `Object.prototype` is refused (Node reads the prototype's function as a Session).

## Proposed lifecycle in the owner

1. **Stage (one save).** A send that hands off (`handoffKind`: switch or restore) saves the divider (`context: { kind:
   "handoff", status: "preparing", from, to, catchUp? }`) before the user message and, for a switch, `applySwitch`
   (park the left provider's native session in `native_sessions[from]`, take the entered one's as `resumeId`).
   The Chat enters a `preparing` set that counts as busy (no sweep, no other start).
2. **Transcript (owner job, isolated).** `render_transcript` over the state before the divider, with the session's
   provider set to `from` (prepareHandoff's `before`). Node writes it to `<dataDir>/handovers/<sha1>/<id>.md`, outside
   the Project. The owner writes only inside its Isolation (`<isolated data dir>/handovers/`), and only after:
   - the session id is a positive integer (`transcript_path` follows `path.join`, so `..` in an id would climb);
   - the path, resolved, stays under that folder with no link on it (the same checks as content writes);
   - write to a temporary file, then rename; mode 0600.
3. **Brief (a separate, nonblocking model).** The brief comes from the left provider's small model in a one-shot
   call (`createHandoverModels`), not from the Chat's session, so it doesn't belong on `Provider`:

   ```rust
   pub struct BriefId(pub u64); // host-assigned, one per handoff
   pub trait BriefModel: Send {
       /// Enqueue only. Err: no model for this provider (the host writes the minimal brief at once).
       fn ask(&mut self, provider: &str, brief: BriefId, request: &BriefRequest) -> Result<(), ProviderError>;
       fn cancel(&mut self, brief: BriefId);
       fn take_events(&mut self) -> Vec<BriefEvent>;
   }
   pub enum BriefEvent { Replied { brief: BriefId, reply: String }, Failed { brief: BriefId } }
   ```

   The host keeps a deadline (`BRIEF_TIMEOUT_MS`, 30 s, on the tick clock); no reply in time counts as `Failed`.
   Changed files (`git status --porcelain`, per Worktree member) come from a runtime job the same way
   (`ChangedFiles { brief, files }`, `[]` on failure); only the minimal brief needs them. The host composes the text
   with `brief_text`. A reply that arrives after a cancel or the deadline is dropped.

4. **Start.** Mark the divider `done` with `brief` and `transcriptPath`, then start the turn with `framed_brief(brief)`
   ahead of the prompt (`withLead`), through the existing `start_turn`. The outbound table gets no new field: the
   brief travels inside `prompt` (free text).
5. **Cancel and failure.** Stop, a forced end, `forget` or quit while preparing: `cancel`, then `abandonHandoff`
   (divider `failed`, `revertSwitch`), no turn starts, and a sender waiting on the start hears `null`. A failed
   transcript write abandons the handoff the same way and reports the error.
6. **A send while preparing** waits and then steers into the started turn (Node `waitFor`). Steering is gated, so this
   stays refused until steering lands.
7. **Startup.** `recoverHandoffs`: every divider still `preparing` is marked `failed` when a Project opens.

Traces to record before ungating: switch, restore, brief failure and deadline, Stop while preparing, send during
preparation, recovery after a crash, and a transcript write refused by the isolation checks.

## Providers that can't resume (ACP one process per turn)

The runtime's ACP fixture runs one process per host turn and keeps no native session id, so the second send in a Chat
finds a completed reply and no `native_session_id`: a restore handoff. The gate refuses it today, as it should. Two
ways forward, to decide before it changes:

- **Restore every turn** (Node's semantics as they stand): each later turn hands over with a transcript and a brief.
  Correct but costly (a model call per turn) and noisy (a divider per turn).
- **A capability, not a handoff**: the provider declares it is not resumable, and the host starts each turn with a
  catch-up transcript (`render_transcript` with `after` the last turn, no brief, no divider). Needs a provider
  capability flag and its own traces; it isn't Node behavior, so the desktop would need the same change.

Until one is agreed the gate stays, with no fixture bypass.

## Node findings to decide (parity kept for now)

- The brief prompt wraps the transcript in `<transcript>` without escaping: a message containing `</transcript>`
  closes the data block for the model. `neutralizeTags` doesn't cover `transcript`.
- The transcript lives in `<dataDir>/handovers`, outside the Project and its lock: two computers sharing a Project
  each keep their own, and nothing removes old ones.
- `transcriptPath` trusts the session id (`path.join` normalizes `..`); session ids are integers today.
- A Routine run's time uses the computer's time zone, so the same Chat renders differently on two computers.
- One malformed message (a non-string body read for the title, a step that is `null`) throws and fails the whole
  handoff.
