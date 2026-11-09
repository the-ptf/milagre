# Delegate to another computer, and watch it from here

Date: 2026-10-23. Status: draft, awaiting sign-off.

## Goal

A Chat on one Mac plans the work, then hands its execution to a Project on another paired Mac. The planning Chat shows the
remote turn as it runs, and approvals can be answered from either Mac. Today `delegate` only reaches Worktrees on the Mac
the Chat runs on.

## Decisions

| Question | Decision |
| --- | --- |
| Target | Per delegation. `delegate` takes a computer and a Project, as it takes a Worktree and a Chat today. A Project lives on one Mac, so naming the Project names the computer. |
| Observation | The planning Chat mirrors the remote turn live, as T3 Code does: the client views the host's event stream, and the thread stays on the host. A dropped link resumes from a sequence cursor, so nothing is lost. |
| Approvals | Either Mac can answer. The request waits on the Mac running the turn. The first answer wins, and the other window's card clears. |
| Reports | The Delegation report comes back to the planning Chat through the Mac that ran the turn, the same as a local Delegation. |
| Offline target | Fail at once with a message naming the computer. Nothing queues on the planning Mac. (My default, not yet confirmed.) |
| Stop | Either side can stop the remote turn. |
| Rollout | Behind Settings › Experimental, like the Computers rollout. |

Not in v1: Negotiations across computers (`negotiation: true` stays local), and phone support for remote observation.

## Why this shape

- **One writer per Project.** ADR-0002 keeps the agent of the target Worktree as the only writer. The remote Mac's daemon runs
  the turn, so ADR-0003 still holds: a Project is only ever opened by its own daemon.
- **T3 Code's model.** Its threads stay on the machine where they start, and its clients are views of that machine's event
  stream. Its remote-access doc says a remote tab streams to other devices, and a take-control step precedes typing. This
  design follows the same split: observe by default, take over by an explicit action.
- **Reuse the Computers channel.** Remote chats already stream through the desktop channel to another Mac
  (`2026-10-08-computers-design.md`). Observation is that same stream, rendered inside the planning Chat.

## Flow

1. The planning Chat's agent calls `delegate({ computer, project, chat | "new", message })`.
2. The planning Mac's daemon records a Delegation with status `queued` and sends the message over the computer channel.
3. The remote daemon starts a normal turn in its own Chat (its own agent, its own approvals) and returns a run id.
4. The planning Chat renders a "Running on <computer>" card that subscribes to the remote thread's events.
5. On finish, the remote daemon sends the Delegation report. The planning Chat gets it with its next turn, as a local report does.

## Where the state lives

- The planning Mac owns the Delegation record, so its history and reports stay in the Chat that asked.
- The remote Mac owns the turn, its transcript, its approvals and its Worktree.
- A remote key is qualified by computer, as remote chat keys already are (`${computerId}|${key}`).

## Gaps the plan must verify before coding

- `packages/core/src/delegations.cjs` resolves `worktree` and `chat` only in the local store. The `target`, `chat` and
  `openChat` ports need a remote variant.
- `apps/daemon/src/computer-routing.cjs` keeps `linked:` calls local-only, and `chat:limit-switch` by exact name. Any remote
  delegation path needs its calls on the allowed side, so confirm which ones and open only those.
- Answering an approval from the other Mac needs the remote daemon to accept a decision from a paired desktop. Confirm the
  approval handler takes a decision from any client, and that a second answer is refused cleanly.
- Confirm how the planning Chat's composer and `delegate` tool see the list of remote Projects.

## Open questions

1. Should a Chat be able to pick a computer in the composer, or only the agent picks it? (Agent-only in v1.)
2. Does a stop from the planning Mac also stop the remote turn's sub-agents? Unverified: check how sub-agents are tied to their turn before deciding.
