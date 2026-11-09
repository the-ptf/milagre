# Babysit PRs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Chat opens a PR and Babysit PRs is on, the daemon adds a PR-triggered Heartbeat to that Chat, polls GitHub
cheaply, wakes the agent only on change, holds it to the chosen level, and stops on the user's rules. Settings live on a
sub-page under Settings › Experimental on desktop and phone.

**Architecture:** One global settings file in the daemon (`babysit.json`), read and written by desktop and phone over
daemon commands. A new Routine trigger kind `pull-request` targets an existing Chat. A PR poller (shaped like
`routines/linear-poller.cjs`) reads each watched PR with `gh`, diffs against a stored snapshot, and enqueues
`pull-request` events into the existing scheduler, which delivers them like Linear comments (defer while busy). A
per-turn guard denies shell commands the level doesn't allow.

**Tech Stack:** Node CommonJS daemon (`packages/core`, `node:test`), shared ESM (`packages/shared`), Electron + React +
Tailwind desktop (`apps/desktop`), Expo Router phone (`apps/mobile`), `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-27-babysit-prs-design.md`. Designs: canvas group Babysit PRs
(`babysit-settings`, `babysit-experimental-entry`).

## Global Constraints

- Defaults: enabled **off**; interval **1** minute (options 1, 2, 5, 10, 15, 30); wake for `comments`, `checks`,
  `conflicts` on and `behind` off; level **3** (Fix and push); resolveThreads **on**; stop green+approved **on**; stop
  watched-for **on, 7 days** (options 1, 3, 7, 14, 30); stop failed-same **off, 3** (options 2, 3, 5); own rule **off,
  ""**; instructions **""**.
- Merged or closed always stops. Every Heartbeat still ends by 30 days.
- Global only, no per-Project overrides. Milagre's prompt is never shown to the user.
- The level is enforced by Milagre, not only the prompt. `gh pr merge` is always denied in a babysit Run.
- Babysit Runs use the Chat's own permission mode.
- Agent replies carry the marker `<!-- milagre-babysit -->`; the poller ignores comments that contain it.
- Colors on the page bind to `--accent`, `--accent-tint`, `--accent-ink` (`bg-accent`, `bg-accent-tint`,
  `text-accent-ink`). No hard-coded colors.
- Copy follows GLOSSARY.md (Heartbeat, Run, Chat). Heartbeat name: `Babysit PR #<n>`.
- Desktop and phone ship in the same branch (AGENTS.md). Phone is OTA only: no native dependencies.
- No Claude attribution in commits or PRs.
- Checks: `npm run typecheck`, `npm run typecheck:mobile`, `npm run lint`, `npm run format:check`, `npm test -- --unit`.

## Review Focus

1. `gh` missing, logged out, or rate limited: the poller sets the Routine's `lastError` and backs off; no Run, no crash.
   (Task 5 test `read failure sets lastError and backs off`.)
2. A Chat runs `gh pr create` twice, or a loop: exactly one babysit Heartbeat per repo + number.
   (Task 7 test `second gh pr create for the same PR creates nothing`.)
3. Daemon restart or a sleeping Mac: the stored snapshot is the baseline, so old comments don't flood Runs after
   wake. (Task 5 test `restart reuses stored snapshot`.)
4. A GitHub Enterprise or fork URL: repo is taken from the PR URL (`host/owner/repo`) and passed as `-R`, never from
   the Worktree's remote. (Task 4 test `parsePullRequestUrl handles GHE hosts`.)
5. A corrupt or older `babysit.json`: read returns defaults merged with valid keys; save never writes invalid values.
   (Task 1 test `normalize drops invalid values`.)

---

### Task 1: Shared settings model

**Files:**
- Create: `packages/shared/src/babysit.mjs`, `packages/shared/src/babysit.d.mts`
- Test: `packages/shared/src/babysit.test.mjs`
- Modify: `packages/shared/package.json` exports (follow how `routines.mjs` is exported)

**Interfaces:**
- Produces:
  - `type BabysitWake = "comments" | "checks" | "conflicts" | "behind"`
  - `type BabysitLevel = 1 | 2 | 3 | 4 | 5`
  - `type BabysitSettings = { enabled: boolean; intervalMinutes: number; wake: BabysitWake[]; level: BabysitLevel;
    resolveThreads: boolean; stopWhenGreen: boolean; stopAfterDays: { on: boolean; days: number };
    stopAfterFailures: { on: boolean; times: number }; ownRule: boolean; ownRuleText: string; instructions: string }`
    (an off rule keeps its number or text, so turning it back on restores it).
  - `BABYSIT_DEFAULTS: BabysitSettings`, `INTERVAL_OPTIONS = [1,2,5,10,15,30]`, `DAYS_OPTIONS = [1,3,7,14,30]`,
    `FAILURE_OPTIONS = [2,3,5]`, `BABYSIT_LEVELS` (array of `{ level, title, description, steps }` with the spec's
    titles and descriptions; `steps` from `"report" | "fix" | "push" | "reply" | "rerequest"`).
  - `normalizeBabysitSettings(value: unknown): BabysitSettings` (unknown keys dropped, an invalid value falls back to
    that key's default, `instructions` capped at 4000 chars, `ownRuleText` at 300).

- [ ] **Step 1: Write the failing tests**

```js
test("defaults match the spec", () => {
  assert.deepEqual(BABYSIT_DEFAULTS, {
    enabled: false, intervalMinutes: 1, wake: ["comments", "checks", "conflicts"], level: 3, resolveThreads: true,
    stopWhenGreen: true, stopAfterDays: { on: true, days: 7 }, stopAfterFailures: { on: false, times: 3 },
    ownRule: false, ownRuleText: "", instructions: "",
  });
});
test("normalize drops invalid values", () => {
  const out = normalizeBabysitSettings({ intervalMinutes: 4, level: 9, wake: ["checks", "nope"], extra: 1, instructions: 5 });
  assert.equal(out.intervalMinutes, 1);
  assert.equal(out.level, 3);
  assert.deepEqual(out.wake, ["checks"]);
  assert.equal(out.instructions, "");
  assert.equal("extra" in out, false);
});
test("normalize of garbage returns defaults", () => assert.deepEqual(normalizeBabysitSettings("x"), BABYSIT_DEFAULTS));
test("levels carry their steps", () => assert.deepEqual(BABYSIT_LEVELS.map((l) => l.steps), [
  ["report"], ["fix"], ["fix", "push"], ["fix", "push", "reply"], ["fix", "push", "reply", "rerequest"],
]));
```

- [ ] **Step 2: Run** `node --test packages/shared/src/babysit.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `packages/shared/src/babysit.mjs` and its `.d.mts` with the exports above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): babysit PR settings model`.

---

### Task 2: Daemon settings store and commands

**Files:**
- Create: `packages/core/src/babysit-settings.cjs`, test `packages/core/src/babysit-settings.test.cjs`
- Modify: `packages/core/src/runtime.cjs` (next to `app-update:auto` handlers, ~L1303)
- Modify: `apps/desktop/electron/preload.cjs` (next to `readAutoUpdate`, ~L174), `apps/desktop/app/src/electron.d.ts`
  (~L380), then run `node scripts/generate-command-contracts.cjs` to refresh `packages/core/src/command-contracts.json`
- Modify: `apps/daemon/src/mobile-bridge.cjs` `METHODS` and `apps/daemon/src/confine.cjs` `PATHS` (both keys, read
  `none`, save `none` so a confined phone can change it), plus the peer/remote policy lists
  (`apps/daemon/src/peer-policy.test.cjs:26`, `apps/desktop/electron/computer-routing.test.cjs:153`) as the parity
  tests require.

**Interfaces:**
- Consumes: `normalizeBabysitSettings`, `BABYSIT_DEFAULTS` (Task 1).
- Produces:
  - `createBabysitSettings({ file, emit }) -> { read(): BabysitSettings, save(patch: Partial<BabysitSettings>): BabysitSettings }`
    (save merges the patch over the current value, normalizes, writes atomically with temp + rename like
    `app-auto-update.cjs`, then `emit("babysit:settings", value)`).
  - Daemon commands `babysit:settings:read` -> `BabysitSettings`, `babysit:settings:save(patch)` -> `BabysitSettings`,
    event `babysit:settings`.
  - Preload: `readBabysitSettings()`, `saveBabysitSettings(patch)`, `onBabysitSettings(cb)`.
  - `runtime.cjs` keeps the instance as `babysitSettings` for Tasks 5 and 7.

- [ ] **Step 1: Failing tests:** `read without a file returns defaults`; `save merges a patch and emits once`
  (`save({ enabled: true })` then `read().enabled === true`, `level === 3`, emit called with
  `("babysit:settings", value)`); `corrupt file reads as defaults`.
- [ ] **Step 2: Run** `node --test packages/core/src/babysit-settings.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the store and register handlers in `runtime.cjs`; add preload/types; run the contract
  generator; add phone bridge entries.
- [ ] **Step 4: Run** the store test, then `npm test -- --only command-parity`, `npm test -- --only confine`,
  `npm test -- --only peer-policy`, `npm test -- --only computer-routing`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): babysit settings store and commands`.

---

### Task 3: `pull-request` trigger in the Routine store

**Files:**
- Modify: `packages/core/src/routines/store.cjs` (`checkTrigger` L102, `validTrigger` L247, chat-target guard in
  `create()` L688-691, `assertEvent` L162, `upsertHeartbeat` L632, `claimable`/`claimQueued` ~L910-934)
- Modify: `packages/shared/src/routines.mjs` `triggerText` (L156): `pull-request` reads `PR #<n>`
- Test: `packages/core/src/routines/store.test.cjs`

**Interfaces:**
- Produces:
  - Trigger `{ kind: "pull-request", url: string, repo: string /* host/owner/repo */, number: number,
    settings: BabysitSettings }` (settings copied at creation).
  - Event `{ kind: "pull-request", key: string, summary: string, changes: BabysitChange[], branch: string }` where
    `BabysitChange = { kind: "comment" | "check" | "conflict" | "behind", id: string, text: string }`.
  - `store.findPullRequest(repo: string, number: number) -> Routine | undefined` (live, not completed, any Chat).
  - `store.prSnapshot(routineId) -> object | undefined`, `store.setPrSnapshot(routineId, snapshot)`; persisted in
    `state.pullRequests[routineId]`, dropped by `markCompleted` and `remove`.
  - `upsertHeartbeat` throws `"Babysit PR #<n> is watched by Milagre; delete it from its Routine page first"` when the
    same-name live Routine in that Chat has `trigger.kind === "pull-request"`.
  - `pull-request` events are claimed FIFO per Routine, one running Run per Routine at a time (no 2-hour expiry).

- [ ] **Step 1: Failing tests:** `create accepts a pull-request trigger on a chat target`;
  `pull-request trigger rejects a missing number`; `enqueue accepts a pull-request event for its routine`;
  `findPullRequest finds the live routine only`; `heartbeat_create cannot replace a babysit heartbeat`
  (`upsertHeartbeat({ chatId, name: "Babysit PR #7", every: "5m", ... })` throws); `prSnapshot survives reload and is
  dropped on complete`; `only one pull-request run per routine runs at a time`.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/store.test.cjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the trigger case (normalize `settings` with `normalizeBabysitSettings`), the guards and
  the snapshot state.
- [ ] **Step 4: Run** the store tests and `node --test packages/shared/src/routines.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): pull-request trigger kind`.

---

### Task 4: Read and diff a PR

**Files:**
- Create: `packages/core/src/routines/pull-request-watch.cjs`, test `pull-request-watch.test.cjs`

**Interfaces:**
- Consumes: exec pattern and `ghMessage` from `packages/core/src/pull-request-review.cjs`.
- Produces:
  - `parsePullRequestUrl(url) -> { repo: string, number: number } | null` (`https://github.com/o/r/pull/12` ->
    `{ repo: "github.com/o/r", number: 12 }`; GHE hosts kept).
  - `readPullRequestSnapshot({ repo, number }, { exec, env }) -> Promise<Snapshot>` using
    `gh pr view <n> -R <repo> --json state,reviewDecision,mergeStateStatus,mergeable,statusCheckRollup,headRefName,baseRefName,comments,reviews`;
    when `mergeStateStatus` isn't `BEHIND` and `wake` has `behind`, also
    `gh api repos/<owner>/<repo>/compare/<base>...<head> --hostname <host> --jq .behind_by`
    plus `gh api graphql` for `reviewThreads(first:100){ nodes { id isResolved comments(first:50){ nodes { id body author{login} } } } }`.
  - `Snapshot = { state: "OPEN"|"CLOSED"|"MERGED", reviewDecision: string|null, mergeable: string, mergeState: string,
    headRef: string, behindBy: number, failingChecks: string[], pendingChecks: number, comments: { id, body, author, threadId|null }[],
    unresolvedThreads: string[] }`.
  - `diffSnapshots(prev: Snapshot|undefined, next: Snapshot, settings: BabysitSettings) -> { changes: BabysitChange[], stop: "closed"|"green"|null }`:
    - comments: ids in `next` not in `prev`, body without `<!-- milagre-babysit -->`, only when `wake` has `comments`.
    - checks: names in `next.failingChecks` not failing in `prev`, only with `checks`.
    - conflict: `mergeable === "CONFLICTING"` and `prev` wasn't, only with `conflicts`.
    - behind: (`mergeState === "BEHIND"` or `behindBy > 0`) and `prev` wasn't behind, only with `behind`.
    - `prev` undefined: baseline only, `changes` empty except failing checks and conflicts already present.
    - stop `closed` when state is not OPEN; stop `green` when `settings.stopWhenGreen`, no failing or pending checks,
      no unresolved threads, and `reviewDecision` is `APPROVED` or `null`.

- [ ] **Step 1: Failing tests:** `parsePullRequestUrl handles GHE hosts`; `new comment wakes`;
  `marked comment is ignored`; `comment wake off ignores comments`; `check turning red wakes once`
  (second diff with the same failing check is empty); `merged stops`; `green and approved stops`;
  `green with no review required stops`; `behind via compare wakes`; `REVIEW_REQUIRED does not stop`; `first snapshot is a baseline`.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/pull-request-watch.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** (inject `exec`; tests for `readPullRequestSnapshot` use a fake exec returning fixture JSON).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): read and diff watched PRs`.

---

### Task 5: PR poller

**Files:**
- Create: `packages/core/src/routines/pr-poller.cjs`, test `pr-poller.test.cjs`
- Modify: `packages/core/src/routines/runtime-adapter.cjs` (build and start/stop next to the Linear poller: `let poller`
  L526, `changed()` L528, `save()` L780, `start()` L829, `stop()` L842)

**Interfaces:**
- Consumes: Task 3 store methods, Task 4 `readPullRequestSnapshot` and `diffSnapshots`, `scheduler.enqueueEvents`.
- Produces: `createPullRequestPoller({ store, scheduler, read, now, setTimeout, clearTimeout, onChange }) -> { start, stop, sync }`.
  - One timer per live `pull-request` Routine at `trigger.settings.intervalMinutes`; `sync()` adds and drops timers as
    Routines change; nothing polls while `store.enabled()` is false.
  - Each poll: read; `diffSnapshots(store.prSnapshot(id), next, settings)`; `setPrSnapshot`; on `stop` ->
    `store.complete(id, reason)`; on changes -> `enqueueEvents([{ at, routineId, event }])` with
    `key = "pr:" + repo + "#" + number + ":" + sha1(changes ids)`, `summary` one line per change, `branch = next.headRef`.
  - Failure-cap stop: keep `attempts: { [changeId]: count }` in the snapshot; a change id handed over again on the next
    poll counts up; when `stopAfterFailures.on` and a count reaches `times`, complete with reason `failures`.
  - Read errors: `store.setLastError(id, ghMessage(error))`, back off doubling to 15 minutes, clear on success.

- [ ] **Step 1: Failing tests** (fake read, fake timers, real store in a temp dir like `store.test.cjs`):
  `quiet PR enqueues nothing`; `new comment enqueues one event`; `merged PR completes the routine`;
  `read failure sets lastError and backs off`; `restart reuses stored snapshot` (new poller over the same store file,
  same PR state, no event); `failure cap completes after N repeats`; `paused store polls nothing`.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/pr-poller.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire into `runtime-adapter.cjs`.
- [ ] **Step 4: Run** the poller test and `node --test packages/core/src/routines/runtime-adapter.test.cjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): poll watched PRs`.

---

### Task 6: Deliver PR Runs into the Chat

**Files:**
- Create: `packages/core/src/routines/babysit-prompt.cjs`, test `babysit-prompt.test.cjs`
- Modify: `packages/core/src/routines/scheduler.cjs` (`startsChat` ~L17, `dispatch` L311, `runNow` L545; reuse the
  `deliverComment` defer path L266-309 with `entry.comment = true` so busy Chats defer by `COMMENT_RETRY_MS`)
- Modify: `packages/core/src/routines/runtime-adapter.cjs`: add `chats.headBranch(chatId) -> Promise<string|null>`
  (Worktree path from `state.worktrees[session.worktree_id].path`, then `git symbolic-ref --short HEAD`)
- Test: `packages/core/src/routines/scheduler.test.cjs`

**Interfaces:**
- Consumes: Task 3 event shape, `BABYSIT_LEVELS`.
- Produces: `babysitPrompt({ settings, event, pr: { url, number }, onBranch: boolean }) -> string`:
  - Section 1 (Milagre's prompt): what changed (`event.summary`), the effective level (`onBranch ? settings.level : 1`
    with a line saying the Worktree is on another branch), which skills to use per change kind
    (`milagre-fix-ci`, `milagre-address-review`, `milagre-resolve-conflicts`, `milagre-update-branch`), "end every
    GitHub comment you post with `<!-- milagre-babysit -->`", resolve threads only when `resolveThreads`, never merge,
    and when `settings.ownRule` the rule text with "if it holds, delete this Heartbeat with routine_delete and say why".
  - Section 2, only when `settings.instructions` is non-empty: `## Your instructions\n` + the text.
  - Ends with the scheduler's `PASS_HINT` like other Runs.
- Scheduler sends with `context = { kind: "routine-run", routineId, runId, name, at, label: "PR #<n>", babysit: { level } }`
  where `level` is the effective level (Task 8 reads it).

- [ ] **Step 1: Failing tests:** prompt `instructions appear after Milagre's section`; `no instructions section when
  empty`; `wrong branch forces report only`; `own rule tells the agent to delete the heartbeat`; scheduler
  `pull-request run is sent to its own chat`; `busy chat defers the pull-request run`; `context carries the effective level`.
- [ ] **Step 2: Run** `node --test packages/core/src/routines/babysit-prompt.test.cjs packages/core/src/routines/scheduler.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): deliver babysit runs`.

---

### Task 7: Detect `gh pr create` and create the Heartbeat

**Files:**
- Modify: `packages/shared/src/chat-pull-requests.mjs` (export `createdUrl` as `createdPullRequestUrl(detail)`;
  `.d.mts` too)
- Create: `packages/core/src/babysit-watch.cjs`, test `babysit-watch.test.cjs`
- Modify: `packages/core/src/runtime.cjs` `publishAgentEvent` (~L1000): call `babysitWatch.observe(chatId, event)` after
  `routines?.observe`
- Modify: `GLOSSARY.md`: add **Babysit** ("A Heartbeat Milagre adds to a Chat that opened a PR, when Babysit PRs is
  on. It checks the PR itself and wakes the agent only when something changed.")

**Interfaces:**
- Consumes: `createdPullRequestUrl`, `parsePullRequestUrl` (Task 4), `babysitSettings.read()` (Task 2),
  `store.findPullRequest` / `store.create` (Task 3).
- Produces: `createBabysitWatch({ settings, routines, now }) -> { observe(chatId, event) }`.
  - Remembers `step-started` steps with `kind === "shell"` by id (as `diff-refresh.cjs:28-40` does); on
    `step-completed` with `status === "done"` and a `detail` matching `/\bgh\s+pr\s+create\b/`, takes the URL.
  - When `settings.read().enabled` and no live Routine for that repo + number: `create({ name: "Babysit PR #<n>",
    prompt: "Babysit PR #<n>", trigger: { kind: "pull-request", url, repo, number, settings }, target: { kind: "chat",
    chatId }, createdBy: { kind: "agent", chatId }, expiresAt })`, where `expiresAt = now + days` when
    `stopAfterDays.on`, else `now + 30 days`. `provider`/`model`/`permissionMode` are left unset so Runs follow the Chat.

- [ ] **Step 1: Failing tests:** `gh pr create creates one babysit heartbeat`; `second gh pr create for the same PR
  creates nothing`; `disabled setting creates nothing`; `failed step creates nothing`; `watched-for off uses 30 days`;
  `non-shell step with gh text is ignored`.
- [ ] **Step 2: Run** `node --test packages/core/src/babysit-watch.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire into `runtime.cjs`.
- [ ] **Step 4: Run** the test, `node --test packages/shared/src/chat-pull-requests.test.mjs` (or its existing test
  file), and `npm test -- --only runtime`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: babysit PRs a Chat opens`.

---

### Task 8: Enforce the level

**Files:**
- Create: `packages/core/src/babysit-guard.cjs`, test `babysit-guard.test.cjs`
- Modify: `packages/core/src/agents/chat-host.cjs` (turn config ~L1033: when `routineRunOf(request)?.babysit` exists,
  add `guard: { level, resolveThreads }` read from the Routine's trigger settings)
- Modify: `packages/core/src/agents/session-manager.cjs` (`startTurn` L53 passes `turn.guard` through)
- Modify: `packages/core/src/agents/claude-provider.cjs`: install the `PreToolUse` hook (`gateHook`, L371/L427) when
  `turn.guard` is set, in any permission mode; deny Bash commands for which `babysitDenial` returns a reason
- Modify: `packages/core/src/agents/codex-provider.cjs`: with a guard, use `approvalPolicy: "untrusted"` for that turn
  (L46-48) so commands come to Milagre; in `handleServerRequest` (L565) deny guarded commands, auto-allow the rest
  when the Chat's mode is `full`
- Modify: `packages/core/src/agents/acp-session.cjs` (L449-494): same deny before the normal permission path
- Tests: `babysit-guard.test.cjs`, `agents/claude-provider.test.cjs`, `agents/codex-provider.test.cjs`,
  `agents/acp-session.test.cjs`

**Interfaces:**
- Produces: `babysitDenial(command: string, guard: { level: number, resolveThreads: boolean }) -> string | null`.
  Reason text: `"Babysit level <title> doesn't allow <action>. Change it in Settings › Experimental › Babysit PRs."`
  (`gh pr merge`: `"Babysitting never merges."`). Matching:
  - push (`git push`, any flags) denied below level 3.
  - reply (`gh pr comment`, `gh pr review`, `gh api` with `-X POST`/`--method POST` on `.../comments` or `.../replies`,
    graphql containing `addPullRequestReviewComment`, `addPullRequestReviewThreadReply`, `addComment`) denied below 4.
  - re-request (`gh pr edit --add-reviewer`, graphql `requestReviews`, `gh api .../requested_reviewers`) denied below 5.
  - resolve (graphql `resolveReviewThread`) denied when `!resolveThreads` or level below 4.
  - merge (`gh pr merge`, graphql `mergePullRequest`) always denied.
  - Commands chained with `&&`, `;`, `|` are checked part by part.

- [ ] **Step 1: Failing tests:** guard `report only denies git push`; `fix and push allows git push`;
  `level 3 denies gh pr comment`; `level 4 allows gh pr comment`; `chained push is caught`;
  `merge is always denied`; `resolve denied when switch off`; claude `guarded turn denies push in full mode`;
  codex `guarded turn denies push and allows ls in full mode`; acp `guarded turn denies push`.
- [ ] **Step 2: Run** `node --test packages/core/src/babysit-guard.test.cjs packages/core/src/agents/*.test.cjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: enforce babysit level`.

---

### Task 9: Desktop Babysit PRs page

**Files:**
- Create: `apps/desktop/app/src/lib/babysit-settings.ts` (+ `babysit-settings.test.ts`),
  `apps/desktop/app/src/components/settings/BabysitPrsSettings.tsx`
- Modify: `apps/desktop/app/src/components/Settings.tsx` (`ExperimentalSettings` ~L672: a chevron row "Babysit PRs"
  with "On"/"Off", local `page` state opening the sub-page; hide the section `<h1>` while the sub-page is open, as MCP
  does at ~L2367)
- Modify: `scripts/test-settings-sections.cjs` (Experimental switch list stays four; add a check that the Babysit PRs
  row opens the page and Back returns)

**Interfaces:**
- Consumes: preload `readBabysitSettings`, `saveBabysitSettings`, `onBabysitSettings` (Task 2); `BABYSIT_LEVELS`,
  option arrays, `BABYSIT_DEFAULTS` (Task 1).
- Produces: `useBabysitSettings() -> { settings: BabysitSettings | null, error: string | null, save(patch): Promise<void> }`
  (optimistic, reverts on error, follows `lib/remote-delegation.ts`); `createDebouncedSave(save, ms = 500)` returning
  `{ edit(patch), flush(), state: "idle" | "saving" | "saved" | "error" }` for the instructions and own-rule fields
  (flush on blur and unmount, as `FilesToCopy` does).
- Page layout per design `babysit-settings`: header `Experimental › Babysit PRs` with back button; groups
  "Babysit PRs" (Reset all to defaults link -> `save(BABYSIT_DEFAULTS)`), "When something needs fixing" (radio rows,
  Default tag on level 3, one pill per level with step icons joined by small chevrons, Resolve threads switch),
  "Stop babysitting when", "Your instructions" (textarea + "Saved" mark). Use `Group`, `Row`, `Switch`, `Select`,
  `RadioGroup`, `Checkbox` with accent classes (`bg-accent`, `bg-accent-tint`, `text-accent-ink`) passed via
  `className`; chips are buttons with `aria-pressed`.

- [ ] **Step 1: Failing tests** (`node --test` in `lib/babysit-settings.test.ts`): `debounced save fires once after
  500 ms`; `flush saves pending text immediately`; `failed save reports error state`.
- [ ] **Step 2: Run** `npm test -- --only babysit-settings`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook, debouncer, page and Experimental row.
- [ ] **Step 4: Run** the unit test, `node scripts/test-settings-sections.cjs`, `npm run typecheck`, `npm run lint`.
  Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Babysit PRs settings page`.

---

### Task 10: Phone Babysit PRs screen

**Files:**
- Create: `apps/mobile/src/app/(settings)/babysit-prs.tsx`, `apps/mobile/src/babysit-section.tsx`
- Modify: `apps/mobile/src/app/(settings)/_layout.tsx` (`<Stack.Screen name="babysit-prs" options={{ title: "Babysit PRs" }} />`)
- Modify: `apps/mobile/src/experimental-section.tsx` (a `Row` with chevron and "On"/"Off" that
  `router.push("/babysit-prs")`, reading via `useSession().client`; hidden when the Mac returns `null`)
- Modify: `scripts/mobile-ui.test.cjs` (load the new screen files)

**Interfaces:**
- Consumes: `client.call("babysit:settings:read", [])`, `client.call("babysit:settings:save", [patch])` (Task 2),
  Task 1 constants.
- Screen: same four groups with `Group`/`Row`/`Toggle`/`Segmented` from `settings-list.tsx` and `ui.tsx`, radio cards
  like `chat-display-choices.tsx` (selected border `colors.accent`), a `TextInput` for instructions that saves 500 ms
  after typing stops and on blur, with "Saved" under it. Re-read on focus with `useFocusEffect`.

- [ ] **Step 1: Failing test:** add `babysit-section.tsx` and `babysit-prs.tsx` to `scripts/mobile-ui.test.cjs` with
  assertions that the screen renders the four group titles and the Experimental row pushes `/babysit-prs`.
- [ ] **Step 2: Run** `npm test -- --only mobile-ui`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -- --only mobile-ui` and `npm run typecheck:mobile`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): Babysit PRs settings screen`.

---

### Task 11: Whole-branch verification

- [ ] **Step 1:** `npm run typecheck && npm run typecheck:mobile && npm run lint && npm run format:check && npm test -- --unit`. Expected: all pass.
- [ ] **Step 2:** Real-app QA in an isolated dev copy (memory: own Vite and CDP ports, throwaway repo, never the open
  Milagre): turn Babysit PRs on, have a Chat run `gh pr create` on a throwaway GitHub repo, confirm the
  `Babysit PR #<n>` Heartbeat, leave a review comment, confirm one Run arrives and its reply carries the marker, then
  merge and confirm the Heartbeat ends. Screenshots on the orphan `screenshots` branch.
- [ ] **Step 3:** Commit any fixes; open the PR (no Claude attribution).
