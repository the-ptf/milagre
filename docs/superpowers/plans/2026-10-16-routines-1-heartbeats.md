# Routines PR 1: heartbeats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents can set a heartbeat on their own Chat: a cron prompt that the daemon sends back into that Chat. Each beat shows as a divider. A beat whose reply starts `(pass)` collapses into one quiet line with no push.

**Architecture:**
- A daemon-level store (`routines.json` in `dataDir`) and a 1 s scheduler in `packages/core/src/routines/`. Both are wired in `runtime.cjs` next to the plan tools.
- Beats go through `ChatHost.send` with a new `routine-run` context. The scheduler watches `publishAgentEvent` for the turn's end, classifies it, and marks quiet turns on the terminal event so phone and desktop pushes skip them.
- Gated by a host-owned Experimental flag, as `limit-switch.cjs` is.

**Tech Stack:** Node 24 CommonJS (`packages/core`), TypeScript/ESM shared (`packages/shared`), React desktop, Expo phone, `node:test`, zod. No new dependency: the cron parser is hand-written.

**Spec:** `docs/superpowers/specs/2026-10-16-routines-design.md`

## Global Constraints

- Every heartbeat ends. No "never". Agent-created heartbeats default to `expiresIn` 7 days unless `maxRuns` or `expiresIn` is given.
- A heartbeat that fires while its Chat has a turn running, or one waiting on an approval or question, records `skipped-busy` and sends nothing.
- Missed slots (daemon down, Mac asleep) are not replayed. Record one `missed` Run, then advance past now.
- On start, a Run left `running` becomes `failed` with error `"daemon restarted"`.
- A reply whose first non-space text is `(pass)` (any case) is quiet. The summary is the rest of that first line, trimmed, capped at 80 characters. A quiet turn sends no completion push on phone or desktop.
- Keep the last 50 Runs per Routine.
- The cron is five fields with an IANA timezone. `every` accepts `Nm` and `Nh` with N ≥ 1 and compiles to cron. Minimum cadence is 1 minute.
- Routines are this Mac's only. Every `routines:*` RPC goes in `peer-policy.cjs` `DENIED`. Phones paired to this Mac still reach them through the mobile bridge allowlist.
- The flag is off by default. While off, there are no routine tools and no ticks.
- No em or en dashes in user-facing copy. Divider copy:
  - acted: `Heartbeat · 10:15`
  - quiet: `10:30 · quiet: <summary>`
  - merged: `3 quiet checks · last 10:30: <summary>`

## Review Focus

1. **Waiting counts as busy.** A beat fires while the Chat waits on a permission prompt. Expected: `skipped-busy`, not a steer into the waiting turn. Test in Task 4.
2. **Archived target.** The Chat is archived while the heartbeat is on. Expected: the heartbeat completes and keep-awake releases. Test in Task 4.
3. **Daylight saving.** A cron in `America/Sao_Paulo` or `Europe/Lisbon` across a DST change. Expected: no double fire, no skipped day for a daily `30 8 * * *`. Test in Task 2.
4. **Restart between claim and send.** The daemon dies after claiming a slot. Expected: one `failed` Run, and no second send of that slot after restart. Test in Task 4.
5. **What counts as pass.** Replies like `**(pass)** CI green`, `  (Pass) waiting`, and `CI failed, so no (pass) today`. Expected: the first two are quiet with summaries `CI green` and `waiting`; the third acted. Test in Task 1.

---

### Task 1: Shared routine types and helpers

**Files:**
- Modify: `packages/shared/src/model.ts` (the `ChatContext` union near `:308`; `turn-completed` near `:614`)
- Create: `packages/shared/src/routines.mjs`, `packages/shared/src/routines.d.mts`
- Modify: `packages/shared/package.json` (exports map: `"./routines"`)
- Test: `packages/shared/src/routines.test.mjs`

**Interfaces:**
- Produces (`model.ts`):
  ```ts
  type RoutineTrigger = { kind: "schedule"; cron: string; timezone: string };   // PR 3 adds "linear", PR 4 "webhook"
  type RoutineTarget = { kind: "chat"; chatId: string };                       // PR 3 adds "new-chat"
  type RoutineRunStatus = "running" | "acted" | "quiet" | "failed" | "skipped-busy" | "missed";
  interface Routine { id: string; name: string; prompt: string; trigger: RoutineTrigger; target: RoutineTarget;
    provider?: ModelProvider; model?: string; permissionMode?: string; enabled: boolean;
    createdBy: { kind: "agent"; chatId: string } | { kind: "user" };
    maxRuns?: number; expiresAt?: number; nextRunAt?: number | null; lastRunAt?: number; runCount: number;
    completedAt?: number; createdAt: number; updatedAt: number }
  interface RoutineRun { id: string; routineId: string; scheduledFor?: number; startedAt: number; endedAt?: number;
    status: RoutineRunStatus; chatId?: string; summary?: string; error?: string }
  type RoutineRunContext = { kind: "routine-run"; routineId: string; runId: string; name: string; at: number;
    quiet?: boolean; summary?: string };
  ```
  - Add `RoutineRunContext` to `ChatContext`.
  - Change `turn-completed` to `{ type: "turn-completed"; quiet?: boolean }`.
- Produces (`routines.mjs`):
  - `isRoutineRun(message): boolean`
  - `parsePass(text: string): { quiet: true; summary: string } | { quiet: false }`. Strips leading whitespace, `*` and `_` before matching `(pass)` case-insensitively.
  - `routineRunText(context, timeZone?): string`. The divider copy from Global Constraints. Times as `HH:MM` in the given zone.
  - `groupQuietRuns(messages): Array<{ message, hidden?: true, merged?: { count: number; last: RoutineRunContext } }>`. Hides the assistant reply that follows a quiet divider. Merges back-to-back quiet dividers into the last one, with `count`.

- [ ] **Step 1: Write the failing tests** in `routines.test.mjs`:
  - `parsePass("(pass) CI green")` → `{ quiet: true, summary: "CI green" }`
  - `parsePass("**(pass)** CI green")` → `{ quiet: true, summary: "CI green" }`
  - `parsePass("  (Pass) waiting\nmore")` → `{ quiet: true, summary: "waiting" }`
  - `parsePass("CI failed, so no (pass) today")` → `{ quiet: false }`
  - `parsePass("(pass) " + "x".repeat(200)).summary.length === 80`
  - `routineRunText({ at: Date.UTC(2026,9,16,13,15), name: "Babysit", quiet: false, ... }, "UTC")` === `"Heartbeat · 13:15"`
  - The quiet form gives `"13:30 · quiet: CI green"`.
  - `groupQuietRuns` on `[userMsg, quietDivider1, reply1, quietDivider2, reply2, actedDivider3, reply3]`:
    - `reply1` and `reply2` come back hidden
    - `quietDivider1` hidden
    - `quietDivider2` merged with count 2
    - `actedDivider3` and `reply3` shown
- [ ] **Step 2: Run** `node --test packages/shared/src/routines.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the types, helpers, `.d.mts` declarations and the exports map entry. Follow `chat-reload.mjs` and `chat-reload.d.mts`.
- [ ] **Step 4: Run** the same command plus `npm run typecheck --workspace @milagre/shared`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** with `git commit -m "feat(shared): routine types and divider helpers"`.

### Task 2: Cron parser and next-run

**Files:**
- Create: `packages/core/src/routines/cron.cjs`
- Test: `packages/core/src/routines/cron.test.cjs`
- Modify: `packages/core/package.json` test script (add `src/routines/*.test.cjs`)

**Interfaces:**
- Produces:
  - `parseCron(expr: string): { minute, hour, dayOfMonth, month, dayOfWeek }`. Each field is a `Set<number>`. Supports `*`, lists, ranges and `*/n` and `a-b/n` steps. `dayOfWeek` is 0 to 7, with 7 meaning 0. Throws `Error("Invalid cron: <reason>")`.
  - `everyToCron(every: string): string`:
    - `"15m"` → `"*/15 * * * *"`
    - `"2h"` → `"0 */2 * * *"`
    - Rejects `0m`, minute values above 59 that don't divide 60, and anything else, with `Invalid every`.
  - `nextRun(expr: string, timeZone: string, after: number): number`. The first whole minute strictly after `after` whose wall-clock fields in `timeZone` match. Day-of-month and day-of-week combine with OR when both are restricted, as in standard cron. Uses `Intl.DateTimeFormat` with `timeZone`. Scans minute by minute, capped at 366 days, then throws `No run within a year`. Throws on an unknown timezone.

- [ ] **Step 1: Write the failing tests:**
  - `nextRun("*/15 * * * *", "UTC", Date.UTC(2026,9,16,10,31))` === `Date.UTC(2026,9,16,10,45)`
  - `nextRun("30 8 * * 1-5", "America/Sao_Paulo", <Friday 09:00 local>)` → Monday 08:30 local
  - **DST:** daily `30 8 * * *` in `Europe/Lisbon` across 2026-10-25. Three successive `nextRun` calls give three dates, each 08:30 local, one day apart.
  - **DST gap:** `30 1 * * *` in `Europe/Lisbon` on 2026-03-29 (the 01:00 to 02:00 gap). The next run is 2026-03-30 01:30, with no throw.
  - `parseCron("61 * * * *")` throws `/Invalid cron/`. So do `parseCron("* * *")` and `nextRun(..., "Mars/Base", ...)`.
  - `everyToCron("15m")` === `"*/15 * * * *"`. `everyToCron("0m")` throws.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/cron.test.cjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `cron.cjs`. Paseo's `packages/protocol/src/schedule/cron-expression.ts` is a reference for shape only; write it from scratch.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(core): cron parser for routines"`.

### Task 3: Routine store

**Files:**
- Create: `packages/core/src/routines/store.cjs`
- Test: `packages/core/src/routines/store.test.cjs`

**Interfaces:**
- Consumes: `nextRun` and `everyToCron` (Task 2), and the types from Task 1.
- Produces: `createRoutineStore({ file, now = Date.now, id = () => crypto.randomBytes(4).toString("hex") })`, which returns:
  - `enabled(): boolean`, `setEnabled(value: boolean): boolean`
  - `list(): Routine[]`. Routines that are not completed, newest first.
  - `get(id): Routine | null`, `runs(id): RoutineRun[]` (newest first, at most 50)
  - `upsertHeartbeat({ chatId, name, prompt, cron?, every?, timezone, maxRuns?, expiresIn?, provider?, model?, permissionMode?, createdBy }): Routine`.
    - Matches an existing Routine by `name` plus `target.chatId`. A match is replaced in place: same id, `runCount` kept.
    - Sets the default expiry of 7 days when neither `maxRuns` nor `expiresIn` is given.
    - `expiresIn` takes `"30m"`, `"6h"` or `"7d"`.
    - Computes `nextRunAt`.
  - `update(id, patch): Routine`. Allowed keys: `name`, `prompt`, `cron`, `timezone`, `maxRuns`, `expiresAt` and `enabled`. Recomputes `nextRunAt`.
  - `remove(id): boolean`
  - `claimDue(at: number): Array<{ routine: Routine; run: RoutineRun }>`.
    - For each enabled, uncompleted Routine with `nextRunAt <= at`, it appends a `running` Run with `scheduledFor = nextRunAt` and advances `nextRunAt` to `nextRun(cron, tz, at)`.
    - All in one atomic write.
    - A Routine whose `nextRunAt` is older than `at - 60_000` gets a `missed` Run for that slot instead of a `running` one, and isn't returned.
  - `finishRun(runId, { status, summary?, error?, chatId? }): Routine | null`.
    - Sets `endedAt`.
    - Increments `runCount` for `acted`, `quiet` and `failed`.
    - Marks the Routine completed when `runCount >= maxRuns`.
  - `complete(id, reason: string)`: sets `completedAt` and `enabled = false`.
  - `expireDue(at)`: completes Routines whose `expiresAt <= at`.
  - `recoverInterrupted()`:
    - Turns every `running` Run into `failed` / `"daemon restarted"`.
    - Advances overdue `nextRunAt` past `now()` without recording a missed Run for them.
- The file is `{ version: 1, enabled: false, routines: Routine[], runs: Record<id, RoutineRun[]> }`. It is written atomically (temp file plus rename), as `limit-switch.cjs` does.

- [ ] **Step 1: Write the failing tests**, using a temp-dir file and a fake `now`:
  - `upsertHeartbeat` twice with the same name and chatId leaves one Routine with the same id and the second prompt.
  - With no limits, `expiresAt === now + 7*864e5`.
  - `claimDue` at `nextRunAt` returns one claim, and `nextRunAt` moves to the next slot.
  - Calling `claimDue` again at the same instant returns `[]`.
  - `claimDue` at `nextRunAt + 5*60_000` returns `[]` and records one `missed` Run.
  - `finishRun` up to `maxRuns: 2` completes the Routine. `list()` no longer has it.
  - `recoverInterrupted()` turns a `running` Run into `failed` with `error === "daemon restarted"`.
  - 60 finished runs keep 50.
  - A store re-created on the same file reads back the same Routines, so the write is durable.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/store.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `store.cjs`. Reads are synchronous and cached in memory; every mutation rewrites the file.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(core): routine store"`.

### Task 4: Heartbeat scheduler

**Files:**
- Create: `packages/core/src/routines/scheduler.cjs`
- Modify: `packages/core/src/keep-awake.cjs` (one new method)
- Test: `packages/core/src/routines/scheduler.test.cjs`, plus a case in `packages/core/src/keep-awake.test.cjs`

**Interfaces:**
- Consumes: the store (Task 3), and `parsePass` and the types (Task 1).
- Produces:
  - `KeepAwake#setRoutinesActive(active: boolean)`. While it is true, `sync()` treats the daemon as busy.
  - `createRoutineScheduler({ store, chats, keepAwake, now = Date.now, setInterval, clearInterval, onChange = () => {} })`, which returns `{ start(), stop(), tick(): Promise<void>, observe(chatId, event): void, chatArchived(chatId): void, runNow(id): Promise<RoutineRun> }`.
  - `chats` is an adapter that runtime builds in Task 6:
    ```ts
    { exists(chatId): boolean; archived(chatId): boolean;
      busy(chatId): boolean;                 // turn open, preparing, or approvals/questions pending
      send(chatId, { body, prompt, context }): Promise<{ started: Promise<{ turnId } | null> }>;
      replyText(chatId): string }            // the streaming text of the turn that just ended
    ```
- **Behavior:**
  - `start()`:
    - Calls `store.recoverInterrupted()`.
    - Completes heartbeats whose Chat is gone or archived.
    - Sets keep-awake from "any enabled Routine".
    - Ticks every 1000 ms (`timer.unref?.()`).
    - Does nothing while `store.enabled()` is false.
  - `tick()`:
    - Calls `store.expireDue(now())`, then takes `store.claimDue(now())`.
    - For each claim:
      - **Target gone:** `complete` it, and finish the Run `failed` / `"chat gone"`.
      - **Busy:** finish `skipped-busy`.
      - **Otherwise:** `chats.send` with `body` = the prompt, `prompt` = the prompt plus the line `\n\nIf nothing needs doing, reply starting with "(pass)" and a short reason.`, and `context` = a `RoutineRunContext` with `at = now()`. Remember `chatId → runId`.
      - A send that throws finishes `failed` with the error message.
    - Calls `onChange()` when anything changed.
  - `observe(chatId, event)`:
    - For a Chat with a pending run, on `isTurnEnd(event)`:
      - `turn-completed` → `parsePass(chats.replyText(chatId))`. Quiet sets `event.quiet = true` (mutating, before broadcast) and finishes `quiet` with the summary. Otherwise it finishes `acted`.
      - `turn-failed` → `failed` with `event.message`.
      - `turn-cancelled` → `failed` / `"cancelled"`.
    - It also calls `chats.patchRunContext(chatId, runId, { quiet, summary })`. Add that to the adapter: it patches the divider message's context.
  - `chatArchived(chatId)`: completes that Chat's heartbeats.

- [ ] **Step 1: Write the failing tests** with fake `chats`, a fake store file in a temp dir, and a manual clock:
  - **Due beat:**
    - one `send` with `context.kind === "routine-run"`
    - `body` equals the prompt
    - `prompt` ends with the `(pass)` instruction
  - **Busy:** with `busy()` → true, no `send`, and the Run status is `skipped-busy`.
  - **Waiting:** with `busy()` → true because of a pending approval, the same `skipped-busy` result. Review Focus 1.
  - **Quiet turn:**
    - `observe(chatId, {type:"turn-completed"})` with `replyText` `"(pass) CI green"`
    - the event object now has `quiet: true`
    - the Run is `quiet` with summary `"CI green"`
    - `patchRunContext` was called with `{ quiet: true, summary: "CI green" }`
  - **Acted turn:** the Run is `acted`, and the event has no `quiet`.
  - **Archived:** with `archived()` → true, `start()` completes the heartbeat, and keep-awake reports inactive. Review Focus 2.
  - **Restart:** after a claim with no `observe` (simulated crash), a new scheduler's `start()` leaves exactly one `failed` Run, and the next `tick()` at the same time sends nothing. Review Focus 4.
  - **Disabled:** with `store.setEnabled(false)`, `tick()` sends nothing.
  - **KeepAwake:** `setRoutinesActive(true)` with no turns starts the blocker; `false` stops it.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/scheduler.test.cjs packages/core/src/keep-awake.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `scheduler.cjs` and `setRoutinesActive`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(core): heartbeat scheduler"`.

### Task 5: Agent tools

**Files:**
- Create: `packages/core/src/routines/tools.cjs`
- Modify: `packages/core/src/agents/permissions.cjs` (`:176`, widen `PLAN_TOOLS`), `packages/core/src/agents/permissions.test.cjs` (`:58-59`, `:87`), `packages/core/src/agents/steps.cjs` (friendly titles)
- Test: `packages/core/src/routines/tools.test.cjs`

**Interfaces:**
- Consumes: the store (Task 3), and `scheduler.runNow` (Task 4).
- Produces:
  - `ROUTINE_TOOL_NAMES = ["routine_list", "heartbeat_create", "routine_update", "routine_delete", "routine_run_now"]`
  - `createRoutineTools({ store, scheduler, chatSettings: (chatId) => ({ provider, model, permissionMode }) | null, defaultTimezone: () => string })`, which returns `{ definitions(chatId) }` in the `chat-plan-tools.cjs` shape. Flat zod; no `$ref`.
- **Tool contracts:**
  - `heartbeat_create { name: string ≤80, prompt: string ≤4000, cron?: string, every?: string, timezone?: string, maxRuns?: int 1..1000, expiresIn?: string }`
    - Exactly one of `cron` or `every`, otherwise an error naming both.
    - Targets `chatId`, with `createdBy: { kind: "agent", chatId }`, and copies `chatSettings(chatId)`.
    - Returns one line: `Heartbeat "<name>" set: every 15 min, next 10:45, ends <date or after N runs>. Reply "(pass) <reason>" on beats where nothing needs doing.`
    - Its description tells the agent to delete the heartbeat when the work is done (PR merged).
  - `routine_list {}`: one line per Routine in this Chat's Project, as `id · name · trigger · next · enabled`. For PR 1 that means heartbeats whose target Chat is in the same Project.
  - `routine_update { id, name?, prompt?, cron?, every?, timezone?, maxRuns?, expiresIn?, enabled? }`: limited to Routines in the caller's Project.
  - `routine_delete { id }`: the same Project limit.
  - `routine_run_now { id }`: the same Project limit.
- **Steps titles:** `steps.cjs` maps:
  - `heartbeat_create` → `Set heartbeat "<name>"`
  - `routine_delete` → `Stopped a routine`
  - every other routine tool → `Checked routines`
  - Same for the Codex and ACP equivalents.

- [ ] **Step 1: Write the failing tests:**
  - `heartbeat_create` with `every: "15m"` stores cron `*/15 * * * *` and the default expiry.
  - With both `cron` and `every`, it errors.
  - A second call with the same name updates the same id.
  - `routine_delete` of a Routine in another Project errors with `not found`.
  - `ROUTINE_TOOL_NAMES` are auto-approved: `isCodexPlanToolApproval` holds for `Allow the milagre MCP server to run tool "heartbeat_create"?`.
  - The steps test for the `heartbeat_create` title.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/tools.test.cjs packages/core/src/agents/permissions.test.cjs packages/core/src/agents/steps.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the tools, the permissions change and the steps titles.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(core): routine tools for agents"`.

### Task 6: Runtime wiring, commands, push suppression

**Files:**
- Modify: `packages/core/src/runtime.cjs` (near `:868-907` KeepAwake and `publishAgentEvent`; `:1384-1414` tools; `:1199` `chat:patch` archive; `:1835-1845` shutdown; commands next to `:1660`)
- Modify: `packages/core/src/agents/chat-host.cjs` (add `patchMessageContext`)
- Modify: `apps/daemon/src/mobile-bridge.cjs:48`, `apps/daemon/src/confine.cjs:125`, `apps/daemon/src/peer-policy.cjs` (`DENIED`), `apps/daemon/src/mobile-push.cjs` (`~251`), `apps/desktop/electron/notifications.cjs` (`:102`), `apps/desktop/electron/preload.cjs`, `apps/desktop/app/src/electron.d.ts`
- Test: `apps/daemon/src/mobile-push.test.cjs`, and an existing or new runtime-level test for the commands if one exists. Otherwise `packages/core/src/routines/runtime-wiring.test.cjs` with a minimal runtime harness. Copy the harness from the nearest existing runtime test.

**Interfaces:**
- Consumes: Tasks 3 to 5.
- Produces:
  - `ChatHost#patchMessageContext(projectPath, sessionId, match: (message) => boolean, patch: object): Promise<boolean>`. Modelled on `updateDivider` (`chat-host.cjs:730`), without the handoff checks.
  - Commands:
    - `routines:enabled:read` → `{ enabled }`
    - `routines:enabled:save(value)` → `{ enabled }`
    - `routines:list` → `{ routines: Array<Routine & { runs: RoutineRun[] }> }`
    - `routines:update(id, patch)`
    - `routines:delete(id)`
    - `routines:run-now(id)`
  - Event: `routines:changed`, emitted from the scheduler's `onChange` and from every command that writes.
- **Wiring:**
  - The store `file` is `path.join(dataDir, "routines.json")`.
  - `scheduler.observe(chatId, event)` runs first inside `publishAgentEvent`, before the broadcast, so `event.quiet` reaches every listener.
  - The tools are added to `extraTools` only when `store.enabled()`.
  - `chat:patch` with `archived: true` calls `scheduler.chatArchived(chatId)`.
  - `stop()` on shutdown.
  - The `chats` adapter:
    - `busy` = `chats.isBusy(chatId) || runs[chatId]?.approvals.length || runs[chatId]?.questions.length`
    - `send` uses the `advisorDelivery.send` pattern (`runtime.cjs:1478-1494`) with the `linked-worktrees.cjs` `turnOptions` fallback when `turnSettings` is null after a restart
    - `replyText` = `chats.runs[chatId]?.text ?? ""`, read before `chats.receive` folds the end event. Verify the order in a test. If the text is already cleared, read the last assistant message as `delegationReply` does.
- **Push:**
  - `mobile-push.cjs` skips `deliver()` for `turn-completed` with `quiet: true`.
  - `notifications.cjs` skips the completion notice for the same event.

- [ ] **Step 1: Write the failing tests:**
  - `mobile-push`: observing `turn-started` then `{type:"turn-completed", quiet:true}` delivers nothing; without `quiet` it delivers one.
  - A wiring test:
    - enable through `routines:enabled:save(true)`
    - call `heartbeat_create` through the Chat's tool list
    - advance the clock past `nextRunAt` and tick
    - the Chat gets a user message with `context.kind === "routine-run"`
  - `peer-policy`: `routines:list` is denied for a remote peer.
- [ ] **Step 2: Run** `npm test -- --unit --only routines` and `npm test -- --unit --only mobile-push`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring, commands, bridge allowlist and confine rules (`read: none`, writes `denied` for confined phones), the preload bridge and types, and the push skips.
- [ ] **Step 4: Run** `npm run test:unit`. Expected: PASS, with nothing else broken.
- [ ] **Step 5: Commit** with `git commit -m "feat: wire routines into the daemon"`.

### Task 7: Transcript dividers on desktop and phone

**Files:**
- Create: `apps/desktop/app/src/components/RoutineRunDivider.tsx`, `apps/mobile/src/routine-run-divider.tsx`
- Modify:
  - `apps/desktop/app/src/components/ChatComposer.tsx` (`:53`, `:174-179`)
  - `apps/desktop/app/src/components/LinkedMessage.tsx` (`linkedContext` exclusions)
  - `apps/mobile/src/app/chat.tsx` (`:51`, `:343-352`, `:1160-1170`)
  - `packages/core/src/agents/handover.cjs:44`
  - `scripts/mobile-ui.test.cjs` (`~:1795` mocks)
- Test: `scripts/mobile-ui.test.cjs`, and the desktop renderer test file for `ChatComposer` if one exists. Otherwise rely on Task 1's `groupQuietRuns` tests.

**Interfaces:**
- Consumes: `isRoutineRun`, `routineRunText` and `groupQuietRuns` (Task 1).
- Produces:
  - `RoutineRunDivider({ context, merged? })` on both platforms. It copies `ChatReloadDivider` (hairlines, 12 px ink-3 text, 13 px icon). The icon is Hugeicons `PulseRectangle01Icon` or the nearest pulse icon in `core-free-icons`; use the same icon on both.
  - The text is `routineRunText(context)`, or for a merge `` `${count} quiet checks · last ${HH:MM}: ${summary}` ``.

- [ ] **Step 1: Write the failing test** in `scripts/mobile-ui.test.cjs`. Rendering a Chat with `[routine-run quiet, assistant reply, routine-run quiet, assistant reply]` gives:
  - one element with accessibility label `2 quiet checks · last 10:30: CI green`
  - no reply text
- [ ] **Step 2: Run** `npm test -- --unit --only mobile-ui`. Expected: FAIL.
- [ ] **Step 3: Implement:**
  - Both dividers, and the branch in each transcript chain (before `isChatReload`).
  - Run the message list through `groupQuietRuns`.
  - The mobile navigation label.
  - The `handover.cjs` kind list: routine-run renders as `## <routineRunText>`.
  - Exclude `routine-run` from `linkedContext`.
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck && npm run typecheck:mobile`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: heartbeat dividers in the transcript"`.

### Task 8: Experimental switch on desktop and phone

**Files:**
- Modify: `apps/desktop/app/src/components/Settings.tsx` (`ExperimentalSettings` `:499-566`; a new `RoutinesSetting` next to `LimitAutoSwitchSetting` `:1597`), `apps/mobile/src/experimental-section.tsx` (`:79-105`, `:~231`)
- Test: `scripts/mobile-ui.test.cjs` (experimental section case), plus the desktop Settings test if one exists

**Interfaces:**
- Consumes: `routines:enabled:read/save` (Task 6).
- Produces:
  - A row titled `Routines`, described as `Let agents set heartbeats that check back on a Chat on a schedule.`
  - It is hidden until read (`null`, an older Mac), and saves optimistically with rollback, copying `LimitAutoSwitchSetting` and the mobile `Toggle`.

- [ ] **Step 1: Write the failing mobile test:**
  - the section shows `Routines` when the read returns `{ enabled: false }`
  - the row is hidden when the call rejects
  - toggling calls `routines:enabled:save` with `true`
- [ ] **Step 2: Run** `npm test -- --unit --only mobile-ui`. Expected: FAIL.
- [ ] **Step 3: Implement** both rows.
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck && npm run typecheck:mobile && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: Routines switch in Experimental settings"`.

### Task 9: Manual check and PR

- [ ] **Step 1:** Run a dev copy with its own data dir (memory note `milagre-qa-gotchas`: `env -u ELECTRON_RUN_AS_NODE`, throwaway repo cwd), then:
  1. Turn on Routines.
  2. In a Chat, ask the agent to `set a heartbeat every 1 minute for 3 runs: say (pass) ok`.
  3. Expected:
     - three dividers merge into `3 quiet checks · last HH:MM: ok`
     - no completion notification
     - the heartbeat is gone from `routines:list` after the third run
- [ ] **Step 2:** Repeat with a prompt that makes the agent act. Expected: a `Heartbeat · HH:MM` divider and a normal reply with a push.
- [ ] **Step 3:** Open a PR (no Claude attribution). The body links the spec, lists PRs 2 to 5 as follow-ups, and says the phone part ships by OTA after merge.

---

## Later plans (written when PR 1 lands)

Each gets its own `docs/superpowers/plans/2026-10-xx-routines-N-*.md`:
- **PR 2, desktop Routines UI:**
  - the Routines icon in the sidebar tools row
  - the Routines page (designs `routines-desktop`)
  - the New routine and Edit form for schedule heartbeats (`routines-new-sheet`) with `{{` autocomplete
  - the pulse mark on Chat rows
  - "Next check" under the last divider
  - the "Heartbeat set" card
- **PR 3, new-Chat triggers:**
  - the `new-chat` target (worktree or Project folder), and schedule triggers into fresh Chats
  - Linear polling: assigned, label added, state and comment events
  - the extended `linear-issue` context with `routine`, and untrusted-data fencing
  - `routine_create` and the no-recursion rule for routine-started Chats
  - up to 3 concurrent runs per event Routine, with a persisted queue
- **PR 4, relay webhooks:**
  - `POST /hook/<secret>` on the Worker
  - DO store-then-forward with a 24 h hold and a 256 KB cap
  - Mac persist-then-ack
  - optional HMAC
  - the URL card with Copy and Rotate
  - `{{body.*}}` placeholders
  - Deploy the relay before the release.
- **PR 5, phone UI:**
  - the Routines dock button and list (`routines-phone`)
  - the formSheet form (`routines-new-phone`), built from `ListRow`, `Button` and `HeaderButton`
  - the Chat header routine button (`routines-heartbeat-chat`)
  - OTA after merge if the fingerprint matches.
