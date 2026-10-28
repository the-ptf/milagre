# Chats without a Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a Chat with **No project** on desktop and phone; it runs in its own empty folder and is listed in a **Chats** group at the top of the sidebar.

**Architecture:** Each computer's daemon owns one internal Git repository, the **Chats home** (`~/.milagre/chats`). Every project-less Chat is a Chat in it on a new Milagre Worktree, so send, resume, Terminals, archive and accounts reuse the Worktree paths unchanged. The daemon keeps the home out of every Project list and exposes it through two new commands; clients render it as the Chats group and the "No project" picker choice.

**Tech Stack:** Node CommonJS daemon (`packages/core`, `apps/daemon`), React + Electron desktop (`apps/desktop`), Expo React Native phone (`apps/mobile`), shared TS in `packages/shared`. Tests: `node --test` (`*.test.cjs`/`*.test.ts`); run a single file with `node --test <file>`; repo checks `npm run check` / `bun check` (see `docs/development.md`).

**Spec:** `docs/superpowers/specs/2026-10-28-project-less-chats-design.md`. Designs on this Chat's canvas: `desktop-new-chat-no-project`, `desktop-flat-list-chats`, `phone-drawer-no-project`, `phone-new-chat-no-project`.

## Global Constraints

- Chats home path: `path.join(os.homedir(), ".milagre", "chats")`, overridable by `options.chatsHome` (tests, live checks). Created with `git init -b main` and one `commit --allow-empty` (same `COMMIT_CONFIG` as `packages/core/src/bots/home.cjs:17`).
- Project-less Chats always use isolation `"worktree"`; their folders are `~/.milagre/worktrees/chats/<slug>`.
- Copy, exactly: picker row **No project**; sidebar group **Chats**; panel title that reads "Chats" today becomes **All chats** (flat desktop list, phone drawer); desktop heading **Just chat** + picker; phone heading **Just chat on <Computer>** with **No project · its own empty folder** under it; tray label **Yapping around** on desktop and phone (Victor, 2026-10-28); Settings › Accounts row **Chats without a Project**; Project name shown for these Chats: **No project**.
- The home never appears in: `project:recent`, `project:registry`, the daemon snapshot's Project list, MCP `project_list`, `onboarding:agent-folders`, the canvas, Choose projects, Filters › Projects, Hide project, `project:forget`.
- Window: the home is never saved to the recent list, so launch (`launchProject`) and ⌘N fall back to the last real Project.
- Archive: unchanged `archiveChoices` (`remove` when clean, `delete` with warning when not). No keep option.
- No Claude attribution in commits or the PR. PR screenshots from the real app on the orphan `screenshots` branch.
- Phone ships by OTA after merge.

## Spec deviations (decided while planning)

- The spec said list entries carry `kind: "chats"`. Instead the daemon **leaves the home out of every list** and clients ask for it with `chats:home`. Reason: phones still on the previous OTA would otherwise show a Project named "chats". `kind: "chats"` is still on the `project:read` / `project:open` result.
- The spec said the home is "an ordinary registered Project". It is **not added to the registry** (`openProject(..., { register: false, remember: false })`), because the canvas and account scopes read the registry. The gates that require the registry or recent list accept the home explicitly instead (Task 2). Update the spec in Task 11.

## Review Focus

1. **The first No project send on a fresh computer** (home missing): `chats:ensure` must finish before `chat:send`; a double click must not run `git init` twice. Pinned by Task 1 `ensure is idempotent under concurrent calls`.
2. **Launch after the last thing you did was a project-less Chat**: the window must open the last real Project, not the home. Pinned by Task 2 `openProject with remember:false leaves recent untouched`.
3. **⌘N while a project-less Chat is open**: starts in the last real Project. Pinned by Task 4 `newChatProject skips the Chats home`.
4. **Another computer offline** while the Chats group lists its Chats: rows stay, marked like other offline rows; picking that computer in the chip shows the existing offline behavior. Pinned by Task 6 `chatsGroups keeps an offline computer's copy`.
5. **Archive of a Chat whose folder has files**: the menu offers only Delete with the loss warning. Pinned by Task 9 `archiveChoices for a Chats home worktree with uncommitted files`.

---

### Task 1: Chats home module (daemon)

**Files:**
- Create: `packages/core/src/chats-home.cjs`
- Test: `packages/core/src/chats-home.test.cjs`

**Interfaces:**
- Produces: `createChatsHome({ root: string, git }) -> { path: string, exists(): Promise<boolean>, ensure(): Promise<string>, isHome(p: string): boolean }`. `git` is the runtime's git helper (same one `createBotHome` uses). `isHome` compares realpaths once the folder exists, else resolved paths.

- [ ] **Step 1: Write the failing tests** in `chats-home.test.cjs` with a temp `root`:
  - `exists is false before ensure`
  - `ensure creates a git repo on main with one empty commit` (assert `git rev-parse --abbrev-ref HEAD` is `main`, `git rev-list --count HEAD` is `1`, working tree has only `.git`)
  - `ensure is idempotent under concurrent calls` (`await Promise.all([ensure(), ensure()])`, commit count still `1`)
  - `isHome matches the root and not a child or sibling`
- [ ] **Step 2:** `node --test packages/core/src/chats-home.test.cjs` → FAIL (module missing).
- [ ] **Step 3:** Implement. Memoize the in-flight `ensure()` promise; reuse `COMMIT_CONFIG` by exporting it from `bots/home.cjs` (don't copy it).
- [ ] **Step 4:** Run the test file → PASS.
- [ ] **Step 5:** Commit `feat(core): a Chats home repository for Chats without a Project`.

### Task 2: Runtime wiring and commands

**Files:**
- Modify: `packages/core/src/runtime.cjs` (`openProject` :2214, `withoutHomes` :2394, `project:read` :2437, `project:switch` :2507, `project:plain-root`, `assertRegistrableProject` :2487, MCP host `projects` :~2504, Routines `projects` :~1306, snapshot filter :~2775)
- Modify: `packages/core/src/command-contracts.json`, `apps/daemon/src/computer-routing.cjs` (`RESULTS`), `apps/daemon/src/confine.cjs`, `apps/daemon/src/mobile-bridge.cjs` (`METHODS`), `apps/desktop/electron/preload.cjs`, `apps/desktop/app/src/electron.d.ts` (or wherever `MilagreBridge` is typed)
- Modify: `packages/core/src/local-mcp-tools.cjs` (`project_list` :82)
- Test: `packages/core/src/runtime.test.cjs`, `apps/daemon/src/computer-routing.test.cjs`, `apps/daemon/src/confine.test.cjs`

**Interfaces:**
- Consumes: Task 1 `createChatsHome`.
- Produces:
  - `chats:home` → `{ path: string; exists: boolean }` (no side effects).
  - `chats:ensure` → the `project:open` result for the home, plus `kind: "chats"`. Creates the repo if missing.
  - `project:read` / `project:switch` / `project:snapshot` results for the home carry `kind: "chats"`; every other Project omits `kind`.
  - `openProject(path, { takeNotice, focus, remember = true, register = true })`.
  - Bridge: `chatsHome(): Promise<{ path: string; exists: boolean }>`, `ensureChatsHome(): Promise<OpenedProject & { kind: "chats" }>`.
  - Remote routing: both results go through `OPEN_PROJECT`-style path rewriting (`withPath`) so another computer's home path comes back as a scope key.
  - confine: `chats:home` and `chats:ensure` are `denied` in the single-folder demo.

- [ ] **Step 1: Write failing runtime tests:**
  - `chats:home reports a missing home without creating it`
  - `chats:ensure opens the home with kind chats and isolation-ready worktrees` (result `kind === "chats"`, `git !== false`)
  - `openProject with remember:false leaves recent untouched` (recent list before == after; `project:recent` never contains the home)
  - `project:registry, project:recent and project_list leave the Chats home out`
  - `project:read and project:switch accept the Chats home without it being recent`
  - `project_add refuses the Chats home` (`assertRegistrableProject` throws)
  - `MCP validateProject accepts the Chats home` (a `chat_list` for it succeeds)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Extend `withoutHomes` to also drop `chatsHome.isHome`. MCP host `projects()` returns the filtered registry **plus** the home entry (when it exists) with `kind: "chats"`; `project_list` drops entries with `kind`. Routines' `projects` gets the same home entry so a Heartbeat on a project-less Chat doesn't fail with UNLISTED. Add the commands to the contract, routing, confine and mobile-bridge tables; add a routing test `chats:ensure result path is rewritten for a remote computer` and a confine test `chats commands are denied in the demo`.
- [ ] **Step 4:** Run runtime, routing and confine tests → PASS.
- [ ] **Step 5:** Commit `feat: chats:home and chats:ensure, with the Chats home kept out of every Project list`.

### Task 3: Shared types and helpers

**Files:**
- Modify: `apps/desktop/app/src/lib/project-list.ts` (`RecentProject`, `newChatProject` :40)
- Create: `packages/shared/src/chats-home.ts` (+ `.test.ts`)

**Interfaces:**
- Produces:
  - `type ChatsHome = { path: string; exists: boolean }`
  - `type ProjectKind = "chats"`; opened-Project types gain `kind?: ProjectKind`.
  - `isChatsHomeProject(project: { kind?: string } | null | undefined): boolean`
  - `CHATS_GROUP_KEY = "milagre-chats"` (sidebar/picker group key; never a path)
  - `NO_PROJECT_LABEL = "No project"`, `CHATS_GROUP_LABEL = "Chats"`, `ALL_CHATS_LABEL = "All chats"`, `CHATS_ACCOUNT_LABEL = "Chats without a Project"`

- [ ] **Step 1:** Test `isChatsHomeProject` (true for `{kind:"chats"}`, false for `{}`, `null`, `{kind:"other"}`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(shared): Chats home types and labels`.

### Task 4: Desktop: No project in the picker, heading, tray, window fallback

**Files:**
- Modify: `apps/desktop/app/src/components/NewChatHeading.tsx` (heading text, `ProjectPicker` rows :96-145)
- Modify: `apps/desktop/app/src/lib/project-copies.ts` (add `chatsGroup`)
- Modify: `apps/desktop/app/src/App.tsx` (`noGit`/`isolation` :488-489, `startNewChatOnThisMac` :2502, `moveNewChat` :2520)
- Modify: `apps/desktop/app/src/lib/project-list.ts` (`newChatProject`)
- Modify: `apps/desktop/app/src/components/ChatComposer.tsx` (`NewChatHeader` :940-1030)
- Test: `apps/desktop/app/src/lib/project-list.test.ts`, `apps/desktop/app/src/lib/project-copies.test.ts`, `apps/desktop/app/src/components/NewChatHeading.test.tsx` (create if missing)

**Interfaces:**
- Consumes: Task 2 bridge `chatsHome`/`ensureChatsHome`; Task 3 labels and `isChatsHomeProject`.
- Produces: `chatsGroup(homes: { computerId: string; computer: string; home: ChatsHome }[]): ProjectGroup` with `key = CHATS_GROUP_KEY`, `name = NO_PROJECT_LABEL`, one copy per computer whose `key` is that computer's home scope key (exists or not). `ProjectPicker` gets `noProject?: ProjectGroup` rendered first with the chat-bubble mark, a divider after it.

- [ ] **Step 1: Failing tests:**
  - `newChatProject skips the Chats home` (current = home key → returns most recent real local Project)
  - `chatsGroup has one copy per computer, this Mac first`
  - `picker lists No project first, then Projects` and `picking No project calls onProjectChange with this Mac's home key`
  - `heading reads "Just chat" when the Chats home is picked`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement:
  - `moveNewChat(key)`: when `key` is a Chats home key, `await bridgeForKey(key).ensureChatsHome()` before `switchProject(key)`.
  - `isolation` is `"worktree"` when `isChatsHomeProject(project)`; `noGit` stays as is.
  - `NewChatHeader` with a Chats home: render only the computer chip (`copies` = `chatsGroup` copies, so #733's chip switches computers) and the tray label **Yapping around** on desktop and phone (Victor, 2026-10-28); no isolation, branch, issue chips, no "has no Git" note.
  - Placeholder **Ask anything** for a Chats home draft.
- [ ] **Step 4:** PASS. Run `npm run -w apps/desktop typecheck` (or `bun check`) → clean.
- [ ] **Step 5:** Commit `feat(desktop): No project in the New chat picker`.

### Task 5: Desktop: no Git UI and no Project surfaces for project-less Chats

**Files:**
- Modify: `apps/desktop/app/src/App.tsx` (top-right Git/PR button, `openGitDialog`, "Start from issue" :~3474, Linear link, Project settings entry, canvas entry, title bar Project name)
- Modify: the PR pill / diffstat components that read the current Project (find with `grep -rn "PullRequest\|DiffStat" apps/desktop/app/src/components`)
- Test: extend the nearest existing test per surface, or `apps/desktop/app/src/lib/chats-home-surfaces.test.ts` for a pure `projectSurfaces(project): { git: boolean; settings: boolean; canvas: boolean; name: string }` helper

**Interfaces:**
- Produces: `projectSurfaces(project)` in `apps/desktop/app/src/lib/project-surfaces.ts`; for a Chats home: `{ git: false, settings: false, canvas: false, name: "No project" }`; otherwise `{ git: project.git !== false, settings: true, canvas: true, name: project.name }`.

- [ ] **Step 1:** Test `projectSurfaces` for a Chats home, a Git Project and a plain-folder Project.
- [ ] **Step 2:** FAIL. **Step 3:** Implement the helper and gate each surface on it. **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(desktop): project-less Chats show no Git or Project controls`.

### Task 6: Desktop sidebar: Chats group in both layouts, All chats title

**Files:**
- Modify: `apps/desktop/app/src/components/SidebarNav.tsx` (scopes :748-777, Pinned :1341-1352, `FlatChatList` :1714, `ChatList` :1785, flat header title)
- Modify: `apps/desktop/app/src/lib/sidebar-scopes.ts` (`useScopeStates` :214,264: read each computer's home with `project:read`)
- Modify: `apps/desktop/app/src/lib/computer-scopes.ts` (collect each computer's `chatsHome()`)
- Test: `apps/desktop/app/src/lib/sidebar-scopes.test.ts`, `apps/desktop/app/src/lib/computer-scopes.test.ts`

**Interfaces:**
- Consumes: Task 2 `chatsHome`, Task 3 labels/key, Task 4 `chatsGroup`.
- Produces: `chatsGroups(...)` rows: every computer's home Chats merged, newest first, each row with the computer chip rows already show.

- [ ] **Step 1: Failing tests:**
  - `chats group merges every computer's home Chats newest first`
  - `chatsGroups keeps an offline computer's copy` (rows stay, offline flag set like other scopes)
  - `chats group is absent when no computer has a home Chat`
  - `the Chats home never becomes a Project scope`
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement per `desktop-new-chat-no-project` (grouped) and `desktop-flat-list-chats` (flat): group header = bubble mark + **Chats** + `+` (opens New chat with No project, this Mac); below Pinned, above Projects; in flat layout under the renamed **All chats** title, then a divider, then the flat list. Rows open via `openCanvasChat(homeKey, id)`; archive via the existing `checkScopeArchive`.
- [ ] **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(desktop): Chats group at the top of the sidebar`.

### Task 7: Desktop: heading no longer draws over the slash menu

**Files:**
- Modify: `apps/desktop/app/src/components/ChatComposer.tsx:1409` (heading wrapper `z-30`), `apps/desktop/app/src/components/NewChatHeading.tsx` (report picker open)
- Test: `apps/desktop/app/src/components/NewChatHeading.test.tsx`

**Interfaces:**
- Produces: `NewChatHeading` prop `onOpenChange?(open: boolean)`; the wrapper is `z-30` only while open, otherwise no z-index (the composer's `/` and `@` menu at `z-20` then draws over it).

- [ ] **Step 1:** Test `heading wrapper is raised only while its picker is open`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `fix(desktop): the slash menu draws over the New chat heading`.

### Task 8: Accounts row for project-less Chats

**Files:**
- Modify: `apps/desktop/app/src/components/ProjectAccountsSettings.tsx`, `apps/mobile/src/project-accounts-section.tsx`
- Modify: `packages/core/src/runtime.cjs` `accountScopes` (:~2267) to append the home (when it exists) with label **Chats without a Project**
- Test: `packages/core/src/runtime.test.cjs` `account scopes list the Chats home once it exists`

- [ ] **Step 1:** Write the test. **Step 2:** FAIL. **Step 3:** Implement; both settings screens render the row from `accountScopes` with no other special case. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: one account choice for Chats without a Project`.

### Task 9: Archive check for the Chats home

**Files:**
- Test: `packages/shared/src/archive-flow.test.ts`, `packages/core/src/runtime.test.cjs`

- [ ] **Step 1: Tests only (behavior should already hold):**
  - `archiveChoices for a Chats home worktree with uncommitted files` → only `delete`, `tone: "danger"`, loss reason present
  - `archiveChoices for a clean Chats home worktree` → only `remove`
  - runtime: `worktree:remove removes a Chats home worktree and drops its Chat`
- [ ] **Step 2:** Run. If any fails, fix the cause (likely `isMilagreWorktree` roots or `openAsProject`), not the test.
- [ ] **Step 3:** Commit `test: archive removes a project-less Chat's folder`.

### Task 10: Phone

**Files:**
- Modify: `apps/mobile/src/client.ts` (:376-387, add `chatsHome`, `ensureChatsHome` RPCs)
- Modify: `apps/mobile/src/all-computers-store.ts` (keep each computer's `ChatsHome`; read the home's state like a Project's)
- Modify: `apps/mobile/src/new-chat-project.ts` (+ `.test.ts`): No project first
- Modify: `apps/mobile/src/app/chat.tsx` (`chooseProject` :978-998, heading, tray chips, placeholder, Git UI)
- Modify: `apps/mobile/src/project-navigation.tsx` (drawer: **All chats** title, Chats group on top; `startNewChat` :942)
- Test: `apps/mobile/src/new-chat-project.test.ts`, `apps/mobile/src/all-computers-store.test.ts`, `apps/mobile/src/client.test.ts`

**Interfaces:**
- Consumes: Task 2 RPCs, Task 3 helpers/labels.
- Produces: `newChatProjects(...)` returns a leading `{ kind: "no-project", computerId }` choice; `pickNewChatProject` never returns a Chats home unless asked.

- [ ] **Step 1: Failing tests:**
  - `newChatProjects lists No project first`
  - `No project defaults to the computer last used for a Chat`
  - `the drawer's Chats group merges every computer's home Chats newest first`
  - `client asks chats:home alongside project:recent and tolerates a computer without it` (older daemon → treated as no home)
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement per `phone-new-chat-no-project` and `phone-drawer-no-project`: heading **Just chat on <Computer> ▾** (tapping opens the computer choice) with **No project · its own empty folder**; tray shows **Yapping around** with the chat-bubble icon and no Local/branch chips; Git UI hidden as on desktop; check the `/` and `@` menu isn't covered by the heading and fix the same way if it is.
- [ ] **Step 4:** PASS; `npm run -w apps/mobile typecheck` and oxlint clean.
- [ ] **Step 5:** Commit `feat(mobile): Chats without a Project on the phone`.

### Task 11: Docs

**Files:**
- Modify: `GLOSSARY.md` (add **Chats home**; Chat entry notes a project-less Chat), `docs/superpowers/specs/2026-10-28-project-less-chats-design.md` (the two deviations above)
- Create: `docs/adr/0011-project-less-chats-share-a-chats-home.md` (shared home + Worktree per Chat; rejected: hidden Project per Chat (ADR-0010 style), plain-folder Project; lists filtered daemon-side for older phones)

- [ ] **Step 1:** Write them. **Step 2:** Commit `docs: Chats home in the glossary, ADR-0011`.

### Task 12: QA and PR

- [ ] **Step 1:** `bun check` and the full test suite (`npm test`) → green.
- [ ] **Step 2:** Real-app QA (dev copy per memory `milagre-qa-gotchas`, own ports, throwaway data dir): start a No project Chat, send, open Terminal (cwd is the Worktree), switch computer with the chip, archive clean and dirty, relaunch (opens last real Project), ⌘N from a project-less Chat, flat and grouped layouts, slash menu over heading.
- [ ] **Step 3:** Phone QA on a slim simulator (`simslim boot` + `verify --except widgets,health,connectivity,icloud,web` first), same flows.
- [ ] **Step 4:** Screenshots to the orphan `screenshots` branch; open the PR (no attribution lines).
