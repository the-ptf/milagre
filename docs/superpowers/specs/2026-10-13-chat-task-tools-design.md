# Chat task tools: one task list and phase graph for every provider

Date: 2026-10-13. Status: approved design, awaiting spec review.

## Goal

Every Chat keeps its plan in Milagre, whatever the provider. Agents write a nested task list and the work phase
through Milagre MCP tools, so Claude, Codex, Antigravity and any later provider fill the same Tasks pill. The list and
the phase history stay with the Chat after the turn ends and after a restart, on desktop and phone.

Follows the env fix on `milagre/fix-chat-task-display-oiuv`, which turned Claude Code's hidden Task* tools back on.
That fix keeps the native fallback below working for Claude.

## Decisions

| Question | Decision |
| --- | --- |
| Native todo tools | Milagre tools win. A provider's native list (Claude Task*/TodoWrite, Codex plan, ACP plan) is shown only until `tasks_set` or `task_update` first writes to that Chat; after that, native updates are ignored for that Chat. `phase_set` alone doesn't take the list over, so phases work next to a native list. |
| Lifetime | Persisted with the Chat. Survives turn end, app restart and idle unload. |
| Phases | Set by the agent through `phase_set`, timestamped by Milagre. Fixed list of eight. |
| Tool shape | Hybrid: `tasks_set` writes the whole tree, `task_update` changes one task, `tasks_read` returns both, `phase_set` moves the phase. |
| Nesting | Up to three levels. |
| Parent status | Derived from children. The agent sets status on leaves only. |
| Platforms | Desktop and phone in the same round. Phone ships by OTA after merge. |
| Charting | Hand-written SVG on both platforms. No new dependency. |

Rejected: a whole-tree-only tool (every status tick resends the tree, and models drop or rename items while copying),
granular create/update/delete (an eight-item plan takes eight calls and Codex and Gemini track ids poorly), unlimited
depth (cramped on a phone, agents over-nest), and inferring phases from tool activity (often wrong, hard to tune).

## Terms

- **Task list:** a Chat's tree of tasks, at most three levels deep. Added to GLOSSARY.md.
- **Leaf:** a task with no children. Only leaves carry a status the agent sets.
- **Phase:** where the Chat's work is: `start`, `plan`, `build`, `test`, `review`, `merge`, `release`, `done`.
- **Source:** where the list came from, `milagre` or `native`.

## Data model

In `packages/shared/src/model.ts`:

```ts
type ChatTaskStatus = "pending" | "in_progress" | "completed";
interface ChatTask {
  id: string;            // "1", "1.2", "1.2.1": assigned by Milagre, stable across tasks_set calls
  title: string;
  activeForm?: string;   // shown while in progress ("Saving wishlist changes")
  status: ChatTaskStatus; // derived for parents
  children?: ChatTask[];
}
type ChatPhase = "start" | "plan" | "build" | "test" | "review" | "merge" | "release" | "done";
interface ChatPhaseEntry { phase: ChatPhase; at: number } // epoch ms
interface ChatPlan {
  source: "milagre" | "native";
  tasks: ChatTask[];
  phases: ChatPhaseEntry[]; // oldest first, at most 200; the last entry is the current phase
  updatedAt: number;
}
```

`AgentTask` and `tasks-updated` stay for the providers' native lists. A native list maps to a flat `ChatPlan` with
`source: "native"` (`content` becomes `title`, positions become ids).

The plan lives on the Chat's session record as `session.plan`, next to `session.subagents`, and is saved and loaded
the same way. A session without `plan` has no task list. Idle unload (ADR-0009) keeps it because it is part of the
record, not the run.

### Tree rules (one pure module, `packages/shared/src/chat-plan.mjs`)

- `setTasks(plan, input)`: replaces the tree. Input items are `{ id?, title, activeForm?, status?, children? }`. An item
  whose `id` matches an existing task keeps that task's status unless the input gives one. Items without an id get the
  next free position id under their parent. Depth past three, an empty title, or more than 100 tasks in total is an
  error naming the offending item.
- `updateTask(plan, { id, status?, title?, activeForm? })`: unknown id is an error listing the valid ids. Setting
  `status` on a parent is an error ("set the status of its subtasks").
- `derive(tasks)`: parent status is `completed` when every child is, `in_progress` when any child is in progress or
  some but not all are completed, `pending` otherwise.
- `setPhase(plan, phase, now)`: appends `{ phase, at: now }` unless it equals the current phase; drops the oldest past
  200.
- `counts(tasks)`: `{ done, total }` over leaves.

The same module runs in core, the desktop renderer and the phone, as `agent-runs.mjs` does.

## Tools

Defined in a new `packages/core/src/chat-plan-tools.cjs` with the shape every Milagre tool uses
(`{ name, description, input, readOnly, run }`, `linked-tools.cjs:318`), added to `extraTools(chatId)` in
`runtime.cjs` so every Chat gets them on every provider (Claude in-process server, Codex and ACP over the per-Chat
local MCP URL).

| Tool | Input | Returns |
| --- | --- | --- |
| `tasks_set` | `{ tasks: TaskInput[] }` | The tree with ids, as indented text (`[x] 1 Persist wishlist items`) |
| `task_update` | `{ id, status?, title?, activeForm? }` | The updated tree, same format |
| `tasks_read` | `{}` | The tree and the current phase |
| `phase_set` | `{ phase }` | The phase history, one line per entry |

Each write runs the tree rule, stores the plan on the session, and pushes `{ type: "plan-updated", plan }` into the
Chat through `chats.receive(chatId, event)`, so desktop gets it live and the phone's next snapshot carries it. Writes go
through the Project's state mutation queue (`project-states`), like every other session change, so two tool calls
can't interleave.

Instructions (`milagreInstructions` in `agents/events.cjs`) gain one paragraph: plan multi-step work with `tasks_set`,
tick leaves with `task_update` as you go, call `phase_set` when the work moves on, and do not also use a provider's own
todo tool.

### Native fallback

`chat-host.cjs` handles `tasks-updated` from a provider: when the session's plan is absent or `source: "native"`, it
stores the mapped flat plan (phases kept); when `source: "milagre"`, it drops the event. The run no longer carries
`tasks`, and the turn-end deletion in `agent-runs.mjs` no longer clears the list.

## Desktop

`TaskTrack.tsx` reads `session.plan` instead of `run.tasks` and stays mounted while the Chat has a plan, not only
while a turn runs.

- **Pill:** `done/total` over leaves. Hidden when the Chat has no plan.
- **Popover, Tasks section:** header "TASKS" with the leaf total. Numbered rows by position within the parent,
  indented per level, with a chevron to collapse a parent (all expanded by default). The in-progress leaf is
  highlighted and shows its `activeForm`. Status mark on the right: filled check for completed, ring for pending,
  spinner ring for in progress.
- **Popover, Phase graph section:** shown once the plan has a phase entry. Rows are the eight phases, `start` at the
  bottom, each with its icon. The x axis runs from the first entry to now with three or four time labels and a dashed
  Now line. A smooth line steps between phase rows at each entry's time, with a dot per change; the current phase's
  dot is the accent colour and its row label is highlighted. A stretch with no change longer than one hour is drawn
  compressed with a chip showing its length ("2h").
- Colours come from theme tokens, so all themes work.

## Phone

The Chat screen gets the same pill in its composer row, opening a sheet (the existing `formSheet` pattern) with the
Tasks tree and the Phase graph, drawn with `react-native-svg`, which the app already ships. The inline task card in
`chat-reply.tsx` goes away. The plan arrives with the session in the runs and session snapshots the phone already
fetches.

## Errors

Tool input errors return `isError` with one sentence naming the field and the fix; nothing is stored. A plan that fails
to load (bad JSON in an old record) is treated as absent and logged once. The UI never throws on a malformed plan: rows
with no title are skipped.

## Testing

- `chat-plan.test.mjs`: id assignment and stability across `tasks_set`, status carry-over, depth and size limits,
  parent derivation, `updateTask` errors, phase dedupe and the 200 cap, leaf counts.
- `chat-plan-tools.test.cjs`: each tool's validation, stored plan and emitted event; serialized writes.
- `chat-host` tests: native list stored while absent or native, ignored once Milagre owns it; plan survives
  `turn-completed`, reload and idle unload.
- Real runs: one Claude, one Codex and one Antigravity Chat each asked to plan a three-step task, confirming
  `tasks_set` and `task_update` reach the pill.
- Screenshots: Electron check of the popover with a three-level tree and a graph with an idle gap; simulator capture
  of the phone sheet. Images go on the `screenshots` branch.

## Rollout

One PR: shared model and tree module, tools and instructions, chat-host storage and fallback, desktop pill, phone
sheet. Desktop ships with the next beta; phone by OTA after merge.
