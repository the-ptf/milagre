# Run Chats Live in Their Routine: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Chats that Routine Runs open out of the sidebar, list them on a per-Routine page, and name each Run after what it did.

**Architecture:** A Run Chat is marked `session.routine.hidden = true` when it is made. One shared rule (`isHiddenRunChat`) keeps hidden Run Chats out of every Chat list unless they wait on an approval or a question. The daemon un-hides a Chat when Victor takes it over, names Runs when they end, and archives hidden Run Chats whose Run left the store (one sweep, run on Project open and after the store drops Runs). Desktop and phone get a Routine page with a folded Runs list.

**Tech Stack:** Node (CommonJS) daemon in `packages/core`, shared ESM in `packages/shared` with `.d.mts` types, Electron + React desktop in `apps/desktop/app`, Expo Router phone app in `apps/mobile`. Tests: `node --test <file>`.

**Spec:** `docs/superpowers/specs/2026-10-18-routine-run-chats-design.md`

## Global Constraints

- Hidden Run Chats appear only in: the Routine's Runs list, notifications/push, the attention pill for other Projects, the floating inbox while `approval`/`question`/`failed`, and every Chat list while an approval or question waits.
- Only Victor's own hand un-hides: composer send (desktop or phone, through the `chat:send` command), pin or rename through the `chat:patch` command, or a Heartbeat set on the Chat (by anyone). `chat_start`, `delegate`, MCP `chat_update`, Linear comments, Delegation reports never do.
- `session.routine.hidden` absent means a Chat made before this change: listed until the sweep decides it.
- Title lengths: generated titles are 3 to 7 words, at most 60 characters; a quiet Run's title is the first line of its summary cut to 60 characters (57 + "…").
- Store buckets: skipped+missed 50, refused 50, acted 50, quiet+failed 50. A Run still `running` is never trimmed.
- Copy follows `GLOSSARY.md` (Run, Run Chat, Routine, Chat, Worktree; capitalized). No em dashes in UI copy.
- Phone UI uses the app's existing components (`ui.tsx`, `ListRow`, `PageScroll`, `HeaderButton`, `Icon`), Hugeicons on both platforms.
- No mockups; real-app screenshots go on the orphan `screenshots` branch, never in the PR diff.
- Commits carry no Claude/Anthropic co-author trailer or footer.

## Review Focus

1. **A store that opened read-only or failed to load** (`store.cjs` readOnly) must never make the sweep archive Run Chats because their Runs look missing. Test in Task 4.
2. **A heartbeat Run's `chatId` is the Heartbeat's own Chat.** Dropping heartbeat Runs from the store must never archive that Chat; the sweep only archives a Chat whose `session.routine.runId` matches a Run that is gone. Test in Task 4.
3. **A Run Chat with a pending approval in the open Project** must show in the desktop sidebar and phone list, then hide after the answer. Tests in Tasks 1 and 6.
4. **The phone list's live-run bypass** (`project-navigation.tsx:317`, `:542`) must still hide a running hidden Run Chat. Test in Task 7.
5. **A Run title that fails to generate** (no CLI, timeout, bad JSON) leaves the Routine's name; the Run is still `acted`. Test in Task 3.

---

### Task 1: Shared hidden rule, Run folding and types

**Files:**
- Modify: `packages/shared/src/model.ts` (`AgentSession.routine` at :164-165, `RoutineRun` at :438-454)
- Modify: `packages/shared/src/chats.mjs:31-35`, `packages/shared/src/chats.d.mts:10`
- Modify: `packages/shared/src/routines.mjs`, `packages/shared/src/routines.d.mts`
- Modify: `packages/shared/src/attention.mjs:101-125` (`inboxSnapshot`)
- Modify: `packages/shared/src/canvas.ts:50-55`
- Test: `packages/shared/src/chats.test.ts`, `packages/shared/src/routines.test.mjs`, the attention and canvas tests beside them

**Interfaces:**
- Produces:
  - `AgentSession.routine?: { routineId: string; runId: string; hidden?: boolean }`
  - `RoutineRun.title?: string` (what the Run did, set when it ends)
  - `isHiddenRunChat(session, waiting?: boolean): boolean` in `chats.mjs`: `session?.routine?.hidden === true && !waiting`
  - `isListedChat(session, messageCount, waiting = false)`: false when `isHiddenRunChat(session, waiting)`, else the current rule
  - `foldRuns(runs: RoutineRun[]): RunEntry[]` in `routines.mjs`, where `RunEntry = { kind: "run"; run } | { kind: "fold"; runs: RoutineRun[]; counts: { quiet: number; skipped: number; missed: number; refused: number }; last: number }`. Input is newest first; consecutive Runs that are `quiet`, `skipped-busy`, `missed`, or `rejected === true` fold together; `last` is the newest `startedAt` in the fold. A refused Run counts only as `refused`.
  - `runTitle(run: RoutineRun, routineName: string): string` in `routines.mjs`: `run.title`, else `"<key> <title>"` for a Linear event, else `routineName`
  - `hiddenRunChats(scopes: Array<{ path: string; state: { sessions: Record<string, AgentSession> } }>): Array<{ chatKey: string; routineId: string; runId: string; unread: boolean }>`: non-archived sessions with `routine.hidden === true`

- [ ] **Step 1: Write failing tests**

In `chats.test.ts`:
```ts
test("a hidden Run Chat is left out of the lists until it waits on someone", () => {
  const hidden = { routine: { routineId: "r", runId: "u", hidden: true } } as AgentSession;
  assert.equal(isListedChat(hidden, 3), false);
  assert.equal(isListedChat(hidden, 3, true), true);
  assert.equal(isListedChat({ routine: { routineId: "r", runId: "u", hidden: false } } as AgentSession, 3), true);
  assert.equal(isListedChat({ routine: { routineId: "r", runId: "u" } } as AgentSession, 3), true); // made before hiding
});
```
In `routines.test.mjs`:
```js
test("foldRuns folds quiet, skipped, missed and refused stretches between acted Runs", () => {
  const run = (id, status, extra = {}) => ({ id, routineId: "r", startedAt: 100 - Number(id), status, ...extra });
  const entries = foldRuns([run("1", "acted"), run("2", "quiet"), run("3", "skipped-busy"), run("4", "missed"), run("5", "failed", { rejected: true }), run("6", "failed"), run("7", "quiet")]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["run", "fold", "run", "fold"]);
  assert.deepEqual(entries[1].counts, { quiet: 1, skipped: 1, missed: 1, refused: 1 });
  assert.equal(entries[1].last, 98);
  assert.equal(entries[2].run.id, "6");
});
test("runTitle prefers the Run's own title, then its Linear issue, then the Routine's name", () => { /* three asserts */ });
test("hiddenRunChats lists unarchived hidden Run Chats with their unread state", () => { /* hidden, kept, archived, legacy sessions */ });
```
Add an `inboxSnapshot` test: a hidden Run Chat with `unread` + `lastOutcome: "completed"` is left out; the same Chat with a pending approval is listed as `approval`; with `lastOutcome: "failed"` and `unread` it is listed as `failed`. Add a `canvasWorktrees` test: a Worktree whose only Chat is a hidden Run Chat is left out; with `markOf` returning `"waiting"` or `"question"` it shows.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/shared/src/chats.test.ts packages/shared/src/routines.test.mjs`
Expected: FAIL (`foldRuns` is not exported; hidden Chat listed)

- [ ] **Step 3: Implement**

Types first, then `isHiddenRunChat`/`isListedChat`, `foldRuns`, `runTitle`, `hiddenRunChats`, each with its `.d.mts` declaration. In `inboxSnapshot`, after `status` is known, skip a session with `routine?.hidden === true` unless `status` is `approval`, `question` or `failed`. In `canvasWorktrees`, compute the mark before the listed check and pass `waiting = mark === "waiting" || mark === "question"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/shared/src/*.test.* && npm run typecheck --workspace @milagre/shared`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): hidden Run Chat rule and folded Runs"
```

### Task 2: Store: Run titles, split bucket, dropped Runs

**Files:**
- Modify: `packages/core/src/routines/store.cjs` (`trimRuns` :208-224, `finish` :178, `transact` :531, `createRoutineStore` :376, `finishRun` :977, return object ~:1100)
- Test: `packages/core/src/routines/store.test.cjs`

**Interfaces:**
- Consumes: `RoutineRun.title` (Task 1)
- Produces:
  - `createRoutineStore({ ..., onRunsDropped?: (dropped: Array<{ routineId: string; runId: string; chatId: string }>) => void })`: called after any write that removed Runs carrying a `chatId` (trim, `remove`, purge), with those Runs. Errors in the callback are logged, like `told`.
  - `finishRun(runId, { status, summary, error, chatId, title })`: `title` saved on the Run
  - `setRunTitle(runId: string, title: string): boolean`: sets `title` on a finished Run; false when the Run is gone
  - `hasRun(runId: string): boolean` (from `runIndex`)
  - `readOnly(): string | null` exposed (the existing `readOnly` reason)

- [ ] **Step 1: Write failing tests**

```js
test("acted Runs keep their own 50, so quiet Runs can't push them out", () => {
  // 1 acted Run then 60 quiet Runs: the acted Run is still there; quiet Runs are trimmed to 50.
});
test("onRunsDropped hears the Runs a trim, a delete and a purge took, with their Chats", () => {
  // trim: the 51st acted Run drops the oldest, reported with its chatId
  // remove(routineId): every Run with a chatId is reported
  // purge after 30 days: same
  // Runs without a chatId are never reported
});
test("finishRun and setRunTitle save a Run's title", () => { /* both paths, setRunTitle on a missing Run is false */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/core/src/routines/store.test.cjs`
Expected: FAIL on the three new tests

- [ ] **Step 3: Implement**

`trimRuns`: a fourth counter, `actedOver = -MAX_RUNS_KEPT`, for `status === "acted"`; `restOver` now counts quiet and failed. In `transact`, when `tx.changed`, collect Runs with a `chatId` whose id is in `data` (before) but not in `draft` (after), and call `onRunsDropped` after `publish`, next to `told(purgedIds)`. Load-time purge reports through the same path. `finish` copies `extra.title` like `summary`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/core/src/routines/store.test.cjs`
Expected: PASS (all, old bucket tests updated for the split)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routines/store.cjs packages/core/src/routines/store.test.cjs
git commit -m "feat(routines): Run titles, own bucket for acted Runs, dropped-Run hook"
```

### Task 3: Run Chats start hidden and are named when their Run ends

**Files:**
- Modify: `packages/core/src/agents/chat-host.cjs:274-298` (`emptyChat`)
- Modify: `packages/core/src/routines/runtime-adapter.cjs:180-218` (`startChat`), `routineChats` return (~:330), `createRoutines` deps (:399)
- Modify: `packages/core/src/routines/scheduler.cjs:482-506` (turn end in `observe`)
- Modify: `packages/core/src/chat-title.cjs` (new export)
- Modify: `packages/core/src/runtime.cjs:1115` (pass the generator)
- Test: `runtime-adapter.test.cjs` (:336-357, :410-445), `scheduler.test.cjs`, `chat-title.test.cjs`, `runtime-routines.test.cjs` (:346-377), `chat-host.test.cjs:989`

**Interfaces:**
- Consumes: `finishRun(..., { title })`, `setRunTitle` (Task 2)
- Produces:
  - `emptyChat(projectPath, worktreeId, { origin, title, generatedTitle, fresh })`: `origin` saves `routine: { routineId, runId, hidden: true }`; `generatedTitle` saved like `title`
  - `generateRunTitle({ reply: string, provider }, { models, timeoutMs })` in `chat-title.cjs`: same shape and limits as `generateChatTitle`, system prompt naming what a scheduled run did from its final reply (wrapped in `<final_reply>` tags, data only)
  - `createRoutines({ ..., generateRunTitle: ({ reply, provider }) => Promise<string | null> })`
  - routineChats adds `nameRun(chatId: string, runId: string, { quietSummary?: string }): Promise<void>`

- [ ] **Step 1: Write failing tests**

- `runtime-adapter.test.cjs`: a schedule Run's Chat has `routine.hidden === true`, no `title`, `generatedTitle === "Morning triage"`; a Linear Run's Chat keeps `title === "MIL-1 Paste images"` and `routine.hidden === true`.
- `scheduler.test.cjs`: an acted Run in a new Chat calls `chats.nameRun(chatId, runId, {})`; a quiet one calls it with `{ quietSummary: "CI green" }`; a failed one doesn't call it.
- `runtime-routines.test.cjs`: with a stub `generateRunTitle` returning `"Fixed flaky sidebar test"`, an acted Run ends with `run.title` and the Chat's `generatedTitle` set to it; a Chat the user renamed keeps its `title` and its `generatedTitle` is untouched. With the stub returning null, `run.title` stays unset and the Chat keeps "Morning triage". A heartbeat's acted beat gets `run.title`, its Chat's titles untouched. A quiet Run's `run.title` is the summary's first line, cut at 60.
- `chat-title.test.cjs`: `generateRunTitle` returns null on empty reply, missing model, timeout, over-60 title; returns the title from valid JSON.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/core/src/routines/runtime-adapter.test.cjs packages/core/src/routines/scheduler.test.cjs packages/core/src/runtime-routines.test.cjs packages/core/src/chat-title.test.cjs`
Expected: FAIL on the new assertions

- [ ] **Step 3: Implement**

`startChat` passes `title` only for a Linear Run and `generatedTitle: routine.name` otherwise. In the scheduler's turn end, after `finish(...)`, call `track(chats.nameRun(chatId, entry.runId, quiet ? { quietSummary: summary } : {}))` for acted and quiet Runs (new Chat or heartbeat). `nameRun`: quiet → title from the summary; acted → `generateRunTitle({ reply: replyText(chatId), provider: session.provider })`; then `store.setRunTitle`; then, when the Chat's `routine.runId === runId` and it has no `title`, patch `generatedTitle` through the Chat host's state update (the same path `emptyChat` uses). Errors are logged and swallowed. `runtime.cjs` builds `generateRunTitle` from the same `models` `ChatTitles` uses.

- [ ] **Step 4: Run tests to verify they pass**

Same command. Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(routines): Run Chats start hidden and take a title from what the Run did"
```

### Task 4: Keeping Run Chats and sweeping dropped ones

**Files:**
- Modify: `packages/core/src/runtime.cjs` (`chat:send` :1343, `chat:patch` :1398, project open :480, `createRoutines` call :1115, `routines:targets` :1178-1192)
- Modify: `packages/core/src/routines/runtime-adapter.cjs` (`createRoutines` create/update :585-605, new `sweepRunChats`)
- Modify: `packages/core/src/routines/tools.cjs` (heartbeat_create, routine_create/update with a chat target)
- Test: `packages/core/src/runtime-routines.test.cjs`, `packages/core/src/routines/tools.test.cjs`

**Interfaces:**
- Consumes: `onRunsDropped`, `hasRun`, `readOnly` (Task 2); `routine.hidden` (Tasks 1, 3)
- Produces:
  - runtime `keepRunChat(projectPath: string, sessionId: number): Promise<void>`: sets `routine.hidden = false` when it is true; no-op otherwise
  - `createRoutines({ ..., keepChat: (chatId: string) => Promise<void>, chatMessages: (projectPath, sessionIds) => Promise<ChatMessage[]> })`
  - `routines.sweepRunChats(projectPath: string, state: CoordinatorState): Promise<void>`
  - `createRoutineTools({ ..., keepChat })`

- [ ] **Step 1: Write failing tests**

In `runtime-routines.test.cjs`:
- `chat:send` into a hidden Run Chat sets `hidden: false`; a send through the MCP `chat_start` path leaves it hidden.
- `chat:patch` with `{ pinned: true }` or `{ title: "Mine" }` un-hides; `{ unread: false }` doesn't; MCP `updateChat` with a title doesn't.
- Creating a Heartbeat on a hidden Run Chat (form and `heartbeat_create`) un-hides it.
- Sweep on open, legacy Chat (`routine` without `hidden`): pinned → `hidden: false`; a Heartbeat target → `false`; a plain user message after the Run's first message → `false`; only the Run's first message and replies → `true`.
- Sweep archives a hidden Run Chat whose Run is gone; leaves a kept one, one whose Run is still in the store, and a heartbeat's own Chat whose beat Runs were dropped.
- Deleting a Routine archives its hidden Run Chats in an open Project; one in a closed Project is archived the next time that Project opens.
- A store that opened read-only archives nothing.
- `routines:targets` leaves hidden Run Chats out of the Heartbeat Chat picker and lists kept ones.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/core/src/runtime-routines.test.cjs packages/core/src/routines/tools.test.cjs`
Expected: FAIL on the new tests

- [ ] **Step 3: Implement**

`keepRunChat` patches through `editProject` (as `patchChat` does). `chat:send` calls it when `request.sessionId != null`, after the send is accepted. `chat:patch` calls it when the patch sets `pinned: true` or a non-empty `title`; MCP `updateChat` keeps calling `patchChat` directly and is unaffected. `sweepRunChats`: skip entirely when `store.readOnly()`; for each unarchived session with `routine`: legacy (`hidden === undefined`) decides and saves `hidden` (pinned, Heartbeat target via `store.list()`, or a user-role message after the first one whose context isn't a Routine Run per `routineRunOf`); then a `hidden === true` Chat whose `routine.runId` fails `store.hasRun` is archived with `archiveChat`. `routines:targets` skips Chats where `isHiddenRunChat(session)`. Run the sweep at project open next to `chatTitles.resume`, and from `onRunsDropped` for each dropped Chat's Project that is in `scopeStates` (closed Projects are swept when they open).

- [ ] **Step 4: Run tests to verify they pass**

Same command, then `node --test packages/core/src/routines/*.test.cjs`. Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(routines): keep Run Chats Victor takes over, archive ones whose Run is gone"
```

### Task 5: Desktop lists, Routines dot

**Files:**
- Modify: `apps/desktop/app/src/App.tsx:827-833` (open Project list), `apps/desktop/app/src/lib/sidebar-scopes.ts:81-98`
- Modify: `apps/desktop/app/src/components/SidebarNav.tsx:1044-1056` (Routines button)
- Modify: `apps/desktop/app/src/components/routines/RoutineRow.tsx` (delete confirmation copy, unread dot)
- Test: `apps/desktop/app/src/lib/sidebar-scopes.test.ts`, `apps/desktop/app/src/lib/chat-list.test.ts`

**Interfaces:**
- Consumes: `isListedChat(session, count, waiting)`, `hiddenRunChats` (Task 1)
- Produces: `RoutineRow` prop `unread?: boolean`; SidebarNav prop `routinesUnread?: boolean`

- [ ] **Step 1: Write failing tests**

`sidebar-scopes.test.ts`: `scopeChats` leaves a hidden Run Chat out, and lists it when its key is in `waiting` or `asking`. Same for the open-Project list helper in `chat-list.test.ts` (or the function App uses there; pass `waiting` from the Chat's run having approvals or questions).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test apps/desktop/app/src/lib/sidebar-scopes.test.ts apps/desktop/app/src/lib/chat-list.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Pass `waiting` into `isListedChat` in both lists. App computes `hiddenRunChats` over the open Project's state plus `scopeStates`, and passes `routinesUnread = some(unread)` to SidebarNav, which draws a small accent dot on the Routines button (top right of the icon, as other unread dots are drawn). The Routines page passes `unread` per Routine to `RoutineRow`, which shows the same dot after the title. Delete confirmation: "Its Runs stop, and its Run Chats you haven't kept are archived."

- [ ] **Step 4: Run tests to verify they pass**

Same command, then `npm run typecheck --workspace milagre`. Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/app/src
git commit -m "feat(desktop): hide Run Chats from the sidebar, dot on Routines"
```

### Task 6: Desktop Routine page and Chat chip

**Files:**
- Create: `apps/desktop/app/src/components/routines/RoutinePage.tsx`, `apps/desktop/app/src/components/routines/RunList.tsx`
- Modify: `apps/desktop/app/src/components/routines/RoutinesPage.tsx` (row click opens a Routine), `RoutineRow.tsx` (clickable row; ⋯ menu unchanged)
- Modify: `apps/desktop/app/src/App.tsx` (`view === "routines"` holds an optional Routine id; an `openRoutine(id)` action)
- Modify: the Chat header (the component that renders the Chat title bar; find it from `ChatComposer.tsx:1147`'s parent) for the chip
- Modify: `packages/shared/src/routines.mjs`, `routines.d.mts` (run row text helpers, shared with the phone)
- Test: `packages/shared/src/routines.test.mjs`

**Interfaces:**
- Consumes: `foldRuns`, `runTitle`, `hiddenRunChats` (Task 1); `RoutineWithRuns` with `runs[].title`
- Produces:
  - `RoutinePage({ routine, models, unreadChats: Set<string>, onBack, onEdit, onOpenChat })`
  - `runWhen(at: number, now: number): string` in `packages/shared/src/routines.mjs`: "Today 10:15", "Yesterday 09:00", "Oct 16 09:00" (times from the existing `clock`)
  - `foldText(counts, last): string` in the same file: "5 quiet · 2 skipped · last 10:30" (parts with a zero count left out; "missed", "refused" words)
  - App `openRoutine(routineId: string)`: sets `view = "routines"` and the selected Routine

- [ ] **Step 1: Write failing tests**

`routines.test.mjs`: `runWhen` for today, yesterday, an older date; `foldText({ quiet: 5, skipped: 2, missed: 0, refused: 0 }, at)` is `"5 quiet · 2 skipped · last 10:30"`; `foldText({ quiet: 0, skipped: 0, missed: 1, refused: 3 }, at)` is `"1 missed · 3 refused · last 10:30"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/shared/src/routines.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement**

Page layout per the spec's "The Routine page": back button, header (icon tile, name, meta line, switch, Run now, Edit, ⋯ Delete), "Runs" heading, then `foldRuns(routine.runs)` rendered in the Routines page's card style (`divide-y divide-line rounded-xl border`). Run rows: status icon (Hugeicons: spinner for running, check for acted, alert for failed), `runTitle`, `runWhen`, unread dot when `unreadChats` has the Run's `chatId`; click opens `chatId` when present. Failed rows add the error's first line. A fold is one row that expands in place to its Runs: quiet shows `summary`, skipped "Its Chat was busy", missed "This Mac missed its time", refused the `error`. Empty: "No runs yet" plus "Next run HH:MM" when `nextRunAt` is set. The Chat header shows a chip with the Routine's name for a Chat with `session.routine` or one a Heartbeat targets (`heartbeatKeys`), calling `openRoutine`.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test packages/shared/src/routines.test.mjs && npm run typecheck --workspace milagre`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/app/src packages/shared/src
git commit -m "feat(desktop): Routine page with its Runs, Routine chip on Run Chats"
```

### Task 7: Phone

**Files:**
- Modify: `apps/mobile/src/project-navigation.tsx:296-320` (list), `:536-546` (Link picker), `:661` (dock button dot)
- Create: `apps/mobile/src/app/routine.tsx` (Routine screen), register it in `apps/mobile/src/app/_layout.tsx` like `routines`
- Modify: `apps/mobile/src/app/routines.tsx` (row tap pushes `/routine?id=`), delete confirmation copy
- Modify: `apps/mobile/src/app/chat.tsx:1066-1082` (button shows for Run Chats too and opens `/routine`)
- Test: a new `apps/mobile/src/project-navigation` list test if the file's filtering is extractable; otherwise extract the filter into a pure function in `apps/mobile/src/chat-list-filter.ts` with `node --test` coverage

**Interfaces:**
- Consumes: `isListedChat`, `isHiddenRunChat`, `foldRuns`, `runTitle`, `hiddenRunChats` (Task 1); `runWhen`, `foldText` (Task 6, in `@milagre/shared/routines`)
- Produces: route `/routine` with param `id`

- [ ] **Step 1: Write failing test**

Extracted filter: a hidden Run Chat with a live `run` that has no approvals or questions is left out; with a pending approval it shows; a kept one with a live run shows.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/mobile/src/chat-list-filter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

The list and the Link picker both check `!isHiddenRunChat(chat, waiting)` before the `run ||` bypass, with `waiting` from the run's approvals or questions. The Routine screen mirrors the desktop page with `PageScroll`, `ListRow`s and `RowSwitch`; Edit in the toolbar opens `/routine-form?id=`. The dock Routines `IconButton` shows the app's unread dot when `hiddenRunChats` over the loaded Projects has an unread one. The Chat screen's routine button shows for a Run Chat or a Heartbeat Chat and pushes `/routine?id=`.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test apps/mobile/src/chat-list-filter.test.ts && npm run typecheck:mobile && npx oxlint apps/mobile`
Expected: PASS, no lint errors

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): Routine screen, Run Chats out of the list"
```

### Task 8: Glossary, full checks, real-app QA, PR

**Files:**
- Modify: `GLOSSARY.md` (Routines section: **Run Chat**)

- [ ] **Step 1: Glossary**

Add under Routines: "**Run Chat**: A **Chat** a **Run** opened. It lives in its **Routine**'s Runs list, out of the sidebar, until you send it a message, pin it or rename it."

- [ ] **Step 2: Full checks**

Run: `npm run typecheck && npm run typecheck:mobile && npm run lint && npm run format:check && npm run test:unit`
Expected: all pass

- [ ] **Step 3: Real-app QA (desktop)**

Dev copy per the memory recipes (own Vite and CDP ports, temp profile, throwaway repo; never touch the running Milagre). Make a schedule Routine with a new-Chat target, Run now twice: no new sidebar rows, the Routines button shows a dot, the Routine page lists both Runs with generated titles, opening one works, sending a message moves it into the sidebar. Screenshot each to the `screenshots` branch.

- [ ] **Step 4: Phone QA**

Simulator per the slim-simulator rule, dev build against the dev copy's daemon: the list has no Run Chats, the Routine screen lists Runs, the Chat button opens it. Screenshots to the `screenshots` branch.

- [ ] **Step 5: PR**

Push the branch, open the PR against `main` titled "feat: Run Chats live in their Routine" with "Closes #532", the screenshots, and a note that the phone part ships as an OTA after merge.
