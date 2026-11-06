# Computers: Finish the Desktop Side (3b, 4, 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One desktop window shows and drives the chats of every paired Mac: Settings › Experimental "Other computers", the footer computers popover, Add computer, Computer settings, the merged multi-computer sidebar with an offline cache, and remote folders and images. It ships as one PR, in four phases that each end green.

**Architecture:** Electron main wires the merged `computers.cjs` (PR 3a) to the window with `computers-ipc.cjs`. Calls and events cross that boundary tagged with their computer. Main strips the computer from arguments on the way out and qualifies identities on the way in (`computer-routing.cjs`). The renderer keeps one namespace of keys: this Mac's keys stay as they are, and a remote Project's keys gain a `${computerId}|` qualifier. Every store keyed by scope or chat key (state events, chat windows, drafts, runs, sidebar caches) therefore separates computers without a second index. A call goes to the right Mac through `bridgeForKey(key)`, which returns `window.milagre` for this Mac or `window.milagre.on(computerId)` for another one. The preload builds both from one bridge factory. Main caches each computer's last sidebar state and recent transcripts in `userData/computers/<id>/cache.sqlite` and answers read calls from it while that computer is offline. On the daemon, `fs:list-dirs` and `media:read` serve the remote folder picker and remote images. `media:read` uses the image rules `serveMedia` already applies for the phone, which this plan moves into `media-access.cjs`.

**Tech Stack:** Node 24 CommonJS daemon and Electron main (`node:test`, `node:assert/strict`, `node:sqlite` through `@milagre/core/chat-db`); ESM `.mjs` + `.d.mts` in `@milagre/shared`; React 19 + Tailwind 4 + Hugeicons in the renderer (`node --test` on `.test.ts`); Electron 44 checks driven by Vite fixtures (`scripts/test-*.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-08-computers-design.md` (steps 3-5 of "Order of work", "Renderer", "Offline cache", "Errors", "Remote-only helpers"). Earlier plans: `docs/superpowers/plans/2026-10-08-computers-pr1-devices.md`, `-pr2-channel.md` and `-pr3-client.md`; this plan starts from the latter's "PR 3b" list. Where a plan and the merged code differ, the code wins. This plan was written against `a742995e`.

**Designs** (read them with the Chat's `artifact_read`): `sidebar-c-sections` v6 (merged list, popover, gear tooltip) and v3 (offline banner and composer), `add-computer` v1, `computer-settings` v1, `add-project-remote` v1.

## One PR, four phases

Victor asked for every remaining step in one PR. Each phase ends with the repository's checks green, so the branch can stop after any phase:

- **Phase A, the spec's 3b (Tasks 1-10):** the client fixes carried over from 3a, main wiring and IPC, the "Other computers" switch, the footer popover, Add computer and Computer settings. Computers can be added, watched and removed. Their chats are not in the sidebar yet.
- **Phase B, the spec's PR 4 (Tasks 11-23):** chat identity per computer, routing, the merged sidebar with each row's computer, remote limits, the offline banner and composer, OS notifications labeled with the computer, and the offline cache.
- **Phase C, the spec's PR 5 (Tasks 24-28):** `fs:list-dirs` with the remote folder picker in Add project, and `media:read` for remote images, files and image menus.
- **Phase D (Task 29):** checks, screenshots on the `screenshots` branch, the phone's fingerprint, and the PR body.

## Decisions this plan makes

Each one is pinned by a test in its task:

- **Link keys put the qualifier after their prefix:** `milagre-link:${computerId}|${linkId}`, not `${computerId}|milagre-link:${linkId}`. About ten renderer sites slice `"milagre-link:".length` off a scope to get the Link id. With this form they get `${computerId}|${linkId}`, which the remote bridge strips like any other qualified string. Project keys follow the spec exactly: `${computerId}|${projectPath}`.
- **The remote bridge strips by substring:** every string argument loses every `${computerId}|`. Computer ids are UUIDs (`randomUUID()` in `computers.cjs`), and a UUID followed by `|` never appears in a path, a chat key or a message.
- **Two or more computers show every Project:** with "Other computers" on and at least one computer added, the sidebar uses the every-Project layout even when "Every project in the sidebar" is off. Remote chats have nowhere else to appear. With only this Mac the sidebar is unchanged, as the spec says.
- **A remote Project opens with `project:switch`, not `canvas:open-project`.** The canvas is this Mac's alone (`canvas:*` and `linked:*` are local-only).
- **The offline cache is filled from two sides.** Main caches the list results it routes (`project:recent`, `project:registry`, `link:list`). The renderer forwards the whole states and chat windows it already keeps current (`computers:remember`). Main only ever sees patches for those, so it never applies patches itself.
- **"Other computers" stays a default-off switch** at the end of this PR, as Victor asked. Removing the flag is left for later (see the spec inaccuracy about rollout in the report).

## Global Constraints

- If the worktree has no `node_modules`, run `npm install` before Task 1.
- Daemon and Electron main code is CommonJS `.cjs` with `node:test` and `node:assert/strict`. Shared code is ESM `.mjs` with a `.d.mts` beside it. Renderer unit tests are `apps/desktop/app/src/**/*.test.ts`, run by `node --test`.
- One unit file: `node --test <path>`. One workspace: `npm test -- --unit --workspace <shared|daemon|desktop|mobile>`. All unit tests: `npm test -- --unit`. One Electron check: `npm test -- --only <name>`. Typecheck: `npm run typecheck`. Lint: `npm run lint`.
- Popover route lines, verbatim from the spec: "This Mac", "Same network", "relay.milagre.cloud", "Offline, seen 2h ago". The gear's tooltip: "<name> settings: rename, connection, remove". This Mac's gear opens Settings › Devices.
- Sidebar, verbatim: "with two or more computers, every chat row is two lines and the second line starts with a laptop icon and the computer name, then the PR chips. An offline computer's Projects and rows are dimmed and its rows read "studio, offline"." With just this Mac the sidebar is unchanged.
- Offline banner, verbatim from `sidebar-c-sections` v3: "studio is offline. This is the last copy it sent, 2h ago. You can read it until studio is back." The composer is disabled, and its placeholder adds " (studio is offline)".
- Errors, verbatim (already in `computer-errors.cjs`): "Removed on studio. Pair again with a new link.", "This link expired. Copy a new one on studio.", "Update Milagre on studio to connect.", "studio has too many devices connected. Remove one in its Settings › Devices." A send to an offline computer is refused with "studio is offline."
- Denied or local-only calls answer "Not available on a remote computer". "A denied or local-only action is hidden on remote chats rather than shown disabled."
- Local-only, from the spec: `editor:open`, `project:reveal`, `skills:open`, `skills:reveal`, the `project:open` folder dialog, image copy/save menus that read local paths, notification settings and updates.
- Identity: "A chat's identity becomes `{ computerId, key }`. `local` is this Mac, and local keys are unchanged". Remote Project keys are `${computerId}|${key}`; Links are `milagre-link:${computerId}|${id}` (see Decisions).
- Offline cache: "Each computer's last sidebar state and the transcripts of its last 20 opened chats are written to `userData/computers/<id>/cache.sqlite` when they arrive, and read when the computer is offline. Removing a computer deletes its folder." The file uses `node:sqlite` the way ADR-0007 does (`@milagre/core/chat-db`).
- `fs:list-dirs({ path })`: "folder names, whether each is a git repo and its branch, and whether it is already a Project. Starts at the home folder; refuses paths outside it." `media:read`: "limited to files the daemon already serves to the phone". Those rules are `serveMedia`'s in `apps/daemon/src/mobile-bridge.cjs:537-593`.
- Add computer is offered only while "Other computers" is on.
- UI primitives per `docs/agents/ui.md`: every scrolling list is a `ScrollArea`; transient surfaces close through `useDismiss` (pass `follow` when anchored to a trigger); modals are `<dialog>` with `showModal`, `backdrop:backdrop-blur-overlay`; no native `<select>` (use `primitives/Select`); no hand-written `backdrop-filter`.
- Desktop and mobile: the phone changes nothing on screen (spec: "A merged multi-computer list on the phone is a follow-up"). Phase B changes `@milagre/shared/chat-scopes` and `@milagre/shared/agent-runs`, which the phone bundles. They change no behavior for unqualified keys and add no native code, so the fingerprint must match the latest TestFlight build. Task 29 checks it, and the phone gets the code as an OTA after merge.
- Every task that changes a screen or a payload the window reads runs the affected existing Electron checks, named in its last step. PR 2 and PR 3a broke desktop checks by skipping them. Checks that select `dialog` elements are `test-allow-computer`, `test-chat-attachments`, `test-command-palette`, `test-find-in-chat`, `test-image-generation`, `test-handover`, `test-link-project-dialog`, `test-project-links`, `test-update-flow`, `test-subagents` and `test-task-track`. Any new `<dialog>` must not be mounted while closed, as `ComputerAllowPrompt.tsx:78` shows.
- Checks start their own Vite and Electron with their own ports and profiles; never kill Milagre by name. Screenshots only with `MILAGRE_SCREENSHOT_DIR`, pointed outside the repo.
- Commits: conventional messages. Never a Claude or Anthropic co-author trailer or footer. The pre-commit hook runs `oxlint` and `oxfmt --check` on staged files, so run `npx oxfmt <files>` before `git add`.

## Review Focus

- **The same Project path on two Macs** (`/Users/victor/code/app` on both): their states, chat windows, drafts, runs and unread marks must never mix, and a patch for one must never apply to the other's state. Pinned in Task 11 (keys differ, and round-trip), Task 14 (two scopes with the same path, each patched on its own) and Task 15 (runs from two computers merge without overwriting).
- **A local-only action on a remote chat** (Reveal in Finder, Open in editor, a file dropped from this Mac, Skills › Open) must never run on this Mac with the other Mac's path. Pinned in Task 12 (main refuses every local-only channel for a computer, and the preload's refusal lists must equal main's) and Task 18 (the row menu and the ⌘K list leave them out; a dropped file is refused with words).
- **Opening an offline computer's chat that was never cached:** the banner shows and the transcript reads "No copy of this chat on this Mac yet." It must not spin forever or raise a toast. Pinned in Task 20 (a cache miss answers an empty window) and Task 19 (the check opens an uncached chat).
- **Removing the computer whose chat is open:** the window goes back to this Mac's Project. Its rows and runs leave, and no call goes to the removed id. Pinned in Task 19 (the check removes the open chat's computer and waits for this Mac's Project) and Task 15 (`dropComputerRuns`). The effect itself is Task 16's.
- **A folder picker path that escapes the home folder** (`~/link -> /etc`, `~/../`, a relative path), and a `media:read` for a file the phone can't get (`~/.ssh/id_rsa` renamed `.png`, an image outside the scope's roots): each is refused, with no bytes or names leaving the Mac. Pinned in Task 24 and Task 25.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `apps/desktop/electron/computers.cjs`, `.test.cjs` | modify | Every attempt counts toward backoff; switch only when idle; view gains `lanRoutes`, `addedAt` |
| `apps/desktop/electron/peer-client.cjs`, `.test.cjs` | modify | `closeWhenIdle(beforeClose)`, `keepOpen()` |
| `apps/daemon/src/phone-channels.cjs`, `relay-host.test.cjs` | modify | `waitForAllow`'s `finally` clears only its own timer and abort |
| `apps/desktop/electron/own-host.cjs`, `.test.cjs` | create | This Mac's relay host id from `relay-identity.json`, without creating it |
| `apps/desktop/electron/computers-ipc.cjs`, `.test.cjs` | create | IPC for computers; routing, offline reads, notifications for remote events |
| `apps/desktop/electron/computer-routing.cjs`, `.test.cjs` | create | Local-only channels, stripping arguments, qualifying events and results |
| `apps/desktop/electron/computer-cache.cjs`, `.test.cjs` | create | `userData/computers/<id>/cache.sqlite`: write, read, delete |
| `apps/desktop/electron/main.cjs` | modify | Create computers, its IPC and caches; close on quit; `project:open-at` |
| `apps/desktop/electron/preload.cjs` | modify | One bridge factory: `window.milagre` and `window.milagre.on(computerId)`; `computers.*` |
| `apps/desktop/electron/notifications.cjs`, `.test.cjs` | modify | `labelFor(subtitle, computerName)` |
| `apps/desktop/tsconfig.electron.json` | modify | Typecheck the new main modules |
| `apps/desktop/app/src/electron.d.ts` | modify | `MilagreBridge`, `ComputerView`, `ComputersSnapshot`, `ComputerEvent`, `DirListing`, `MediaBytes` |
| `apps/desktop/app/src/lib/settings.ts` | modify | `otherComputers` (default false) |
| `apps/desktop/app/src/lib/computers.ts`, `.test.ts` | create | `useComputers`, `useApplyOtherComputers`, status lines, dots, `seenAgo`, banner copy |
| `apps/desktop/app/src/lib/computer-bridge.ts`, `.test.ts` | create | `bridgeFor`, `bridgeForKey`, `BridgeContext`, `useBridge`, `isRemoteKey` |
| `apps/desktop/app/src/lib/computer-scopes.ts`, `.test.ts` | create | Remote Projects and Links per computer; `mergeScopes` by name |
| `apps/desktop/app/src/lib/offline-cache.ts` | create | Forwards remote states and chat windows to main |
| `apps/desktop/app/src/lib/remote-media.ts`, `.test.ts` | create | `useMediaSrc`, `remoteImageDataUrl` |
| `apps/desktop/app/src/lib/state-events.ts`, `chat-messages.ts`, `sidebar-scopes.ts`, `agent-runs.ts`, `ports.ts` | modify | Every computer's events; reads routed by key |
| `apps/desktop/app/src/lib/state-events-computers.test.ts` | create | Two Macs' identical paths keep two states |
| `apps/desktop/app/src/lib/routed-bridge.test.ts` | create | Fails if a routed file calls `window.milagre.` |
| `apps/desktop/app/src/components/sidebar/ComputersButton.tsx` | create | Footer laptop button and its popover |
| `apps/desktop/app/src/components/AddComputerDialog.tsx` | create | Add computer |
| `apps/desktop/app/src/components/AddProjectDialog.tsx` | create | Choose a computer, then a folder on it |
| `apps/desktop/app/src/components/OfflineBanner.tsx` | create | The offline banner |
| `apps/desktop/app/src/components/PromptComposer.tsx`, `ChatComposer.tsx` | modify | The composer disabled while its computer is away |
| `apps/desktop/app/src/components/LinkWorkspace.tsx` | modify | A Link's calls to its computer; the popover's handlers; no local-only actions on a remote Link |
| `apps/desktop/app/src/components/Attachments.tsx`, `agents/GeneratedImage.tsx` | modify | A remote chat's images through `media:read` |
| `apps/desktop/app/src/components/SidebarNav.tsx`, `sidebar/ChatRow.tsx` | modify | Merged scopes, computer line, dimming, popover, remote menus |
| `apps/desktop/app/src/components/Settings.tsx` | modify | "Other computers" switch, Computers in the nav, the `computer` section (`ComputerSettings`), routed project sections |
| `apps/desktop/app/src/App.tsx` and the components listed in Task 16 | modify | Route by the open Project's computer |
| `packages/shared/src/chat-scopes.mjs`, `.d.mts`, `.test.ts` | modify | `LOCAL_COMPUTER`, `qualifyKey`, `computerOfKey`, `unqualifyKey`; qualified keys accepted |
| `packages/shared/src/agent-runs.mjs`, `.d.mts`, `.test.ts` | modify | `chatKey(path, id, computerId?)` |
| `packages/core/src/chat-db.cjs` | modify | Export `database()` |
| `apps/daemon/src/remote-files.cjs`, `.test.cjs` | create | `listDirs` |
| `apps/daemon/src/media-access.cjs`, `.test.cjs` | create | The phone's image rules, shared by the bridge and `media:read` |
| `apps/daemon/src/mobile-bridge.cjs` | modify | `serveMedia` through `media-access.cjs` |
| `apps/daemon/src/server.cjs`, `connections.test.cjs` | modify | `fs:list-dirs`, `media:read`, `remote-files-v1`, `homeDir` |
| `apps/desktop/electron/computers-e2e.test.cjs` | modify | Remote Project, chat, patch, events, offline cache, folders, media |
| `apps/daemon/src/relay-test-kit.cjs` | modify | The test Mac gets its own home folder |
| `scripts/test-add-computer.cjs`, `test-sidebar-computers.cjs`, `test-computer-settings.cjs`, `test-add-project-remote.cjs` | create | Electron checks |
| `scripts/test-experimental-settings.cjs` | modify | The "Other computers" switch |

---
## Phase A: adding, watching and removing computers (the spec's 3b)

Phase A ends with a window that turns "Other computers" on, adds a computer from its link (waiting through Allow), shows every computer's status in the footer popover and opens each one's settings. No remote chat is listed yet; that is Phase B.

### Task 1: Every attempt counts toward the backoff

A channel can open, its hello be accepted, and the runtime's next calls fail: `daemon:status`, `daemon:state-patches`, `project:open`, or the snapshot's page limits (`daemon-runtime.cjs:216-305`). `connectRoute` counts only a dial that throws (`computers.cjs:274-277`). A computer whose snapshot keeps failing is therefore redialed every `reconnectMs` (3 s) forever. Count every attempt, and let `online()` start the count over.

**Files:**
- Modify: `apps/desktop/electron/computers.cjs:264-280` (`connectRoute`)
- Test: `apps/desktop/electron/computers.test.cjs`

**Interfaces:**
- Consumes: `fakeMac().failing` (the method the fake Mac answers with an error), `paired(t, mac, options)`, `until` (all in `computers.test.cjs`).
- Produces: no new names. `entry.failures` now counts attempts since the last `online()`.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/electron/computers.test.cjs`:

```js
test("a computer whose calls fail after its channel opens is dialed less and less often", async (t) => {
  const mac = fakeMac();
  const steps = [150, 300, 600];
  const { computers, state } = await paired(t, mac, { backoffMs: steps, reconnectMs: 5, offlineAfterMs: 60_000 });
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  // Every hello is accepted, but the snapshot a reconnect reads fails each time.
  mac.failing = "daemon:snapshot";
  const from = mac.urls.length;
  mac.drop();
  await until(() => mac.urls.length >= from + 3, "three redials");
  const [first, second, third] = mac.times.slice(from, from + 3);
  assert.ok(second - first >= steps[0] - 10, `then it waits ${steps[0]}: ${second - first}ms`);
  assert.ok(third - second >= steps[1] - 10, `then ${steps[1]}: ${third - second}ms`);
  assert.equal(state(), "reconnecting");
  mac.failing = null;
  await until(() => state() === "online", "online again", 3000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern "calls fail after its channel opens" apps/desktop/electron/computers.test.cjs`
Expected: FAIL with `then it waits 150: <a few>ms`.

- [ ] **Step 3: Count attempts, not failed dials**

In `apps/desktop/electron/computers.cjs`, replace the tail of `connectRoute` (from `const computer = store.get(entry.id);` to the end of the function) with:

```js
    const computer = store.get(entry.id);
    if (!computer) throw new Error("This computer was removed.");
    // The runtime redials every reconnectMs; a computer that keeps failing is dialed less and less often (a first start has
    // its own backoff). Every attempt counts, not only a dial that throws: a channel can open and its first calls
    // (daemon:status, state patches, project:open, the snapshot's limits) still fail. online() starts the count over.
    if (entry.runtime) {
      if (entry.failures > 0) await backoff(entry);
      entry.failures++;
    }
    try {
      return adopt(entry, await dial(entry, computer.relay), "relay");
    } catch (error) {
      entry.switching = false;
      // The runtime would retry this forever: a refusal retrying can't fix stops the computer instead.
      if (isFinal(error)) refuse(entry, error);
      else entry.lastError = error;
      throw error;
    }
  }
```

- [ ] **Step 4: Run the file to verify it passes, the old backoff test included**

Run: `node --test apps/desktop/electron/computers.test.cjs`
Expected: PASS for every test, including "a computer that keeps refusing is dialed less and less often, and a connection starts it over".

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs
git add apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs
git commit -m "fix(desktop): a computer whose calls fail after the dial backs off too"
```

---

### Task 2: Calls in flight finish before the move to the LAN

When a LAN route opens while the runtime is on the relay, `computers.cjs:223-232` closes the relay channel at once. A `chat:send` or `git:push` waiting for its answer then fails with "Daemon connection closed", and was perhaps already done on the other Mac. Wait until the relay channel has nothing in flight, then close it. Calls made after that point wait for the LAN (`entry.recovery`, as now). A paged reply counts as in flight until its last page.

**Files:**
- Modify: `apps/desktop/electron/peer-client.cjs:94-101` (client shape), `:171-199` (`receive`, `readPages`), `:253-274` (`call`)
- Modify: `apps/desktop/electron/computers.cjs:220-232` (the supervisor subscription)
- Test: `apps/desktop/electron/peer-client.test.cjs`, `apps/desktop/electron/computers.test.cjs`

**Interfaces:**
- Produces: `client.closeWhenIdle(beforeClose?: () => void): void`. It closes the client as soon as no call waits for an answer and no paged reply is being read, running `beforeClose()` synchronously just before. It closes at once when idle already. `client.keepOpen(): void` takes back a `closeWhenIdle` that hasn't closed yet.
- Consumes: `entry.recovery`, `entry.switching`, `down()` (computers.cjs).

- [ ] **Step 1: Let the peer-client test's fake Mac answer later**

In `apps/desktop/electron/peer-client.test.cjs`, inside `fakeMac`'s `send`, replace:

```js
        const reply = answer(read.frame);
        if (reply === "close") return socket.closeWith(1000);
        if (reply) for (const text of writer.write(JSON.stringify(reply))) socket.deliver(channel.sealEncoded(text));
```

with:

```js
        const reply = answer(read.frame);
        if (reply === "close") return socket.closeWith(1000);
        // A promise answers later, as a slow call does.
        void Promise.resolve(reply).then((value) => {
          if (value && !socket.closed) for (const text of writer.write(JSON.stringify(value))) socket.deliver(channel.sealEncoded(text));
        });
```

- [ ] **Step 2: Write the failing peer-client test**

Append to `apps/desktop/electron/peer-client.test.cjs`:

```js
test("closeWhenIdle lets calls and paged replies in flight finish, then closes; keepOpen takes it back", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const pages = ['{"a":', "1}"];
  const mac = fakeMac({
    answer: (frame) =>
      frame.method === "slow"
        ? held.then(() => echo(frame))
        : frame.method === "big"
          ? { v: 1, id: frame.id, pages: { pageId: "p", pageCount: 2 } }
          : frame.method === "daemon:result-page"
            ? delay(10).then(() => ({ v: 1, id: frame.id, result: pages[frame.args[1]] }))
            : echo(frame),
  });
  const client = await dial(mac);
  let closes = 0;
  let before = 0;
  client.on("close", () => closes++);
  const slow = client.call("slow", [1]);
  const big = client.call("big");
  client.closeWhenIdle(() => before++);
  release();
  assert.deepEqual(await slow, { echo: [1] });
  assert.equal(client.closed, false, "the paged reply is still being read");
  assert.deepEqual(await big, { a: 1 });
  await until(() => client.closed, "the close once idle");
  assert.equal(before, 1);
  assert.equal(closes, 1);

  const idle = await dial(fakeMac());
  idle.closeWhenIdle();
  assert.equal(idle.closed, true, "nothing in flight: it closes at once");

  const kept = await dial(fakeMac({ answer: (frame) => (frame.method === "never" ? new Promise(() => {}) : echo(frame)) }));
  void kept.call("never").catch(() => {});
  kept.closeWhenIdle();
  kept.keepOpen();
  assert.deepEqual(await kept.call("project:recent", [2]), { echo: [2] });
  assert.equal(kept.closed, false);
  kept.close();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test --test-name-pattern "closeWhenIdle" apps/desktop/electron/peer-client.test.cjs`
Expected: FAIL with `client.closeWhenIdle is not a function`.

- [ ] **Step 4: Implement `closeWhenIdle` and `keepOpen`**

In `apps/desktop/electron/peer-client.cjs`, extend the client's initial shape:

```js
  const client = Object.assign(new EventEmitter(), {
    closed: false,
    /** @type {any} */
    status: undefined,
    /** @type {(method: string, args?: unknown[]) => Promise<any>} */
    call: async () => undefined,
    close: () => {},
    /** @type {(beforeClose?: () => void) => void} */
    closeWhenIdle: () => {},
    keepOpen: () => {},
  });
```

After `let failure = null;`, add:

```js
  // Paged replies being read (readPages): a call whose answer is still arriving page by page.
  let paging = 0;
  /** @type {(() => void) | null} */
  let whenIdle = null;
  /** Runs a pending closeWhenIdle once nothing is in flight. */
  function closeIfIdle() {
    if (!whenIdle || client.closed || pending.size > 0 || paging > 0) return;
    const before = whenIdle;
    whenIdle = null;
    try {
      before();
    } catch {
      /* the caller's bug must not keep the channel open */
    }
    client.close();
  }
```

In `receive`, after the reply has been handled, check for idle. Replace:

```js
    if (frame.error) request.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
    else if (frame.pages) request.resolve(readPages(frame.pages));
    else request.resolve(frame.result);
  }
```

with:

```js
    if (frame.error) request.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
    else if (frame.pages) request.resolve(readPages(frame.pages));
    else request.resolve(frame.result);
    closeIfIdle();
  }
```

Replace `readPages` with:

```js
  // A response too large for one frame (a big Project's state) arrives as pages, read one at a time in order.
  async function readPages({ pageId, pageCount }) {
    paging++;
    try {
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) throw new Error("The daemon sent an invalid paged response");
      const parts = [];
      let chars = 0;
      for (let index = 0; index < pageCount; index++) {
        const part = await client.call("daemon:result-page", [pageId, index]);
        if (typeof part !== "string") throw new Error("The daemon sent an invalid paged response");
        chars += part.length;
        if (chars > maxPagedChars) throw new Error("The daemon's paged response is too large");
        parts.push(part);
      }
      return JSON.parse(parts.join(""));
    } finally {
      paging--;
      closeIfIdle();
    }
  }
```

In `client.call`, a timed-out call leaves the in-flight set too. Replace its timeout callback:

```js
      const timeout = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(`Timed out: ${method}. It may still be running; do not retry a mutation without checking state.`));
          closeIfIdle();
        },
        deadlineFor(method, timeoutMs),
      );
```

After `client.close = () => end(new PeerError("lost"));`, add:

```js
  /** Closes once no call waits for its answer (`beforeClose` runs just before), or now when none does. */
  client.closeWhenIdle = (beforeClose = () => {}) => {
    whenIdle = beforeClose;
    closeIfIdle();
  };
  /** Takes back a closeWhenIdle that hasn't closed yet. */
  client.keepOpen = () => {
    whenIdle = null;
  };
```

- [ ] **Step 5: Run the peer-client tests**

Run: `node --test apps/desktop/electron/peer-client.test.cjs`
Expected: PASS for every test.

- [ ] **Step 6: Write the failing computers test**

Append to `apps/desktop/electron/computers.test.cjs`:

```js
test("a call already on the relay when the LAN opens finishes there, and the runtime moves once it is answered", async (t) => {
  const mac = fakeMac({ lan: [LAN] });
  // The relay holds one answer back; the LAN address doesn't answer its probe until the test says so.
  mac.hold = (socket, frame) => !socket.url.startsWith(LAN) && frame.method === "project:recent";
  let lanAnswers = false;
  const { computers, changes, state } = await paired(t, mac, {
    checkEveryMs: 20,
    fetch: async () => ({ ok: lanAnswers, json: async () => ({ v: 1, hostId: HOST }) }),
  });
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  const id = computers.list()[0].id;
  const slow = computers.invoke(id, "project:recent", ["slow"]);
  await until(() => mac.held.length === 1, "the call to wait on the relay");
  lanAnswers = true;
  await until(() => mac.urls.some((url) => url.startsWith(LAN)), "the LAN channel to open");
  await delay(60);
  assert.equal(computers.list()[0].route, "relay", "no move while a call waits on the relay");
  mac.hold = null;
  mac.release();
  assert.deepEqual(await slow, { echo: ["slow"] });
  await until(() => computers.list()[0].route === "lan", "on the LAN once the relay is free");
  assert.equal(
    changes.some((list) => list[0]?.state === "reconnecting"),
    false,
  );
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `node --test --test-name-pattern "already on the relay when the LAN opens" apps/desktop/electron/computers.test.cjs`
Expected: FAIL: `slow` rejects with "Daemon connection closed".

- [ ] **Step 8: Switch only once the relay channel is idle**

In `apps/desktop/electron/computers.cjs`, replace the comment block above `entry.supervisor.subscribe` and the subscription itself with:

```js
    // A LAN route that opens while the runtime is on the relay: the relay channel closes once no call waits on it (calls
    // already there finish there), and the runtime's reconnect then takes the LAN channel. Its brief disconnect is a
    // switch, not an outage: `down` lets the first disconnect after it go by, and a call made meanwhile (invoke) waits
    // for `recovery`. A LAN route lost before the relay was free leaves the runtime where it is.
    entry.supervisor.subscribe((route) => {
      const client = entry.client;
      if (!client || entry.route !== "relay") return;
      if (route.kind !== "lan") {
        client.keepOpen?.();
        return;
      }
      if (route.transport.used) return;
      client.closeWhenIdle(() => {
        entry.switching = true;
        if (!entry.recovery) {
          let done;
          const promise = new Promise((resolve) => (done = resolve));
          entry.recovery = { promise, done };
        }
      });
    });
```

- [ ] **Step 9: Run the computers tests**

Run: `node --test apps/desktop/electron/computers.test.cjs`
Expected: PASS for every test, including "a call made while the runtime moves to the LAN waits for it and goes through".

- [ ] **Step 10: The end-to-end test still moves to the LAN**

Run: `node --test apps/desktop/electron/computers-e2e.test.cjs`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
npx oxfmt apps/desktop/electron/peer-client.cjs apps/desktop/electron/peer-client.test.cjs apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs
git add apps/desktop/electron/peer-client.cjs apps/desktop/electron/peer-client.test.cjs apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs
git commit -m "fix(desktop): calls on the relay finish before a computer moves to the LAN"
```

---

### Task 3: A waiting request clears only its own notices

`waitForAllow`'s `finally` (`phone-channels.cjs:131-135`) clears `record.pendingTimer` and `record.abort` whatever they hold now. Today one record waits only once, so they are always its own. A second wait on the same record would have its timer and abort cleared by the first one's `finally`. That second wait can come from a hello retried on one connection or a future replace-in-place. Guard the clear, as `waiting()` already does (`record.abort !== abort`). The test pins the behavior around it: a computer whose second hello replaces its first keeps hearing pending notices on the new channel. It passes before and after the guard; the guard is what keeps it true if a record ever waits twice.

**Files:**
- Modify: `apps/daemon/src/phone-channels.cjs:131-135`
- Test: `apps/daemon/src/relay-host.test.cjs`

**Interfaces:**
- Consumes: `paired(t, { mac })`, `connectDesktop({ relayUrl, identity, key, name })`, `desktop.notices`, `fakePeerDaemon()`, `until` (relay-host.test.cjs and relay-test-kit.cjs); `startRelayHost`'s `timing.pendingRepeatMs` (PR 3a).
- Produces: nothing new.

- [ ] **Step 1: Write the test**

Append to `apps/daemon/src/relay-host.test.cjs`:

```js
test("a computer's second hello replaces its first while it waits, and the new channel keeps hearing that it waits", async (t) => {
  const daemon = fakePeerDaemon();
  // As phone.cjs does: a second request from the same key settles the first one as dropped.
  const waiting = new Map();
  const allowComputer = (request) =>
    new Promise((resolve) => {
      waiting.get(request.key)?.("dropped");
      waiting.set(request.key, resolve);
      request.waiting();
    });
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, allowComputer, timing: { pendingRepeatMs: 30 } } });
  const key = boxKeyPair(random);
  const first = connectDesktop({ relayUrl: relay.url, identity: mac.identity, key, name: "studio" });
  t.after(() => first.close());
  const refused = first.hello({ ms: 10_000 });
  await until(() => first.notices.length > 0, "the first channel's notice");
  const second = connectDesktop({ relayUrl: relay.url, identity: mac.identity, key, name: "studio" });
  t.after(() => second.close());
  const accepted = second.hello({ ms: 10_000 });
  assert.deepEqual((await refused).error, { t: "error", code: "unknown-phone" });
  const heard = second.notices.length;
  await until(() => second.notices.length >= heard + 2, "the second channel's repeated notices");
  waiting.get(b64url(key.publicKey))("allowed");
  assert.ok((await accepted).channel);
});
```

`boxKeyPair`, `b64url` (`@milagre/shared/relay-crypto`) and `random` (the test kit) are already imported at the top of the file.

- [ ] **Step 2: Run it**

Run: `node --test --test-name-pattern "second hello replaces its first" apps/daemon/src/relay-host.test.cjs`
Expected: PASS (it pins the behavior the guard protects).

- [ ] **Step 3: Guard the clear**

In `apps/daemon/src/phone-channels.cjs`, replace:

```js
    } finally {
      clearInterval(record.pendingTimer);
      record.pendingTimer = null;
      record.abort = null;
    }
```

with:

```js
    } finally {
      // Only this request's own notices and abort: a wait that replaced it on this record keeps its own.
      if (record.abort === abort) {
        clearInterval(record.pendingTimer);
        record.pendingTimer = null;
        record.abort = null;
      }
    }
```

- [ ] **Step 4: Run the daemon's channel tests**

Run: `node --test apps/daemon/src/relay-host.test.cjs apps/daemon/src/peer-e2e.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/daemon/src/phone-channels.cjs apps/daemon/src/relay-host.test.cjs
git add apps/daemon/src/phone-channels.cjs apps/daemon/src/relay-host.test.cjs
git commit -m "fix(daemon): a computer's wait for Allow clears only its own notices"
```

---
### Task 4: Main wires computers to the window

`main.cjs` has never required `computers.cjs` (PR 3a left it unwired). This task creates it, closes it on quit and gives the window its IPC. `computers-ipc.cjs` owns that IPC: list, preview, add (telling the asking window when the other Mac holds the pairing for Allow), cancel, rename, remove, enable, one daemon call on a computer, and the two pushes `computers:changed` and `computers:event`. Main learns this Mac's own host id from `relay-identity.json` without creating it, so Add computer can refuse this Mac's own link. The view gains the LAN addresses and the pairing date that Computer settings shows.

**Files:**
- Create: `apps/desktop/electron/own-host.cjs`, `apps/desktop/electron/own-host.test.cjs`
- Create: `apps/desktop/electron/computers-ipc.cjs`, `apps/desktop/electron/computers-ipc.test.cjs`
- Modify: `apps/desktop/electron/computers.cjs:117-131` (`view`)
- Modify: `apps/desktop/electron/computers.test.cjs` (the LAN test)
- Modify: `apps/desktop/electron/main.cjs:4-19` (imports), after `:219` (wiring), `:315-326` (`prepareQuit`)
- Modify: `apps/desktop/electron/preload.cjs` (the `computers` group and three listeners)
- Modify: `apps/desktop/app/src/electron.d.ts` (types)
- Modify: `apps/desktop/tsconfig.electron.json`

**Interfaces:**
- Consumes: `createComputers({ dataDir, safeStorage, ownHostId, onChange, emit })` and its `loaded`, `list()`, `preview(link)`, `add(link, { name }, { onPending })`, `cancelAdd()`, `rename(id, name)`, `remove(id)`, `setEnabled(on)`, `invoke(id, method, args)`, `close()` (computers.cjs). `computerName()` (`@milagre/daemon/mobile-pairing`). `hostIdOf`, `fromB64url` (`@milagre/shared/relay-crypto`).
- Produces:
  - `readOwnHostId(dataDir: string): Promise<string | null>`
  - `registerComputers({ ipcMain, computers, thisMac: () => string, send: (channel, payload) => void }) => { changed(): void; event(computerId: string, channel: string, payload: unknown): void }`
  - IPC: `computers:list` → `ComputersSnapshot`; `computers:preview(link)` → `ComputerPreview`; `computers:add(link, { name })` → `AddComputerResult`; `computers:cancel-add`; `computers:rename(id, name)` and `computers:remove(id)` → `ComputersSnapshot`; `computers:set-enabled(on)`; `computers:invoke(id, method, args)`. Pushes `computers:changed` (`ComputersSnapshot`), `computers:pending` (to the window that is adding) and `computers:event` (`{ computerId, channel, payload }`).
  - Types in `electron.d.ts`: `ComputerState`, `ComputerView`, `ComputersSnapshot`, `ComputerPreview`, `AddComputerResult`, `ComputerEvent`, `ComputersApi`. `window.milagre.computers: ComputersApi`, `onComputersChanged`, `onComputerAddPending`, `onComputerEvent`.
  - The computers view gains `lanRoutes: string[]` and `addedAt: number | null`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/electron/own-host.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readIdentity } = require("@milagre/daemon/relay-identity");
const { readOwnHostId } = require("./own-host.cjs");

test("this Mac's host id comes from its relay identity, and none is made when there is none", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "own-host-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  assert.equal(await readOwnHostId(dataDir), null);
  assert.deepEqual(await fs.readdir(dataDir), [], "reading never creates the identity");
  const identity = await readIdentity(dataDir);
  assert.equal(await readOwnHostId(dataDir), identity.hostId);
  await fs.writeFile(path.join(dataDir, "relay-identity.json"), "not json", { mode: 0o600 });
  assert.equal(await readOwnHostId(dataDir), null);
});
```

Create `apps/desktop/electron/computers-ipc.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { registerComputers } = require("./computers-ipc.cjs");

const studio = { id: "c1", name: "studio", hostId: "h".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: 1, addedAt: 1, message: null, lan: true, lanRoutes: ["ws://192.168.1.5:8798"] };

/** ipcMain as computers-ipc.cjs uses it, and a window that records what it is sent. */
function setup(computers) {
  const handlers = new Map();
  const sent = [];
  const windowSent = [];
  const sender = { isDestroyed: () => false, send: (channel, payload) => windowSent.push([channel, payload]) };
  const ipc = registerComputers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    computers: { loaded: Promise.resolve(), list: () => [studio], ...computers },
    thisMac: () => "victor-mbp",
    send: (channel, payload) => sent.push([channel, payload]),
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender }, ...args);
  return { ipc, call, sent, windowSent, handlers };
}

test("the window reads this Mac's name with the computers, and hears each change", async () => {
  const { ipc, call, sent } = setup({});
  assert.deepEqual(await call("computers:list"), { thisMac: "victor-mbp", computers: [studio] });
  ipc.changed();
  assert.deepEqual(sent, [["computers:changed", { thisMac: "victor-mbp", computers: [studio] }]]);
});

test("adding tells the asking window when the other Mac asks its owner, and a refusal comes back as words and a code", async () => {
  const calls = [];
  const { call, windowSent } = setup({
    async add(link, options, { onPending }) {
      calls.push([link, options]);
      onPending();
      if (link === "bad") throw Object.assign(new Error("studio didn't allow this Mac."), { code: "denied" });
      return studio;
    },
  });
  assert.deepEqual(await call("computers:add", "milagre://pair?x", { name: "Studio" }), { ok: true, computer: studio });
  assert.deepEqual(calls, [["milagre://pair?x", { name: "Studio" }]]);
  assert.deepEqual(windowSent, [["computers:pending", undefined]]);
  assert.deepEqual(await call("computers:add", "bad", {}), { ok: false, code: "denied", message: "studio didn't allow this Mac." });
  assert.deepEqual(await call("computers:add", "plain", { name: 7 }), { ok: true, computer: studio });
  assert.deepEqual(calls.at(-1), ["plain", { name: undefined }], "a name that isn't text is left out");
});

test("a computer's runtime events reach every window tagged with it, and a call goes to its runtime", async () => {
  const invoked = [];
  const { ipc, call, sent } = setup({ invoke: async (id, method, args) => (invoked.push([id, method, args]), { ok: 1 }) });
  ipc.event("c1", "project:state", { path: "/p" });
  assert.deepEqual(sent, [["computers:event", { computerId: "c1", channel: "project:state", payload: { path: "/p" } }]]);
  assert.deepEqual(await call("computers:invoke", "c1", "project:recent", undefined), { ok: 1 });
  assert.deepEqual(invoked, [["c1", "project:recent", []]]);
});
```

In `apps/desktop/electron/computers.test.cjs`, in the test "the LAN is used when the computer gave an address that answers…", after `assert.equal(computers.list()[0].lan, true);`, add:

```js
  assert.deepEqual(computers.list()[0].lanRoutes, [LAN]);
  assert.equal(typeof computers.list()[0].addedAt, "number");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/desktop/electron/own-host.test.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/computers.test.cjs`
Expected: FAIL with `Cannot find module './own-host.cjs'`, `Cannot find module './computers-ipc.cjs'`, and `lanRoutes` undefined.

- [ ] **Step 3: `own-host.cjs`**

Create `apps/desktop/electron/own-host.cjs`:

```js
const fs = require("node:fs/promises");
const path = require("node:path");
const { hostIdOf, fromB64url } = require("@milagre/shared/relay-crypto");

/**
 * This Mac's relay host id, read from the daemon's relay-identity.json (apps/daemon/src/relay-identity.cjs) without
 * creating it: Add computer refuses this Mac's own pairing link with it. Null when phone access never ran or the file
 * can't be read.
 * @param {string} dataDir
 * @returns {Promise<string | null>}
 */
async function readOwnHostId(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, "relay-identity.json"), "utf8"));
    return hostIdOf(fromB64url(value.sign.publicKey));
  } catch {
    return null;
  }
}

module.exports = { readOwnHostId };
```

- [ ] **Step 4: `computers-ipc.cjs`**

Create `apps/desktop/electron/computers-ipc.cjs`:

```js
/**
 * The window's side of computers.cjs (spec "This Mac (Electron main) › Computers"): the IPC the preload's
 * window.milagre.computers calls, the list pushed to every window after each change (computers:changed), and each
 * computer's runtime events, tagged with its id (computers:event). `send(channel, payload)` reaches every window.
 * @param {{
 *   ipcMain: { handle: (channel: string, handler: (event: any, ...args: any[]) => any) => void };
 *   computers: any;
 *   thisMac: () => string;
 *   send: (channel: string, payload: unknown) => void;
 * }} options
 */
function registerComputers({ ipcMain, computers, thisMac, send }) {
  const snapshot = () => ({ thisMac: thisMac(), computers: computers.list() });

  ipcMain.handle("computers:list", async () => {
    await computers.loaded;
    return snapshot();
  });
  ipcMain.handle("computers:preview", (_event, link) => computers.preview(link));
  // Electron keeps only an error's message across IPC; Add computer needs its code too ("cancelled" says nothing).
  ipcMain.handle("computers:add", async (event, link, options) => {
    try {
      const computer = await computers.add(
        link,
        { name: typeof options?.name === "string" ? options.name : undefined },
        {
          onPending: () => {
            if (!event.sender.isDestroyed()) event.sender.send("computers:pending");
          },
        },
      );
      return { ok: true, computer };
    } catch (error) {
      return {
        ok: false,
        code: typeof error?.code === "string" ? error.code : "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle("computers:cancel-add", () => computers.cancelAdd());
  ipcMain.handle("computers:rename", async (_event, id, name) => {
    await computers.rename(String(id), String(name ?? ""));
    return snapshot();
  });
  ipcMain.handle("computers:remove", async (_event, id) => {
    await computers.remove(String(id));
    return snapshot();
  });
  ipcMain.handle("computers:set-enabled", (_event, on) => computers.setEnabled(on === true));
  ipcMain.handle("computers:invoke", (_event, id, method, args) => computers.invoke(String(id), String(method), Array.isArray(args) ? args : []));

  return {
    changed: () => send("computers:changed", snapshot()),
    /** @param {string} computerId @param {string} channel @param {unknown} payload */
    event: (computerId, channel, payload) => send("computers:event", { computerId, channel, payload }),
  };
}

module.exports = { registerComputers };
```

- [ ] **Step 5: The view carries the LAN addresses and the pairing date**

In `apps/desktop/electron/computers.cjs`, in `view(computer)`, replace `lan: computer.lanRoutes.length > 0,` with:

```js
      lan: computer.lanRoutes.length > 0,
      lanRoutes: [...computer.lanRoutes],
      addedAt: computer.addedAt,
```

- [ ] **Step 6: Run the tests**

Run: `node --test apps/desktop/electron/own-host.test.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/computers.test.cjs`
Expected: PASS.

- [ ] **Step 7: Wire it in `main.cjs`**

In `apps/desktop/electron/main.cjs`, add `safeStorage,` to the `require("electron")` destructuring (after `protocol,`). After the line `ipcMain.handle("app:version", () => app.getVersion());`, add:

```js
  // Other Macs this window drives (Settings › Experimental › Other computers): nothing connects until the window turns
  // the switch on (computers:set-enabled), which it does at launch when it is on.
  const { createComputers } = require("./computers.cjs");
  const { registerComputers } = require("./computers-ipc.cjs");
  const { readOwnHostId } = require("./own-host.cjs");
  const { computerName } = require("@milagre/daemon/mobile-pairing");
  /** @type {string | null} */
  let thisMacName = null;
  /** @type {ReturnType<typeof registerComputers> | null} */
  let computersIpc = null;
  const computers = createComputers({
    dataDir: app.getPath("userData"),
    safeStorage,
    ownHostId: () => readOwnHostId(app.getPath("userData")),
    onChange: () => computersIpc?.changed(),
    emit: (id, channel, payload) => computersIpc?.event(id, channel, payload),
  });
  computersIpc = registerComputers({
    ipcMain,
    computers,
    thisMac: () => (thisMacName ??= computerName()),
    send: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
    },
  });
```

In `prepareQuit`, replace `await runtime.close();` with:

```js
      // Each computer's channels close too; nothing on the other Macs stops.
      await Promise.all([runtime.close(), computers.close()]);
```

- [ ] **Step 8: The preload's `computers` and listeners**

In `apps/desktop/electron/preload.cjs`, before `onPhoneStatus:`, add:

```js
  computers: {
    list: () => ipcRenderer.invoke("computers:list"),
    preview: (link) => ipcRenderer.invoke("computers:preview", link),
    add: (link, options) => ipcRenderer.invoke("computers:add", link, options),
    cancelAdd: () => ipcRenderer.invoke("computers:cancel-add"),
    rename: (id, name) => ipcRenderer.invoke("computers:rename", id, name),
    remove: (id) => ipcRenderer.invoke("computers:remove", id),
    setEnabled: (on) => ipcRenderer.invoke("computers:set-enabled", on),
    invoke: (id, method, args) => ipcRenderer.invoke("computers:invoke", id, method, args),
  },
  onComputersChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("computers:changed", listener);
    return () => ipcRenderer.removeListener("computers:changed", listener);
  },
  onComputerAddPending: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("computers:pending", listener);
    return () => ipcRenderer.removeListener("computers:pending", listener);
  },
  onComputerEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("computers:event", listener);
    return () => ipcRenderer.removeListener("computers:event", listener);
  },
```

- [ ] **Step 9: The types**

In `apps/desktop/app/src/electron.d.ts`, after the `PendingComputer` type, add:

```ts
/** How a paired computer stands: "off" while Settings › Experimental › Other computers is off. */
export type ComputerState = "off" | "connecting" | "online" | "reconnecting" | "offline" | "refused";
/** A computer this Mac drives, as computers.cjs reports it. `route`: how it is reached while online. */
export type ComputerView = {
  id: string;
  /** This Mac's label for it ("Show it as"); never sent to it. */
  name: string;
  hostId: string;
  relayHost: string;
  state: ComputerState;
  route: "lan" | "relay" | null;
  lastSeen: number | null;
  addedAt: number | null;
  /** Why it isn't connected, in words, while that can be said. */
  message: string | null;
  lan: boolean;
  /** The LAN addresses it gave (ws://host:port), at most four. */
  lanRoutes: string[];
};
/** This Mac's name and every computer it drives. */
export type ComputersSnapshot = { thisMac: string; computers: ComputerView[] };
/** What a pasted link names, read before any socket opens. */
export type ComputerPreview = { name: string; hostId: string; relayHost: string };
export type AddComputerResult = { ok: true; computer: ComputerView } | { ok: false; code: string; message: string };
/** An event from a computer's runtime: its channel and payload, tagged with the computer. */
export type ComputerEvent = { computerId: string; channel: string; payload: any };
export type ComputersApi = {
  list: () => Promise<ComputersSnapshot>;
  preview: (link: string) => Promise<ComputerPreview>;
  /** Pairs with the link's computer, waiting through its owner's Allow (onComputerAddPending says when). */
  add: (link: string, options: { name?: string }) => Promise<AddComputerResult>;
  cancelAdd: () => Promise<void>;
  /** A label on this Mac only. */
  rename: (id: string, name: string) => Promise<ComputersSnapshot>;
  remove: (id: string) => Promise<ComputersSnapshot>;
  setEnabled: (on: boolean) => Promise<void>;
  /** One daemon call on the computer. */
  invoke: (id: string, method: string, args?: unknown[]) => Promise<any>;
};
```

Inside `Window["milagre"]`, after `onPhoneStatus`, add:

```ts
      computers: ComputersApi;
      onComputersChanged: (callback: (snapshot: ComputersSnapshot) => void) => () => void;
      /** The computer being added is waiting for its owner's Allow. */
      onComputerAddPending: (callback: () => void) => () => void;
      /** Every computer's runtime events. */
      onComputerEvent: (callback: (event: ComputerEvent) => void) => () => void;
```

- [ ] **Step 10: Typecheck the new main modules**

In `apps/desktop/tsconfig.electron.json`, set:

```json
  "include": ["electron/main.cjs", "electron/preload.cjs", "electron/computers.cjs", "electron/computers-ipc.cjs", "electron/own-host.cjs"]
```

Run: `npm run typecheck`
Expected: PASS. This is the first time `tsc` reads `computers.cjs`, `peer-client.cjs`, `computers-store.cjs` and `computer-keys.cjs`. If it reports errors in them, fix each one with a JSDoc annotation (`/** @type {…} */`, `/** @param … */`), never by changing behavior, then run `node --test apps/desktop/electron/computers.test.cjs apps/desktop/electron/peer-client.test.cjs` again.

- [ ] **Step 11: The app still starts and its checks still pass**

Run: `npm test -- --only test-allow-computer && npm test -- --only test-settings-devices`
Expected: PASS (both render the full App against the old preload shape plus the new keys).

Run: `npm run dev --workspace milagre` in a second terminal, wait for the window, then quit it with ⌘Q.
Expected: the window opens and quits; the terminal prints no `computers` error.

- [ ] **Step 12: Commit**

```bash
npx oxfmt apps/desktop/electron/own-host.cjs apps/desktop/electron/own-host.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs apps/desktop/electron/main.cjs apps/desktop/electron/preload.cjs apps/desktop/app/src/electron.d.ts apps/desktop/tsconfig.electron.json
git add apps/desktop/electron/own-host.cjs apps/desktop/electron/own-host.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/computers.cjs apps/desktop/electron/computers.test.cjs apps/desktop/electron/main.cjs apps/desktop/electron/preload.cjs apps/desktop/app/src/electron.d.ts apps/desktop/tsconfig.electron.json
git commit -m "feat(desktop): main wires paired computers to the window"
```

---

### Task 5: Settings › Experimental › Other computers

A switch, off by default, kept with the other settings. The window tells main at launch and on each flip (`computers:set-enabled`). Nothing else about computers shows while it is off.

**Files:**
- Modify: `apps/desktop/app/src/lib/settings.ts:34-37` (type), `:73-74` (defaults), `:105-106` (load)
- Create: `apps/desktop/app/src/lib/computers.ts`
- Modify: `apps/desktop/app/src/components/Settings.tsx:190-213` (`ExperimentalSettings`)
- Modify: `apps/desktop/app/src/App.tsx:380` (beside `useApplyTheme()`)
- Modify: `scripts/test-experimental-settings.cjs`

**Interfaces:**
- Produces: `AppSettings.otherComputers: boolean` (default `false`); `useApplyOtherComputers(): void` in `lib/computers.ts`.
- Consumes: `window.milagre.computers.setEnabled` (Task 4).

- [ ] **Step 1: Extend the Experimental check first**

In `scripts/test-experimental-settings.cjs`, in the fixture, replace the `window.milagre = …` line with:

```js
window.enabledCalls = [];
window.milagre = {
  listEditors: async () => [],
  listRecentProjects: async () => [],
  listProjects: async () => [],
  computers: { setEnabled: async (on) => void window.enabledCalls.push(on) },
};
```

and add `import { useApplyOtherComputers } from '/src/lib/computers';` to its imports. Inside `Fixture()`, before `return`, add `useApplyOtherComputers();`. Change `const { sidebarAllProjects } = useSettings();` to `const { sidebarAllProjects, otherComputers } = useSettings();`, and add `data-other-computers={String(otherComputers)}` to the outer `<div>`.

In `browserChecks`, before `assert.deepEqual(errors, []);`, add:

```js
    const other = `document.querySelector('[role="switch"][aria-label="Other computers"]')`;
    assert.equal(await evaluate(`document.querySelector('[data-other-computers]').dataset.otherComputers`), "false", "Other computers is off by default");
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false]'`);
    await evaluate(`${other}.click()`);
    await waitFor(`document.querySelector('[data-other-computers]').dataset.otherComputers === 'true'`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false,true]'`);
    await screenshot("other-computers-on");
    await evaluate(`${other}.click()`);
    await waitFor(`JSON.stringify(window.enabledCalls) === '[false,true,false]'`);
```

and change the PASS line's text to end with `; Other computers is off by default and tells main each time it flips`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only test-experimental-settings`
Expected: FAIL (the module `/src/lib/computers` does not exist).

- [ ] **Step 3: The setting**

In `apps/desktop/app/src/lib/settings.ts`, after the `muriloMode` field of `AppSettings`, add:

```ts
  /** Experimental: drive the chats of other Macs running Milagre from this window (Add computer, the computers popover). */
  otherComputers: boolean;
```

In `DEFAULTS`, after `muriloMode: false,` add `otherComputers: false,`. In `load()`, after the `muriloMode:` line, add:

```ts
      otherComputers: typeof saved.otherComputers === "boolean" ? saved.otherComputers : DEFAULTS.otherComputers,
```

- [ ] **Step 4: Tell main**

Create `apps/desktop/app/src/lib/computers.ts`:

```ts
import { useEffect } from "react";
import { useSettings } from "./settings.ts";

/**
 * Tells main whether to connect the saved computers: at launch, and each time Settings › Experimental › Other computers
 * flips. A window without the API (a check's fixture) is left alone.
 */
export function useApplyOtherComputers() {
  const { otherComputers } = useSettings();
  useEffect(() => {
    void Promise.resolve(window.milagre?.computers?.setEnabled?.(otherComputers)).catch(() => {});
  }, [otherComputers]);
}
```

In `apps/desktop/app/src/App.tsx`, import it (`import { useApplyOtherComputers } from "./lib/computers";`) and, on the line after `useApplyTheme();`, add `useApplyOtherComputers();`.

- [ ] **Step 5: The switch**

In `apps/desktop/app/src/components/Settings.tsx`, in `ExperimentalSettings`, after the Murilo mode `</Row>`, add:

```tsx
      <Row
        label="Other computers"
        description="Drive the chats of other Macs running Milagre from this window. Add one from the laptop button at the bottom of the sidebar; their Projects join the sidebar."
      >
        <Switch label="Other computers" checked={settings.otherComputers} onChange={(otherComputers) => updateSettings({ otherComputers })} />
      </Row>
```

- [ ] **Step 6: Run the check and the unit tests**

Run: `npm test -- --only test-experimental-settings && npm test -- --unit --workspace desktop`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/app/src/lib/settings.ts apps/desktop/app/src/lib/computers.ts apps/desktop/app/src/components/Settings.tsx apps/desktop/app/src/App.tsx scripts/test-experimental-settings.cjs
git add apps/desktop/app/src/lib/settings.ts apps/desktop/app/src/lib/computers.ts apps/desktop/app/src/components/Settings.tsx apps/desktop/app/src/App.tsx scripts/test-experimental-settings.cjs
git commit -m "feat(desktop): Settings › Experimental › Other computers, off by default"
```

---

### Task 6: What the window says about each computer

The status dot, the route line, "seen 2h ago", the gear's tooltip and the offline banner, as pure functions with unit tests. Also `useComputers()`, the window's live list, which is empty while the switch is off.

**Files:**
- Modify: `apps/desktop/app/src/lib/computers.ts`
- Create: `apps/desktop/app/src/lib/computers.test.ts`

**Interfaces:**
- Consumes: `ComputerView`, `ComputersSnapshot` (Task 4); `useSettings().otherComputers` (Task 5).
- Produces (all from `lib/computers.ts`):
  - `type ComputerTone = "online" | "connecting" | "offline" | "refused"`
  - `DOT_COLOR: Record<ComputerTone, string>`
  - `computerTone(view: Pick<ComputerView, "state">): ComputerTone`
  - `seenAgo(lastSeen: number | null, now: number): string | null`
  - `routeLine(view: ComputerView, now: number): string`
  - `settingsTooltip(name: string): string`
  - `isDimmed(view: ComputerView | undefined): boolean` (offline or refused)
  - `isReadOnly(view: ComputerView | undefined): boolean` (not online)
  - `offlineBanner(view: ComputerView, now: number): string`
  - `offlinePlaceholder(name: string): string`
  - `useComputers(): ComputersSnapshot` (computers `[]` while the switch is off)
  - `getComputers(): ComputersSnapshot` (outside React; same rule)
  - `computerById(id: string): ComputerView | undefined`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/app/src/lib/computers.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerView } from "../electron.d.ts";

(globalThis as any).window = { localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
const { computerTone, routeLine, seenAgo, settingsTooltip, offlineBanner, offlinePlaceholder, isDimmed, isReadOnly } = await import("./computers.ts");

const NOW = Date.parse("2026-10-09T12:00:00Z");
const view = (patch: Partial<ComputerView> = {}): ComputerView => ({
  id: "c1",
  name: "studio",
  hostId: "h".repeat(22),
  relayHost: "relay.milagre.cloud",
  state: "online",
  route: "relay",
  lastSeen: NOW - 2 * 3600_000,
  addedAt: 1,
  message: null,
  lan: false,
  lanRoutes: [],
  ...patch,
});

test("each state reads as the popover's second line", () => {
  assert.equal(routeLine(view({ route: "lan" }), NOW), "Same network");
  assert.equal(routeLine(view({ route: "relay" }), NOW), "relay.milagre.cloud");
  assert.equal(routeLine(view({ state: "connecting", route: null }), NOW), "Connecting…");
  assert.equal(routeLine(view({ state: "reconnecting", route: null }), NOW), "Reconnecting…");
  assert.equal(routeLine(view({ state: "reconnecting", message: "studio has too many devices connected. Remove one in its Settings › Devices." }), NOW), "studio has too many devices connected. Remove one in its Settings › Devices.");
  assert.equal(routeLine(view({ state: "offline" }), NOW), "Offline, seen 2h ago");
  assert.equal(routeLine(view({ state: "offline", lastSeen: null }), NOW), "Offline");
  assert.equal(routeLine(view({ state: "refused", message: "Removed on studio. Pair again with a new link." }), NOW), "Removed on studio. Pair again with a new link.");
});

test("seen times read as minutes, hours, then days", () => {
  assert.equal(seenAgo(NOW - 20_000, NOW), "just now");
  assert.equal(seenAgo(NOW - 5 * 60_000, NOW), "5 min ago");
  assert.equal(seenAgo(NOW - 2 * 3600_000, NOW), "2h ago");
  assert.equal(seenAgo(NOW - 3 * 86_400_000, NOW), "3d ago");
  assert.equal(seenAgo(null, NOW), null);
});

test("the dot, dimming and read-only follow the state", () => {
  assert.deepEqual(
    (["online", "connecting", "reconnecting", "offline", "refused", "off"] as const).map((state) => computerTone({ state })),
    ["online", "connecting", "connecting", "offline", "refused", "offline"],
  );
  assert.equal(isDimmed(view({ state: "offline" })), true);
  assert.equal(isDimmed(view({ state: "reconnecting" })), false);
  assert.equal(isReadOnly(view({ state: "reconnecting" })), true);
  assert.equal(isReadOnly(view()), false);
  assert.equal(isReadOnly(undefined), true);
});

test("the gear's tooltip, the banner and the composer say the spec's words", () => {
  assert.equal(settingsTooltip("atlas"), "atlas settings: rename, connection, remove");
  assert.equal(
    offlineBanner(view({ state: "offline" }), NOW),
    "studio is offline. This is the last copy it sent, 2h ago. You can read it until studio is back.",
  );
  assert.equal(
    offlineBanner(view({ state: "offline", lastSeen: null }), NOW),
    "studio is offline. This is the last copy it sent. You can read it until studio is back.",
  );
  assert.equal(offlinePlaceholder("studio"), " (studio is offline)");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/desktop/app/src/lib/computers.test.ts`
Expected: FAIL with `computerTone is not a function` (or a missing export).

- [ ] **Step 3: Implement**

Append to `apps/desktop/app/src/lib/computers.ts` (keep `useApplyOtherComputers`), and add `useSyncExternalStore` to its `react` import:

```ts
import type { ComputersSnapshot, ComputerView } from "../electron.d.ts";

export type ComputerTone = "online" | "connecting" | "offline" | "refused";
/** The status dot (design sidebar-c-sections v6): green online, amber while it connects, grey offline, red refused. */
export const DOT_COLOR: Record<ComputerTone, string> = {
  online: "var(--green)",
  connecting: "var(--orange)",
  offline: "var(--ink-3)",
  refused: "var(--red)",
};

export function computerTone({ state }: Pick<ComputerView, "state">): ComputerTone {
  if (state === "online") return "online";
  if (state === "connecting" || state === "reconnecting") return "connecting";
  if (state === "refused") return "refused";
  return "offline";
}

/** "just now", "5 min ago", "2h ago", "3d ago"; null when it was never seen. */
export function seenAgo(lastSeen: number | null, now: number): string | null {
  if (lastSeen === null || !Number.isFinite(lastSeen)) return null;
  const minutes = Math.max(0, Math.floor((now - lastSeen) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The popover's second line under a computer's name (spec "Computer status"). */
export function routeLine(view: ComputerView, now: number): string {
  switch (view.state) {
    case "online":
      return view.route === "lan" ? "Same network" : view.relayHost;
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return view.message ?? "Reconnecting…";
    case "offline": {
      const ago = seenAgo(view.lastSeen, now);
      return ago ? `Offline, seen ${ago}` : "Offline";
    }
    case "refused":
      return view.message ?? "Pair again with a new link.";
    default:
      return "Off";
  }
}

export const settingsTooltip = (name: string) => `${name} settings: rename, connection, remove`;
/** Its Projects and rows are dimmed (spec "Sidebar"). */
export const isDimmed = (view: ComputerView | undefined) => view?.state === "offline" || view?.state === "refused";
/** Nothing can be sent to it: the composer is disabled and sends are refused. */
export const isReadOnly = (view: ComputerView | undefined) => view?.state !== "online";

/** The banner over an offline computer's chat (design sidebar-c-sections v3). */
export function offlineBanner(view: ComputerView, now: number): string {
  const ago = seenAgo(view.lastSeen, now);
  return `${view.name} is offline. This is the last copy it sent${ago ? `, ${ago}` : ""}. You can read it until ${view.name} is back.`;
}
/** Appended to the composer's placeholder while its computer is offline. */
export const offlinePlaceholder = (name: string) => ` (${name} is offline)`;

// The window's list of computers, kept current from main (computers:changed).
let snapshot: ComputersSnapshot = { thisMac: "This Mac", computers: [] };
let off: ComputersSnapshot = snapshot;
const listeners = new Set<() => void>();
let started = false;
function store(next: ComputersSnapshot | null | undefined) {
  if (!next || !Array.isArray(next.computers)) return;
  snapshot = next;
  off = { thisMac: next.thisMac, computers: [] };
  for (const listener of [...listeners]) listener();
}
function start() {
  if (started || typeof window === "undefined" || !window.milagre?.computers?.list) return;
  started = true;
  let heard = false;
  window.milagre.onComputersChanged?.((next) => {
    heard = true;
    store(next);
  });
  void Promise.resolve(window.milagre.computers.list()).then(
    (next) => {
      if (!heard) store(next);
    },
    () => {},
  );
}
function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** This Mac's name and its computers; none while Settings › Experimental › Other computers is off. */
export function useComputers(): ComputersSnapshot {
  const { otherComputers } = useSettings();
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return otherComputers ? current : current === snapshot ? off : { thisMac: current.thisMac, computers: [] };
}
/** The same outside React. */
export function getComputers(): ComputersSnapshot {
  start();
  return getSettings().otherComputers ? snapshot : off;
}
export const computerById = (id: string) => getComputers().computers.find((computer) => computer.id === id);
```

Change the settings import at the top to `import { getSettings, useSettings } from "./settings.ts";`.

- [ ] **Step 4: Run the tests**

Run: `node --test apps/desktop/app/src/lib/computers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/desktop/app/src/lib/computers.ts apps/desktop/app/src/lib/computers.test.ts
git add apps/desktop/app/src/lib/computers.ts apps/desktop/app/src/lib/computers.test.ts
git commit -m "feat(desktop): the words and dots for each computer's status"
```

---
### Task 7: Add computer

The dialog from design `add-computer` v1. The user pastes the link, and the dialog shows the computer it names and how it is reached. "Show it as" is prefilled. The dialog carries the full-control note and Cancel / Add computer. While the other Mac decides it reads "Waiting for studio to allow this Mac…", with Cancel. Every refusal shows in its own words, which come from main (`computer-errors.cjs`). Pairing always goes through the relay inside the pairing window (spec "Channel"), so the found computer reads "Reached through relay.milagre.cloud". The design's "Reached on the same network" can't be known before pairing (see the report). The dialog is mounted only while open (`test-allow-computer` and other checks look for the page's one `dialog`).

**Files:**
- Create: `apps/desktop/app/src/components/AddComputerDialog.tsx`
- Create: `scripts/test-add-computer.cjs`

**Interfaces:**
- Consumes: `window.milagre.computers.preview/add/cancelAdd`, `window.milagre.onComputerAddPending` (Task 4); `ipcErrorMessage` (`@milagre/shared/result`).
- Produces: `AddComputerDialog({ onClose: () => void; onAdded: (computer: ComputerView) => void })`. Its markers are `dialog[data-add-computer]`, inputs labeled "Pairing link" and "Show it as", `[data-add-computer-found]`, `[data-add-computer-waiting]` and `[data-add-computer-error]`.

- [ ] **Step 1: Write the check**

Create `scripts/test-add-computer.cjs`:

```js
// Run with npm test -- --only test-add-computer. Add computer in Electron against a stand-in for main: a pasted link that
// isn't one, or is this Mac's own, is refused under the field; a good link shows the computer and how it is reached, with
// "Show it as" filled in; Add waits for the other Mac's Allow and can be cancelled; every refusal shows its words; a
// computer that is added closes the dialog. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const LINK = "milagre://pair?relay=wss%3A%2F%2Frelay.milagre.cloud&host=hhhhhhhhhhhhhhhhhhhhhh&key=k&token=t&name=studio";
const OWN = "milagre://pair?relay=wss%3A%2F%2Frelay.milagre.cloud&host=oooooooooooooooooooooo&key=k&token=t&name=desk";

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AddComputerDialog } from "/src/components/AddComputerDialog";
import "/src/styles.css";
let pendingListeners = [];
let answer = null;
window.addCalls = [];
window.cancels = 0;
window.milagre = {
  onComputerAddPending: (callback) => {
    pendingListeners.push(callback);
    return () => (pendingListeners = pendingListeners.filter((item) => item !== callback));
  },
  computers: {
    preview: async (link) => {
      if (link === ${JSON.stringify(LINK)}) return { name: "studio", hostId: "h".repeat(22), relayHost: "relay.milagre.cloud" };
      if (link === ${JSON.stringify(OWN)}) throw new Error("That's this Mac's own link. Copy the one on the other Mac.");
      throw new Error("That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac.");
    },
    add: (link, options) =>
      new Promise((resolve) => {
        window.addCalls.push([link, options]);
        answer = resolve;
      }),
    cancelAdd: async () => {
      window.cancels++;
      answer?.({ ok: false, code: "cancelled", message: "Cancelled." });
    },
  },
};
window.askAllow = () => pendingListeners.forEach((callback) => callback());
window.answerAdd = (result) => answer(result);
function Fixture() {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState("");
  return (
    <div style={{ padding: 24 }}>
      <button data-open onClick={() => setOpen(true)}>Open</button>
      <output data-added>{added}</output>
      {open && (
        <AddComputerDialog
          onClose={() => setOpen(false)}
          onAdded={(computer) => {
            setAdded(computer.name);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-add-computer-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 960, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  // React reads a field's value from its own setter, so a test types through it.
  const type = (label, text) =>
    evaluate(`(() => {
      const input = document.querySelector('dialog[data-add-computer] input[aria-label=${JSON.stringify(label)}]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
  const press = (text) =>
    evaluate(`[...document.querySelectorAll('dialog[data-add-computer] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-open]')`);
    await evaluate(`document.querySelector('[data-open]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-computer]')?.open`);
    assert.match(await text("dialog[data-add-computer]"), /Settings › Devices/);

    await type("Pairing link", "hello");
    await waitFor(`!!document.querySelector('[data-add-computer-error]')`);
    assert.equal(await text("[data-add-computer-error]"), "That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac.");
    assert.equal(await evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Add computer').disabled`), true);
    await type("Pairing link", OWN);
    await waitFor(`document.querySelector('[data-add-computer-error]')?.textContent.includes("own link")`);

    await type("Pairing link", LINK);
    await waitFor(`!!document.querySelector('[data-add-computer-found]')`);
    assert.match(await text("[data-add-computer-found]"), /studio/);
    assert.match(await text("[data-add-computer-found]"), /Reached through relay\.milagre\.cloud/);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Show it as"]').value`), "studio");
    assert.match(await text("dialog[data-add-computer]"), /This window gets full control of studio's Projects/);
    await screenshot("add-computer-found");
    console.log("PASS: a pasted link is read before anything is sent, with the computer it names and how it is reached");

    await type("Show it as", "Studio Mac");
    await press("Add computer");
    await waitFor(`window.addCalls.length === 1`);
    assert.deepEqual(await evaluate("window.addCalls[0]"), [LINK, { name: "Studio Mac" }]);
    await evaluate(`window.askAllow()`);
    await waitFor(`!!document.querySelector('[data-add-computer-waiting]')`);
    assert.equal(await text("[data-add-computer-waiting]"), "Waiting for studio to allow this Mac…");
    await screenshot("add-computer-waiting");
    await press("Cancel");
    await waitFor(`window.cancels === 1 && !document.querySelector('[data-add-computer-waiting]')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-add-computer-error]')`), false, "a cancel is not an error");
    console.log("PASS: Add waits for the other Mac's Allow, saying so, and Cancel stops it quietly");

    const refusals = [
      ["denied", "studio didn't allow this Mac."],
      ["unknown-phone", "This link expired. Copy a new one on studio."],
      ["kind", "Update Milagre on studio to connect."],
      ["full", "studio has too many devices connected. Remove one in its Settings › Devices."],
      ["busy", "studio is answering another computer. Try again in a minute."],
      ["offline", "studio isn't reachable. Open Milagre on it and check Settings › Devices."],
      ["keys", "This Mac can't keep keys in its keychain, so it can't pair with computers."],
    ];
    for (const [code, message] of refusals) {
      const before = await evaluate(`window.addCalls.length`);
      await press("Add computer");
      await waitFor(`window.addCalls.length === ${before + 1}`);
      await evaluate(`window.answerAdd(${JSON.stringify({ ok: false, code, message })})`);
      await waitFor(`document.querySelector('[data-add-computer-error]')?.textContent.trim() === ${JSON.stringify(message)}`);
      if (code === "denied") await screenshot("add-computer-denied");
    }
    console.log("PASS: every refusal shows its own words");

    await press("Add computer");
    await waitFor(`window.addCalls.length === ${refusals.length + 2}`);
    await evaluate(`window.answerAdd({ ok: true, computer: { id: "c1", name: "Studio Mac" } })`);
    await waitFor(`!document.querySelector('dialog') && document.querySelector('[data-added]').textContent === 'Studio Mac'`);

    await evaluate(`document.querySelector('[data-open]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-computer]')?.open`);
    await evaluate(`document.querySelector('dialog[data-add-computer]').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog')`);
    assert.deepEqual(errors, []);
    console.log("PASS: an added computer closes the dialog, and Escape closes it with nothing mounted after");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-add-computer"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "add-computer-fixture",
        resolveId(id) {
          if (id === "/__add-computer.tsx") return id;
        },
        load(id) {
          if (id === "/__add-computer.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__add-computer") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__add-computer.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__add-computer`], {
      env,
      stdio: "inherit",
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only test-add-computer`
Expected: FAIL (`/src/components/AddComputerDialog` does not exist).

- [ ] **Step 3: The dialog**

Create `apps/desktop/app/src/components/AddComputerDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { AddComputerResult, ComputerPreview, ComputerView } from "../electron";

const FIELD =
  "h-9 w-full rounded-[9px] bg-field px-2.5 text-[12.5px] text-ink outline-none ring-1 ring-line-strong focus-visible:ring-accent placeholder:text-ink-3";

/**
 * Add computer (design add-computer v1): paste another Mac's pairing link, see the computer it names, and pair with it,
 * waiting while its owner clicks Allow there. Mounted only while open: other screens look for the page's one dialog.
 */
export function AddComputerDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (computer: ComputerView) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<ComputerPreview | null>(null);
  const [name, setName] = useState("");
  const typedName = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const reads = useRef(0);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => window.milagre.onComputerAddPending(() => setWaiting(true)), []);

  // Each change to the link is read again before anything is sent; an older answer that arrives late is dropped.
  useEffect(() => {
    const text = link.trim();
    const read = ++reads.current;
    setPreview(null);
    setError(null);
    if (!text) return;
    window.milagre.computers.preview(text).then(
      (found) => {
        if (read !== reads.current) return;
        setPreview(found);
        if (!typedName.current) setName(found.name);
      },
      (cause) => {
        if (read === reads.current) setError(ipcErrorMessage(cause));
      },
    );
  }, [link]);

  const close = () => {
    if (adding) void window.milagre.computers.cancelAdd();
    onClose();
  };
  async function add() {
    if (!preview || adding) return;
    setAdding(true);
    setWaiting(false);
    setError(null);
    const result: AddComputerResult = await window.milagre.computers
      .add(link.trim(), { name: name.trim() || preview.name })
      .catch((cause: unknown) => ({ ok: false as const, code: "failed", message: ipcErrorMessage(cause) }));
    setAdding(false);
    setWaiting(false);
    if (result.ok) onAdded(result.computer);
    else if (result.code !== "cancelled") setError(result.message);
  }
  async function paste() {
    try {
      setLink(await navigator.clipboard.readText());
    } catch {
      /* the field still takes ⌘V */
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      data-add-computer
      aria-labelledby="add-computer-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      className="m-auto w-[460px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] bg-surface p-5 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <h2 id="add-computer-title" className="text-[16px] font-semibold">
        Add computer
      </h2>
      <p className="mt-1 text-[13px] text-ink-2">See and drive another Mac's chats from this window.</p>
      <ol className="mt-4 list-decimal space-y-1 pl-[18px] text-[13px] text-ink-2">
        <li>On the other Mac, open Milagre Settings › Devices.</li>
        <li>Click Pair a device, then Copy link.</li>
        <li>Paste it here. The link works for 10 minutes.</li>
      </ol>
      <label className="mt-4 block text-[12px] text-ink-3" htmlFor="add-computer-link">
        Pairing link
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="add-computer-link"
          aria-label="Pairing link"
          value={link}
          disabled={adding}
          spellCheck={false}
          autoFocus
          placeholder="milagre://pair?…"
          onChange={(event) => setLink(event.target.value)}
          className={`${FIELD} font-mono`}
        />
        <button type="button" disabled={adding} onClick={() => void paste()} className="shrink-0 rounded-control px-3 text-[13px] ring-1 ring-line-strong hover:bg-hover-2">
          Paste
        </button>
      </div>
      {preview && (
        <div data-add-computer-found className="mt-3 flex items-center gap-3 rounded-[10px] bg-hover px-3 py-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-hover-2 text-ink-2">
            <HugeiconsIcon icon={LaptopIcon} size={17} strokeWidth={1.8} color="currentColor" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">{preview.name}</span>
            <span className="block text-[12px] text-ink-3">Reached through {preview.relayHost} · end-to-end encrypted</span>
          </span>
        </div>
      )}
      {preview && (
        <>
          <label className="mt-3.5 block text-[12px] text-ink-3" htmlFor="add-computer-name">
            Show it as
          </label>
          <input
            id="add-computer-name"
            aria-label="Show it as"
            value={name}
            disabled={adding}
            onChange={(event) => {
              typedName.current = true;
              setName(event.target.value);
            }}
            className={`${FIELD} mt-1.5`}
          />
        </>
      )}
      {error && (
        <p role="alert" data-add-computer-error className="mt-3 text-[13px] text-red">
          {error}
        </p>
      )}
      {waiting && preview ? (
        <div className="mt-[18px] flex items-center justify-between gap-3">
          <p role="status" data-add-computer-waiting className="text-[13px] text-ink-2">
            Waiting for {preview.name} to allow this Mac…
          </p>
          <button type="button" onClick={() => void window.milagre.computers.cancelAdd()} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-[18px] flex justify-end gap-2">
          <button type="button" onClick={close} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
            Cancel
          </button>
          <button
            type="button"
            disabled={!preview || adding}
            onClick={() => void add()}
            className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40"
          >
            {adding ? "Connecting…" : "Add computer"}
          </button>
        </div>
      )}
      {preview && (
        <p className="mt-3.5 text-[12px] text-ink-3">
          This window gets full control of {preview.name}'s Projects, like its own window. Remove it any time from {preview.name}'s Settings › Devices.
        </p>
      )}
    </dialog>,
    document.body,
  );
}
```

- [ ] **Step 4: Run the check**

Run: `MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-finish" npm test -- --only test-add-computer`
Expected: PASS with four PASS lines; `add-computer-found.png`, `add-computer-waiting.png` and `add-computer-denied.png` in `$TMPDIR/computers-finish`.

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/desktop/app/src/components/AddComputerDialog.tsx scripts/test-add-computer.cjs
git add apps/desktop/app/src/components/AddComputerDialog.tsx scripts/test-add-computer.cjs
git commit -m "feat(desktop): Add computer, from a pasted pairing link"
```

---

### Task 8: Computer settings

Design `computer-settings` v1, in Settings. A "Computers" group in the Settings nav lists This Mac and each computer with its dot; This Mac opens Settings › Devices. A computer's section has these parts:
- **Header:** its name as the title, then "Connected · Milagre 0.121.0 · paired Oct 8".
- **General:** Name, a label on this Mac only, saved when the field loses focus.
- **Connection:** "Same network" and "Relay", each "In use", "Ready" or "Not available".
- **On studio:** its Projects. The design's "2 Projects, 5 chats" would need every Project's state read, so this section counts Projects only. It reads "studio is offline" with its last-seen time while away.
- **Remove:** the spec's words, with an inline two-step confirm like Settings › Devices.

**Files:**
- Modify: `apps/desktop/app/src/components/Settings.tsx` (`SettingsSection`, `SettingsNav`, `SettingsPanel`, a new `ComputerSettings`)
- Create: `scripts/test-computer-settings.cjs`

**Interfaces:**
- Consumes: `useComputers`, `routeLine`, `seenAgo`, `DOT_COLOR`, `computerTone` (Task 6); `window.milagre.computers.rename/remove/invoke` (Task 4).
- Produces:
  - `SettingsSection` gains `"computer"`.
  - `SettingsNav` gains `computerId?: string` and `onSelectComputer?: (id: string) => void`.
  - `SettingsPanel` gains `computerId?: string`; removing calls `onSectionChange?.("devices")`.
  - Markers: `[data-settings-computers]` (nav group), `[data-computer-settings]`, input labeled "Name", `[data-connection="lan"|"relay"]` with a `[data-connection-state]` pill, `[data-computer-remove]` and `[data-computer-remove-confirm]`.

- [ ] **Step 1: Write the check**

Create `scripts/test-computer-settings.cjs`. Take its `main()`, the `browserChecks` scaffolding (`evaluate`, `errors`, `waitFor`, `screenshot`) and the closing lines from `scripts/test-add-computer.cjs`. Change the names `add-computer` to `computer-settings` and the cache dir to `.vite-computer-settings`, and use this fixture and body:

```js
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsNav, SettingsPanel } from "/src/components/Settings";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const HOUR = 3600000;
let computers = [
  { id: "c-atlas", name: "atlas", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: Date.parse("2026-10-08T10:00:00"), message: null, lan: true, lanRoutes: ["ws://192.168.0.24:8798"] },
  { id: "c-studio", name: "studio", hostId: "s".repeat(22), relayHost: "relay.milagre.cloud", state: "offline", route: null, lastSeen: Date.now() - 2 * HOUR, addedAt: Date.parse("2026-10-01T10:00:00"), message: null, lan: false, lanRoutes: [] },
];
let changed = () => {};
const snapshot = () => ({ thisMac: "victor-mbp", computers });
window.renames = [];
window.removed = [];
window.milagre = new Proxy({
  listRecentProjects: async () => [],
  listEditors: async () => [],
  onComputersChanged: (callback) => ((changed = callback), () => {}),
  computers: {
    list: async () => snapshot(),
    invoke: async (id, method) => (method === "daemon:status" ? { version: "0.121.0" } : method === "project:recent" ? [{ path: "/a/web", name: "atlas-web" }, { path: "/a/infra", name: "infra" }] : null),
    rename: async (id, name) => {
      window.renames.push([id, name]);
      computers = computers.map((item) => (item.id === id ? { ...item, name } : item));
      changed(snapshot());
      return snapshot();
    },
    remove: async (id) => {
      window.removed.push(id);
      computers = computers.filter((item) => item.id !== id);
      changed(snapshot());
      return snapshot();
    },
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
updateSettings({ otherComputers: true });
function Fixture() {
  const [section, setSection] = useState("general");
  const [computerId, setComputerId] = useState(undefined);
  return (
    <div style={{ display: "flex", gap: 12, height: "100vh", padding: 12 }}>
      <SettingsNav section={section} computerId={computerId} onSelect={setSection} onSelectComputer={(id) => { setComputerId(id); setSection("computer"); }} onSelectProject={() => {}} onBack={() => {}} showProjectSettings={false} />
      <main style={{ flex: 1, minWidth: 0 }}><SettingsPanel section={section} computerId={computerId} models={[]} update={null} onSectionChange={(next) => { window.sectionAfter = next; }} /></main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;
```

and, inside `browserChecks`'s `try`, after `await window.loadURL(process.argv[2]);`:

```js
    const nav = (name) => `[...document.querySelectorAll('[data-settings-computers] button')].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
    await waitFor(`!!document.querySelector('[data-settings-computers]')`);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll('[data-settings-computers] button')].map((b) => b.textContent.trim())`),
      ["victor-mbp", "atlas", "studio"],
    );
    await evaluate(`${nav("atlas")}.click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'atlas' && !!document.querySelector('[data-computer-settings]')`);
    await waitFor(`document.querySelector('[data-computer-status]')?.textContent.includes('Milagre 0.121.0')`);
    assert.match(await text("[data-computer-status]"), /^Connected · Milagre 0\.121\.0 · paired Oct 8$/);
    assert.equal(await text('[data-connection="lan"] [data-connection-state]'), "In use");
    assert.match(await text('[data-connection="lan"]'), /ws:\/\/192\.168\.0\.24:8798, end-to-end encrypted/);
    assert.equal(await text('[data-connection="relay"] [data-connection-state]'), "Ready");
    await waitFor(`document.querySelector('[data-computer-projects]')?.textContent.includes('2 Projects')`);
    assert.match(await text("[data-computer-projects]"), /atlas-web, infra\. Accounts and simulators stay on atlas\./);
    await screenshot("computer-settings");
    console.log("PASS: a computer's settings show its connection routes, which is in use, and what lives there");

    await evaluate(`(() => {
      const input = document.querySelector('[data-computer-settings] input[aria-label="Name"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "lab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    })()`);
    await waitFor(`window.renames.length === 1 && document.querySelector('h1')?.textContent === 'lab'`);
    assert.deepEqual(await evaluate(`window.renames`), [["c-atlas", "lab"]]);
    console.log("PASS: the name is a label on this Mac, saved when the field is left");

    await evaluate(`${nav("studio")}.click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'studio'`);
    assert.match(await text("[data-computer-projects]"), /^studio is offline/);
    assert.match(await text("[data-computer-status]"), /^Offline, seen 2h ago/);
    assert.equal(await text('[data-connection="lan"] [data-connection-state]'), "Not available");
    await evaluate(`document.querySelector('[data-computer-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-computer-remove-confirm]')`);
    assert.match(await text("[data-computer-settings]"), /Its chats leave this sidebar and this Mac forgets its keys\. Nothing changes on studio; pair again with a new link\./);
    await screenshot("computer-settings-remove");
    await evaluate(`document.querySelector('[data-computer-remove-confirm]').click()`);
    await waitFor(`window.removed.length === 1 && window.sectionAfter === 'devices'`);
    assert.deepEqual(await evaluate(`window.removed`), ["c-studio"]);
    assert.deepEqual(errors, []);
    console.log("PASS: Remove asks once more, removes the computer and goes to Settings › Devices");
    app.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only test-computer-settings`
Expected: FAIL (no `[data-settings-computers]`).

- [ ] **Step 3: The section**

In `apps/desktop/app/src/components/Settings.tsx`:

1. Add `"computer"` to `SettingsSection`.
2. Import `import { DOT_COLOR, computerTone, routeLine, seenAgo, useComputers } from "../lib/computers";` and `import type { ComputerView } from "../electron";`.
3. In `SettingsNav`, add the props `computerId?: string;` and `onSelectComputer?: (id: string) => void;` (destructure both), read `const { thisMac, computers } = useComputers();`, and after the `App` `GlideGroup`, add:

```tsx
      {computers.length > 0 && (
        <div data-settings-computers>
          <div className="mx-2 mt-2 flex h-8 items-center px-2 text-[12.5px] font-medium text-ink-3">Computers</div>
          <GlideGroup>
            <RailButton icon={<ComputerDot tone="online" />} label={thisMac} active={false} onClick={() => onSelect("devices")} />
            {computers.map((computer) => (
              <RailButton
                key={computer.id}
                icon={<ComputerDot tone={computerTone(computer)} />}
                label={computer.name}
                active={section === "computer" && computerId === computer.id}
                onClick={() => onSelectComputer?.(computer.id)}
              />
            ))}
          </GlideGroup>
        </div>
      )}
```

4. Add, near `Group`:

```tsx
function ComputerDot({ tone }: { tone: keyof typeof DOT_COLOR }) {
  return <span aria-hidden className="mx-[5px] block size-2 rounded-full" style={{ background: DOT_COLOR[tone] }} />;
}

/** The pill beside a route: the one carrying the connection now, one that would, or one there is none of. */
function RoutePill({ state }: { state: "In use" | "Ready" | "Not available" }) {
  return (
    <span
      data-connection-state
      className="rounded-full px-2 py-0.5 text-[11.5px]"
      style={state === "In use" ? { background: "var(--green-tint)", color: "var(--green)" } : { background: "var(--hover)", color: "var(--ink-3)" }}
    >
      {state}
    </span>
  );
}

/**
 * A paired computer's settings (design computer-settings v1): its name on this Mac, how it is reached, what lives there,
 * and Remove. The gear in the computers popover opens it.
 */
function ComputerSettings({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  const { computers } = useComputers();
  const computer = computers.find((item) => item.id === id);
  const [name, setName] = useState(computer?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState<{ version: string | null; projects: string[] } | null>(null);
  useEffect(() => setName(computer?.name ?? ""), [computer?.name]);
  useEffect(() => {
    setConfirming(false);
    setError(null);
    setAbout(null);
  }, [id]);
  // What lives there: asked while it is online, kept while it is away.
  useEffect(() => {
    if (computer?.state !== "online") return;
    let live = true;
    void Promise.all([
      window.milagre.computers.invoke(id, "daemon:status").catch(() => null),
      window.milagre.computers.invoke(id, "project:recent").catch(() => []),
    ]).then(([status, recent]) => {
      if (!live) return;
      const projects = (Array.isArray(recent) ? recent : []).filter((project) => !project?.hidden).map((project) => String(project.name));
      setAbout({ version: typeof status?.version === "string" ? status.version : null, projects });
    });
    return () => {
      live = false;
    };
  }, [id, computer?.state]);
  if (!computer) return <p className="mt-6 text-[13px] text-ink-3">This computer was removed.</p>;

  const now = Date.now();
  const paired = computer.addedAt ? `paired ${new Date(computer.addedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : null;
  const status = [computer.state === "online" ? "Connected" : routeLine(computer, now), about?.version ? `Milagre ${about.version}` : null, paired]
    .filter(Boolean)
    .join(" · ");
  const lanState = computer.state === "online" && computer.route === "lan" ? "In use" : computer.lanRoutes.length > 0 ? "Ready" : "Not available";
  const relayState = computer.state === "online" && computer.route === "relay" ? "In use" : "Ready";
  const rename = async () => {
    const next = name.trim();
    if (!next || next === computer.name) {
      setName(computer.name);
      return;
    }
    try {
      await window.milagre.computers.rename(computer.id, next);
      setError(null);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
      setName(computer.name);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await window.milagre.computers.remove(computer.id);
      onRemoved();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-computer-settings>
      <p data-computer-status className="mt-1 text-[13px] text-ink-3">
        {status}
      </p>
      <Group title="General">
        <Row label="Name" description="Shown on its chats in the sidebar. Only on this Mac.">
          <input
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-[30px] w-[220px] rounded-[8px] bg-field px-2.5 text-[13px] text-ink outline-none ring-1 ring-line-strong focus-visible:ring-accent"
          />
        </Row>
      </Group>
      <Group title="Connection">
        <div data-connection="lan">
          <Row
            label="Same network"
            description={computer.lanRoutes[0] ? `${computer.lanRoutes[0]}, end-to-end encrypted` : "Not reached on a shared network yet"}
          >
            <RoutePill state={lanState} />
          </Row>
        </div>
        <div data-connection="relay">
          <Row label="Relay" description={`${computer.relayHost}, used away from that network`}>
            <RoutePill state={relayState} />
          </Row>
        </div>
      </Group>
      <Group title={`On ${computer.name}`}>
        <div data-computer-projects>
          {computer.state === "online" ? (
            <Row
              label={about ? `${about.projects.length} ${about.projects.length === 1 ? "Project" : "Projects"}` : "Reading…"}
              description={about ? `${about.projects.length ? `${about.projects.join(", ")}. ` : ""}Accounts and simulators stay on ${computer.name}.` : undefined}
            >
              {null}
            </Row>
          ) : (
            <Row label={`${computer.name} is offline`} description={seenAgo(computer.lastSeen, now) ? `Last seen ${seenAgo(computer.lastSeen, now)}.` : undefined}>
              {null}
            </Row>
          )}
        </div>
      </Group>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red">
          {error}
        </p>
      )}
      <Group title="Remove">
        <Row
          label={`Remove ${computer.name}`}
          description={`Its chats leave this sidebar and this Mac forgets its keys. Nothing changes on ${computer.name}; pair again with a new link.`}
        >
          {confirming ? (
            <span className="flex gap-2">
              <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" data-computer-remove-confirm className={DANGER_BUTTON} disabled={busy} onClick={() => void remove()}>
                Remove {computer.name}
              </button>
            </span>
          ) : (
            <button type="button" data-computer-remove className={DANGER_BUTTON} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </Row>
      </Group>
    </div>
  );
}
```

5. In `SettingsPanel`, add the prop `computerId?: string` (destructure it), compute the title as:

```tsx
  const { computers } = useComputers();
  const title =
    section === "project"
      ? project?.name
      : section === "computer"
        ? (computers.find((computer) => computer.id === computerId)?.name ?? "Computer")
        : SECTIONS.find((item) => item.key === section)?.label;
```

and render, after the `experimental` line:

```tsx
        {section === "computer" && computerId && <ComputerSettings key={computerId} id={computerId} onRemoved={() => onSectionChange?.("devices")} />}
```

`SECONDARY_BUTTON` and `DANGER_BUTTON` are declared further down the file as `const`s. They are read only at render time, so `ComputerSettings` may sit anywhere in the file.

- [ ] **Step 4: Run the check, the Settings checks and the unit tests**

Run: `MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-finish" npm test -- --only test-computer-settings && npm test -- --only test-experimental-settings && npm test -- --only test-settings-devices && npm test -- --only test-linear-settings && npm test -- --only test-worktree-setup && npm test -- --unit --workspace desktop`
Expected: PASS (`test-worktree-setup` uses the Settings navigation).

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/desktop/app/src/components/Settings.tsx scripts/test-computer-settings.cjs
git add apps/desktop/app/src/components/Settings.tsx scripts/test-computer-settings.cjs
git commit -m "feat(desktop): Computer settings: name, connection, what lives there, Remove"
```

---

### Task 9: The footer's computers popover

Design `sidebar-c-sections` v6. A laptop button sits beside Add project and Link projects, shown only while "Other computers" is on. It opens a popover listing This Mac first, then each computer with its dot and its route line. Each row has a gear on hover with the tooltip "<name> settings: rename, connection, remove"; This Mac's gear opens Settings › Devices. Add computer comes last. The App opens Add computer and Computer settings from it.

**Files:**
- Create: `apps/desktop/app/src/components/sidebar/ComputersButton.tsx`
- Modify: `apps/desktop/app/src/components/SidebarNav.tsx` (props; the footer at `:1349-1384`)
- Modify: `apps/desktop/app/src/App.tsx` (state, handlers, the two `SettingsNav`/`SettingsPanel` pairs, the dialog beside `{linkDialog}`)
- Create: `scripts/test-sidebar-computers.cjs`

**Interfaces:**
- Consumes: `useComputers`, `routeLine`, `settingsTooltip`, `DOT_COLOR`, `computerTone` (Task 6); `AddComputerDialog` (Task 7); `SettingsNav`/`SettingsPanel`'s `computerId`, `onSelectComputer` (Task 8); `useDismiss` (`lib/use-dismiss.ts`); `GlideMenu`, `ScrollArea`, `Tooltip` primitives.
- Produces:
  - `ComputersButton({ collapsed, buttonClassName, onAddComputer, onOpenSettings })`, where `onOpenSettings(id: string | null)` and null means This Mac.
  - `SidebarNavProps.onAddComputer?: () => void` and `SidebarNavProps.onOpenComputerSettings?: (id: string | null) => void`.
  - Markers: `[data-computers-button]`, `[data-computers-panel]`, `[data-computer-row="this-mac"|<id>]`, `[data-computer-line]`, `[data-computer-gear]`, `[data-add-computer-row]`.

- [ ] **Step 1: Write the check**

Create `scripts/test-sidebar-computers.cjs`. Take `main()`, the `browserChecks` scaffolding and the closing lines from `scripts/test-add-computer.cjs`, with the names `sidebar-computers` and `.vite-sidebar-computers`, a `1280 × 760` window and real mouse input. The fixture renders the full App, like `scripts/test-allow-computer.cjs`:

```js
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const HOUR = 3600000;
const local = { next_id: 3, projects: { 1: { id: 1, name: "milagre-ade" } }, worktrees: { 1: { id: 1, name: "main", path: "/work/milagre-ade", project_id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title: "Desktop connect sidebar" } }, connections: {}, events: [], messages: [], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
window.computerList = [
  { id: "c-atlas", name: "atlas", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 1, message: null, lan: true, lanRoutes: ["ws://192.168.0.24:8798"] },
  { id: "c-studio", name: "studio", hostId: "s".repeat(22), relayHost: "relay.milagre.cloud", state: "offline", route: null, lastSeen: Date.now() - 2 * HOUR, addedAt: 1, message: null, lan: false, lanRoutes: [] },
];
let computersChanged = () => {};
window.setComputers = (list) => { window.computerList = list; computersChanged({ thisMac: "victor-mbp", computers: list }); };
window.milagre = new Proxy({
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getCurrentProject: async () => ({ path: "/work/milagre-ade", name: "milagre-ade", state: local }),
  listRecentProjects: async () => [{ path: "/work/milagre-ade", name: "milagre-ade" }],
  listBranches: async () => ["main"],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: "idle" }),
  getAppVersion: async () => "0.0.0",
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getRuns: async () => ({ runs: {}, seq: 0 }),
  getPhoneStatus: async () => ({ enabled: false, state: "off", remote: "none" }),
  listDevices: async () => [],
  onComputersChanged: (callback) => ((computersChanged = callback), () => {}),
  computers: {
    list: async () => ({ thisMac: "victor-mbp", computers: window.computerList }),
    setEnabled: async () => {},
    invoke: async (id, method) => (method === "daemon:status" ? { version: "0.121.0" } : method === "project:recent" ? [] : null),
    preview: async () => { throw new Error("That isn't a Milagre pairing link. Copy it from Settings › Devices on the other Mac."); },
  },
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
localStorage.setItem("milagre-settings", JSON.stringify({ defaultModelId: "claude-opus-5-5", defaultPermissionMode: "ask", otherComputers: true }));
window.setOther = (otherComputers) => updateSettings({ otherComputers });
const { default: App } = await import("/src/App");
createRoot(document.getElementById("root")).render(<App />);
`;
```

Inside `browserChecks`'s `try`, after `await window.loadURL(process.argv[2]);`:

```js
    const hover = async (selector) => {
      const rect = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(rect.x), y: Math.round(rect.y) });
    };
    const openPopover = async () => {
      await evaluate(`document.querySelector('[data-computers-button]').click()`);
      await waitFor(`!!document.querySelector('[data-computers-panel]')`);
    };
    const lines = () =>
      evaluate(`[...document.querySelectorAll('[data-computers-panel] [data-computer-row]')].map((row) => [row.dataset.computerRow, row.querySelector('[data-computer-name]').textContent.trim(), row.querySelector('[data-computer-line]').textContent.trim()])`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    await openPopover();
    assert.deepEqual(await lines(), [
      ["this-mac", "victor-mbp", "This Mac"],
      ["c-atlas", "atlas", "Same network"],
      ["c-studio", "studio", "Offline, seen 2h ago"],
    ]);
    assert.equal(await evaluate(`!!document.querySelector('[data-computers-panel] [data-add-computer-row]')`), true);
    await screenshot("popover");
    await hover('[data-computer-row="c-atlas"] [data-computer-gear]');
    await waitFor(`[...document.querySelectorAll('[role="tooltip"]')].some((tip) => tip.textContent.includes('atlas settings: rename, connection, remove'))`);
    await screenshot("popover-gear");
    console.log("PASS: the popover lists This Mac, then each computer with its route line, a gear with its tooltip, and Add computer");

    await evaluate(`document.querySelector('[data-computer-row="c-atlas"] [data-computer-gear]').click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'atlas' && !!document.querySelector('[data-computer-settings]')`);
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Back').click()`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    await openPopover();
    await evaluate(`document.querySelector('[data-computer-row="this-mac"] [data-computer-gear]').click()`);
    await waitFor(`document.querySelector('h1')?.textContent === 'Devices'`);
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Back').click()`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    console.log("PASS: a computer's gear opens its settings, and This Mac's opens Settings › Devices");

    await openPopover();
    await evaluate(`document.querySelector('[data-add-computer-row]').click()`);
    await waitFor(`document.querySelector('dialog[data-add-computer]')?.open && !document.querySelector('[data-computers-panel]')`);
    await evaluate(`document.querySelector('dialog[data-add-computer]').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog')`);
    await evaluate(`window.setOther(false)`);
    await waitFor(`!document.querySelector('[data-computers-button]')`);
    assert.deepEqual(errors, []);
    console.log("PASS: Add computer opens from the popover, and nothing about computers shows while Other computers is off");
    app.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only test-sidebar-computers`
Expected: FAIL (`Timed out: !!document.querySelector('[data-computers-button]')`).

- [ ] **Step 3: The button and its popover**

Create `apps/desktop/app/src/components/sidebar/ComputersButton.tsx`:

```tsx
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, LaptopIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import GlideMenu from "@/components/primitives/GlideMenu";
import Tooltip from "@/components/primitives/Tooltip";
import { ScrollArea } from "../primitives/ScrollArea";
import { useDismiss } from "../../lib/use-dismiss";
import { useSettings } from "../../lib/settings";
import { DOT_COLOR, computerTone, routeLine, settingsTooltip, useComputers, type ComputerTone } from "../../lib/computers";

const icon = (data: typeof LaptopIcon, size: number) => <HugeiconsIcon icon={data} size={size} strokeWidth={1.8} color="currentColor" />;

function HostRow({ id, name, line, tone, gearLabel, onGear }: { id: string; name: string; line: string; tone: ComputerTone; gearLabel: string; onGear: () => void }) {
  return (
    <div data-row data-computer-row={id} className="group/host relative z-10 flex h-11 items-center gap-2.5 rounded-[8px] pr-2 pl-2.5">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: DOT_COLOR[tone] }} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span data-computer-name className="truncate text-[13px] font-medium text-ink">
          {name}
        </span>
        <span data-computer-line className="truncate text-[11.5px] text-ink-3">
          {line}
        </span>
      </span>
      <Tooltip label={gearLabel} side="bottom" align="end">
        <button
          type="button"
          data-menu-row
          data-computer-gear
          aria-label={gearLabel}
          onClick={onGear}
          className="flex size-[26px] items-center justify-center rounded-[7px] text-ink opacity-0 outline-none transition-opacity duration-100 group-hover/host:opacity-100 hover:bg-hover-2 focus-visible:bg-hover-2 focus-visible:opacity-100"
        >
          {icon(Settings01Icon, 15)}
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The footer's laptop button (spec "Computer status", design sidebar-c-sections v6): a popover of This Mac and each
 * paired computer with its status dot and route, a gear per computer that opens its settings (This Mac's: Settings ›
 * Devices), and Add computer. Shown only while Settings › Experimental › Other computers is on.
 */
export function ComputersButton({
  collapsed,
  buttonClassName,
  onAddComputer,
  onOpenSettings,
}: {
  collapsed: boolean;
  buttonClassName: string;
  onAddComputer: () => void;
  /** null: This Mac. */
  onOpenSettings: (id: string | null) => void;
}) {
  const { otherComputers } = useSettings();
  const { thisMac, computers } = useComputers();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ bottom: 0, left: 0 });

  // Above the button, which sits at the bottom of the sidebar; collapsed, beside the rail.
  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    setPosition(collapsed ? { bottom: window.innerHeight - rect.bottom, left: rect.right + 8 } : { bottom: window.innerHeight - rect.top + 6, left: rect.left });
    return true;
  };
  const close = () => setOpen(false);
  useDismiss(open, close, (target) => !!target.closest("[data-computers-button], [data-computers-panel]"), place);
  useLayoutEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("[data-menu-row]")?.focus();
  }, [open]);
  if (!otherComputers) return null;

  const pick = (run: () => void) => () => {
    close();
    run();
  };
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    }
  };
  const now = Date.now();
  const anyAway = computers.some((computer) => computerTone(computer) !== "online");

  return (
    <>
      <Tooltip label="Computers">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Computers"
          aria-haspopup="menu"
          aria-expanded={open}
          data-computers-button
          onClick={() => (open ? close() : place() && setOpen(true))}
          className={`${buttonClassName} relative ${collapsed ? "size-8" : "size-9"} ${open ? "bg-hover-2 text-ink" : ""}`}
        >
          {icon(LaptopIcon, 17)}
          {anyAway && <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full" style={{ background: "var(--orange)" }} />}
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label="Computers"
            data-computers-panel
            onKeyDown={moveFocus}
            className="fixed z-50 flex max-h-[min(420px,calc(100vh-16px))] w-[272px] flex-col overflow-hidden rounded-[12px] bg-surface shadow-overlay"
            style={{ bottom: position.bottom, left: position.left, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
          >
            <ScrollArea className="p-1.5">
              <GlideMenu className="flex flex-col gap-px" rowSelector="[data-row]" highlightClassName="inset-x-0 rounded-[8px] bg-hover">
                <HostRow id="this-mac" name={thisMac} line="This Mac" tone="online" gearLabel={`${thisMac} settings: devices`} onGear={pick(() => onOpenSettings(null))} />
                {computers.map((computer) => (
                  <HostRow
                    key={computer.id}
                    id={computer.id}
                    name={computer.name}
                    line={routeLine(computer, now)}
                    tone={computerTone(computer)}
                    gearLabel={settingsTooltip(computer.name)}
                    onGear={pick(() => onOpenSettings(computer.id))}
                  />
                ))}
              </GlideMenu>
              <div className="mx-1.5 my-1 h-px bg-line" />
              <button
                type="button"
                data-menu-row
                data-add-computer-row
                onClick={pick(onAddComputer)}
                className="flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] text-ink-2 outline-none hover:bg-hover focus-visible:bg-hover"
              >
                {icon(Add01Icon, 16)}
                Add computer
              </button>
            </ScrollArea>
          </div>,
          document.body,
        )}
    </>
  );
}
```

- [ ] **Step 4: Put it in the footer**

In `apps/desktop/app/src/components/SidebarNav.tsx`, import `import { ComputersButton } from "./sidebar/ComputersButton";`. Add to `SidebarNavProps`:

```ts
  /** Opens Add computer. */
  onAddComputer?: () => void;
  /** Opens a computer's settings; null for This Mac (Settings › Devices). */
  onOpenComputerSettings?: (id: string | null) => void;
```

Destructure `onAddComputer` and `onOpenComputerSettings` in `SidebarNav`. In the footer, after the Link projects `Tooltip` block (just before the `</div>` that closes the left button group), add:

```tsx
              {onAddComputer && onOpenComputerSettings && (
                <ComputersButton collapsed={collapsed} buttonClassName={BOTTOM_BAR_BUTTON} onAddComputer={onAddComputer} onOpenSettings={onOpenComputerSettings} />
              )}
```

- [ ] **Step 5: The App opens what it asks for**

In `apps/desktop/app/src/App.tsx`:

1. Import `import { AddComputerDialog } from "./components/AddComputerDialog";`.
2. Next to `const [settingsProject, setSettingsProject] = …`, add:

```tsx
  const [settingsComputer, setSettingsComputer] = useState<string | null>(null);
  const [addComputerOpen, setAddComputerOpen] = useState(false);
```

3. Next to `const openSettings = useEvent(…)`, add:

```tsx
  // The computers popover's gears: a computer's own section, or This Mac's devices.
  const openComputerSettings = useEvent((id: string | null) => {
    if (id === null) setSettingsSection("devices");
    else {
      setSettingsComputer(id);
      setSettingsSection("computer");
    }
    setView("settings");
  });
  const selectSettingsComputer = (id: string) => {
    setSettingsComputer(id);
    setSettingsSection("computer");
  };
```

4. After `const linkDialog = …;`, add:

```tsx
  const addComputerDialog = addComputerOpen ? <AddComputerDialog onClose={() => setAddComputerOpen(false)} onAdded={() => setAddComputerOpen(false)} /> : null;
```

and add `{addComputerDialog}` on the line after each `{linkDialog}` (two places).
5. On `<SidebarNav … />` (the project view) and on `<LinkWorkspace … />` (beside its `onSettings=`), add:

```tsx
              onAddComputer={() => setAddComputerOpen(true)}
              onOpenComputerSettings={openComputerSettings}
```

In `apps/desktop/app/src/components/LinkWorkspace.tsx`, add `onAddComputer?: () => void;` and `onOpenComputerSettings?: (id: string | null) => void;` to its props type, destructure both, and pass `onAddComputer={onAddComputer}` and `onOpenComputerSettings={onOpenComputerSettings}` on its `<SidebarNav` (line 406).

6. On all three `SettingsNav` uses, add `computerId={settingsComputer ?? undefined}` and `onSelectComputer={selectSettingsComputer}`. On all three `SettingsPanel` uses, add `computerId={settingsComputer ?? undefined}`.

- [ ] **Step 6: Run the check and every check that renders the sidebar footer or the App**

Run: `MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-finish" npm test -- --only test-sidebar-computers`
Expected: PASS with three PASS lines; `popover.png` and `popover-gear.png` saved.

Run: `npm test -- --only test-sidebar-all-projects && npm test -- --only test-sidebar-usage && npm test -- --only test-sidebar-resize && npm test -- --only test-allow-computer && npm test -- --only test-settings-devices && npm test -- --only test-link-project-dialog && npm test -- --only test-project-links`
Expected: PASS (`test-sidebar-usage` runs on macOS only).

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/app/src/components/sidebar/ComputersButton.tsx apps/desktop/app/src/components/SidebarNav.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/components/LinkWorkspace.tsx scripts/test-sidebar-computers.cjs
git add apps/desktop/app/src/components/sidebar/ComputersButton.tsx apps/desktop/app/src/components/SidebarNav.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/components/LinkWorkspace.tsx scripts/test-sidebar-computers.cjs
git commit -m "feat(desktop): the footer's computers popover, with each computer's status and settings"
```

---

### Task 10: Phase A is green

**Files:** none new.

- [ ] **Step 1: The repository's checks**

Run: `npm run typecheck && npm run lint && npm test -- --unit`
Expected: PASS for all three.

- [ ] **Step 2: The new checks and the ones Phase A touched**

Run: `npm test -- --only test-add-computer && npm test -- --only test-computer-settings && npm test -- --only test-sidebar-computers && npm test -- --only test-experimental-settings && npm test -- --only test-settings-devices && npm test -- --only test-allow-computer && npm test -- --only test-sidebar-all-projects && npm test -- --only test-linear-settings && npm test -- --only test-worktree-setup`
Expected: PASS for each.

- [ ] **Step 3: By hand, on two Macs (or two user accounts on one)**

On the second Mac: Settings › Devices › on › Pair a device › Copy link. On this Mac: Settings › Experimental › Other computers on, laptop button › Add computer, paste, Add computer, then Allow on the second Mac.
Expected: the popover lists the second Mac with "Same network" (or `relay.milagre.cloud` apart); its gear opens Computer settings with "In use" on the route the popover names; Remove takes it out of the popover.

No commit: nothing changed.

---
## Phase B: every computer's chats in one window (the spec's PR 4)

Phase B ends with every paired computer's Projects in the sidebar, merged by name. Each row says its computer, every call and event goes to the right Mac, local-only actions are gone from remote chats, an offline computer reads from its cache behind a banner, and OS notifications name the computer.

### Task 11: Keys that carry their computer

A remote Project's key is `${computerId}|${path}` and a remote Link's is `milagre-link:${computerId}|${linkId}` (see Decisions); this Mac's keys are unchanged. `isLinkScopeKey` and `scopeKey` must accept the qualified forms (`chat-scopes.mjs:7`, `:11-16` reject them today), while `validLinkId` stays strict, since the daemon validates Link ids with it. `chatKey` takes an optional computer.

**Files:**
- Modify: `packages/shared/src/chat-scopes.mjs`, `packages/shared/src/chat-scopes.d.mts`, `packages/shared/src/chat-scopes.test.ts`
- Modify: `packages/shared/src/agent-runs.mjs:14-20` (`chatKey`), `packages/shared/src/agent-runs.d.mts:49`, `packages/shared/src/agent-runs.test.ts`

**Interfaces:**
- Produces (`@milagre/shared/chat-scopes`, re-exported from `@milagre/shared/agent-runs`):
  - `LOCAL_COMPUTER = "local"`
  - `qualifyKey(computerId: string | null | undefined, key: string): string`. It returns `key` for `local`, for a missing id, or for an already qualified key.
  - `computerOfKey(key: string): string`, which gives `"local"` for this Mac's keys.
  - `unqualifyKey(key: string): string`
- Produces (`@milagre/shared/agent-runs`): `chatKey(projectPath: string, sessionId: number, computerId?: string): string`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/chat-scopes.test.ts`:

```ts
test("a paired computer's keys carry its id, and this Mac's keys are unchanged", async () => {
  const s = await import("./chat-scopes.mjs");
  const id = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const linkId = "f1713d69-569d-405b-a0b2-19bfdf565a76";
  assert.equal(s.LOCAL_COMPUTER, "local");
  assert.equal(s.qualifyKey("local", "/code/app"), "/code/app");
  assert.equal(s.qualifyKey(undefined, "/code/app"), "/code/app");
  assert.equal(s.qualifyKey(id, "/code/app"), `${id}|/code/app`);
  assert.equal(s.qualifyKey(id, `${id}|/code/app`), `${id}|/code/app`, "never twice");
  assert.equal(s.qualifyKey(id, "/code/app#3"), `${id}|/code/app#3`);
  assert.equal(s.qualifyKey(id, `milagre-link:${linkId}`), `milagre-link:${id}|${linkId}`);
  assert.notEqual(s.qualifyKey(id, "/code/app"), "/code/app", "the same path on two Macs is two keys");
  for (const key of ["/code/app", `${id}|/code/app`, `milagre-link:${linkId}`, `milagre-link:${id}|${linkId}#2`, `${id}|/code/my#project#7`, "C:\\code\\app"])
    assert.equal(s.qualifyKey(s.computerOfKey(key), s.unqualifyKey(key)), key, key);
  assert.equal(s.computerOfKey("/code/app#3"), "local");
  assert.equal(s.computerOfKey(`${id}|/code/app#3`), id);
  assert.equal(s.computerOfKey(`milagre-link:${id}|${linkId}#2`), id);
  assert.equal(s.unqualifyKey(`milagre-link:${id}|${linkId}#2`), `milagre-link:${linkId}#2`);
  assert.equal(s.isLinkScopeKey(`milagre-link:${id}|${linkId}`), true);
  assert.equal(s.isLinkScopeKey(`milagre-link:${id}|../outside`), false);
  assert.equal(s.isLinkScopeKey(`${id}|/code/app`), false);
  assert.equal(s.scopeKey({ kind: "project", projectPath: `${id}|/code/app` }), `${id}|/code/app`);
  assert.equal(s.scopeKey({ kind: "link", linkId: `${id}|${linkId}` }), `milagre-link:${id}|${linkId}`);
  assert.throws(() => s.scopeKey({ kind: "project", projectPath: `${id}|relative` }));
  assert.deepEqual(s.scopeFromChatKey(`${id}|/code/app#4`), { kind: "project", projectPath: `${id}|/code/app` });
  assert.deepEqual(s.scopeFromChatKey(`milagre-link:${id}|${linkId}#4`), { kind: "link", linkId: `${id}|${linkId}` });
  assert.equal(s.validLinkId(`${id}|${linkId}`), false, "the daemon's own check of a Link id stays strict");
});
```

Append to `packages/shared/src/agent-runs.test.ts` (it already imports from `./agent-runs.mjs`; add `chatKey`, `projectOfKey`, `chatInProject`, `computerOfKey` to that import if they are not there):

```ts
test("a chat key names its computer when it is another Mac's", () => {
  const id = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  assert.equal(chatKey("/p", 3), "/p#3");
  assert.equal(chatKey("/p", 3, "local"), "/p#3");
  const remote = chatKey("/p", 3, id);
  assert.equal(remote, `${id}|/p#3`);
  assert.equal(projectOfKey(remote), `${id}|/p`);
  assert.equal(computerOfKey(remote), id);
  assert.equal(chatInProject(`${id}|/p`, remote), true);
  assert.equal(chatInProject("/p", remote), false, "this Mac's /p is another Project");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- --unit --workspace shared`
Expected: FAIL (`s.qualifyKey is not a function`, `computerOfKey is not a function`).

- [ ] **Step 3: `chat-scopes.mjs`**

Replace `packages/shared/src/chat-scopes.mjs` with:

```js
const LINK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PREFIX = "milagre-link:";
// A paired computer's keys carry its id in front of what this Mac's keys have (spec "Renderer"): `${computerId}|${path}`
// for a Project and `milagre-link:${computerId}|${linkId}` for a Link, so code that slices the Link prefix off gets a
// Link id that still names its computer. "local" is this Mac, whose keys carry nothing.
export const LOCAL_COMPUTER = "local";
const COMPUTER_ID = /^[A-Za-z0-9-]{1,64}$/;
const QUALIFIER = /^([A-Za-z0-9-]{1,64})\|/;

/** Whether a key is a Link's, its computer, and the key without it. */
function parts(key) {
  const link = key.startsWith(PREFIX);
  const rest = link ? key.slice(PREFIX.length) : key;
  const match = QUALIFIER.exec(rest);
  return { link, computerId: match ? match[1] : LOCAL_COMPUTER, bare: match ? rest.slice(match[0].length) : rest };
}

/** The computer a scope or chat key belongs to; "local" for this Mac's. */
export function computerOfKey(key) {
  return typeof key === "string" ? parts(key).computerId : LOCAL_COMPUTER;
}

/** The key as its own computer knows it. */
export function unqualifyKey(key) {
  if (typeof key !== "string") return key;
  const { link, bare } = parts(key);
  return link ? PREFIX + bare : bare;
}

/** A computer's key as this window keeps it: unchanged for this Mac, and for a key that already names a computer. */
export function qualifyKey(computerId, key) {
  if (typeof key !== "string" || !computerId || computerId === LOCAL_COMPUTER || !COMPUTER_ID.test(computerId)) return key;
  const { link, computerId: current, bare } = parts(key);
  if (current !== LOCAL_COMPUTER) return key;
  return link ? `${PREFIX}${computerId}|${bare}` : `${computerId}|${key}`;
}

export function validLinkId(id) {
  return typeof id === "string" && LINK_ID.test(id);
}
export function isLinkScopeKey(key) {
  return typeof key === "string" && key.startsWith(PREFIX) && validLinkId(parts(key).bare);
}

const absolute = (value) => value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);

export function scopeKey(scope) {
  if (scope?.kind === "link" && typeof scope.linkId === "string" && validLinkId(parts(PREFIX + scope.linkId).bare)) return PREFIX + scope.linkId;
  if (scope?.kind === "project" && typeof scope.projectPath === "string" && absolute(parts(scope.projectPath).bare)) return scope.projectPath;
  throw new Error("Choose a valid Project or Link.");
}

export function scopeFromKey(key) {
  return isLinkScopeKey(key) ? { kind: "link", linkId: key.slice(PREFIX.length) } : { kind: "project", projectPath: key };
}

export function chatKeyForScope(scope, sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Invalid Chat ID.");
  return `${scopeKey(scope)}#${sessionId}`;
}

export function scopeFromChatKey(key) {
  if (typeof key !== "string" || !/#\d+$/.test(key)) throw new Error("Invalid Chat key.");
  const owner = key.slice(0, key.lastIndexOf("#"));
  const scope = scopeFromKey(owner);
  scopeKey(scope);
  return scope;
}
```

Append to `packages/shared/src/chat-scopes.d.mts`:

```ts
export const LOCAL_COMPUTER: "local";
export function computerOfKey(key: unknown): string;
export function unqualifyKey<T>(key: T): T;
export function qualifyKey<T>(computerId: string | null | undefined, key: T): T;
```

- [ ] **Step 4: `chatKey` takes a computer**

In `packages/shared/src/agent-runs.mjs`, add after the `hasTranscriptTail` import:

```js
import { qualifyKey } from "./chat-scopes.mjs";

export { LOCAL_COMPUTER, computerOfKey, qualifyKey, unqualifyKey } from "./chat-scopes.mjs";
```

and replace `chatKey` with:

```js
/**
 * Names a chat for the agent host. Session ids are counters per project, so every project has
 * a chat 2; the key carries the project path so chats in different projects never share a session.
 * `computerId`: a paired computer's chat carries its id (`${computerId}|${path}#${id}`); this Mac's doesn't.
 */
export function chatKey(projectPath, sessionId, computerId) {
  return `${qualifyKey(computerId, projectPath)}#${sessionId}`;
}
```

In `packages/shared/src/agent-runs.d.mts`, replace the `chatKey` line with `export function chatKey(projectPath: string, sessionId: number, computerId?: string): string;` and add:

```ts
export { LOCAL_COMPUTER, computerOfKey, qualifyKey, unqualifyKey } from "./chat-scopes.mjs";
```

- [ ] **Step 5: Run every workspace that reads these keys**

Run: `npm test -- --unit --workspace shared && npm test -- --unit --workspace daemon && npm test -- --unit --workspace desktop && npm test -- --unit --workspace mobile && npm run typecheck && npm run typecheck --workspace @milagre/mobile`
Expected: PASS. This Mac's keys behave as before everywhere, and the phone bundles both modules.

- [ ] **Step 6: Commit**

```bash
npx oxfmt packages/shared/src/chat-scopes.mjs packages/shared/src/chat-scopes.d.mts packages/shared/src/chat-scopes.test.ts packages/shared/src/agent-runs.mjs packages/shared/src/agent-runs.d.mts packages/shared/src/agent-runs.test.ts
git add packages/shared/src/chat-scopes.mjs packages/shared/src/chat-scopes.d.mts packages/shared/src/chat-scopes.test.ts packages/shared/src/agent-runs.mjs packages/shared/src/agent-runs.d.mts packages/shared/src/agent-runs.test.ts
git commit -m "feat(shared): scope and chat keys that name a paired computer"
```

---

### Task 12: Main strips the computer on the way out and names it on the way in

`computers-ipc.cjs` sends a remote call with every `${computerId}|` removed from its arguments, and qualifies the identities in what comes back: Project paths, Link ids, chat keys and the keys of run and port maps. It does the same for the computer's events. A local-only channel is refused for a computer with "Not available on a remote computer", and `project:open-at` reaches the daemon as `project:open`.

**Files:**
- Create: `apps/desktop/electron/computer-routing.cjs`, `apps/desktop/electron/computer-routing.test.cjs`
- Modify: `apps/desktop/electron/computers-ipc.cjs` (`computers:invoke`, `event`), `apps/desktop/electron/computers-ipc.test.cjs`
- Modify: `apps/desktop/tsconfig.electron.json` (add `electron/computer-routing.cjs`)

**Interfaces:**
- Consumes: `qualifyKey` (Task 11).
- Produces (`computer-routing.cjs`):
  - `LOCAL_ONLY: readonly string[]` and `LOCAL_ONLY_PREFIXES: readonly string[]`, which must equal the preload's (Task 13).
  - `isLocalOnly(channel: string): boolean`
  - `ALIASES: Record<string, string>` (`{ "project:open-at": "project:open" }`)
  - `NOT_REMOTE = "Not available on a remote computer"`
  - `stripComputer(computerId: string, value: unknown): unknown`
  - `qualifyEvent(computerId: string, channel: string, payload: unknown): unknown`
  - `qualifyResult(computerId: string, method: string, result: unknown): unknown`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/electron/computer-routing.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LOCAL_ONLY, LOCAL_ONLY_PREFIXES, isLocalOnly, ALIASES, stripComputer, qualifyEvent, qualifyResult } = require("./computer-routing.cjs");

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const LINK = "f1713d69-569d-405b-a0b2-19bfdf565a76";

test("a call to a computer loses that computer's id everywhere in its arguments, and only that one", () => {
  assert.deepEqual(
    stripComputer(ID, [{ projectPath: `${ID}|/p`, chatId: `${ID}|/p#2`, nested: [`milagre-link:${ID}|${LINK}`], images: ["data:image/png;base64,AAAA"] }, `${ID}|${LINK}`, 7, null]),
    [{ projectPath: "/p", chatId: "/p#2", nested: [`milagre-link:${LINK}`], images: ["data:image/png;base64,AAAA"] }, LINK, 7, null],
  );
  assert.equal(stripComputer(ID, `${OTHER}|/p`), `${OTHER}|/p`);
});

test("a computer's events and results come back naming it", () => {
  assert.deepEqual(qualifyEvent(ID, "project:state", { path: "/p", patch: [] }), { path: `${ID}|/p`, patch: [] });
  assert.deepEqual(qualifyEvent(ID, "link:state", { linkId: LINK, state: {} }), { linkId: `${ID}|${LINK}`, state: {} });
  assert.deepEqual(qualifyEvent(ID, "agent:event", { chatId: "/p#2", event: { type: "turn-started" } }), { chatId: `${ID}|/p#2`, event: { type: "turn-started" } });
  assert.deepEqual(qualifyEvent(ID, "terminal:changed", { chatId: "/p#2" }), { chatId: `${ID}|/p#2` });
  assert.deepEqual(qualifyEvent(ID, "worktree:renamed", { projectPath: "/p", path: "/w", from: "a", name: "b" }), { projectPath: `${ID}|/p`, path: "/w", from: "a", name: "b" });
  assert.deepEqual(qualifyEvent(ID, "notification:waiting", { chatId: "/p#2", title: "t" }), { chatId: `${ID}|/p#2`, title: "t" });
  assert.deepEqual(qualifyEvent(ID, "agent:ports", { "/p#2": [{ port: 3000 }] }), { [`${ID}|/p#2`]: [{ port: 3000 }] });
  assert.deepEqual(
    qualifyEvent(ID, "runtime:snapshot", { projects: [{ path: "/p", name: "p", state: {} }], links: [{ linkId: LINK, state: {} }], runs: { runs: { "/p#2": { text: "" } }, seq: 4 }, ports: { "/p#2": [] }, eventSeq: 9 }),
    { projects: [{ path: `${ID}|/p`, name: "p", state: {} }], links: [{ linkId: `${ID}|${LINK}`, state: {} }], runs: { runs: { [`${ID}|/p#2`]: { text: "" } }, seq: 4 }, ports: { [`${ID}|/p#2`]: [] }, eventSeq: 9 },
  );
  assert.deepEqual(qualifyEvent(ID, "agent:cli-progress", { provider: "codex" }), { provider: "codex" });

  assert.deepEqual(qualifyResult(ID, "project:switch", { path: "/p", name: "p", state: {} }), { path: `${ID}|/p`, name: "p", state: {} });
  assert.deepEqual(qualifyResult(ID, "project:recent", [{ path: "/p", name: "p" }]), [{ path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(qualifyResult(ID, "project:registry", [{ id: "/p/.git", path: "/p", name: "p" }]), [{ id: "/p/.git", path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(qualifyResult(ID, "link:list", [{ id: LINK, name: "L", projectIds: ["/p/.git"] }]), [{ id: `${ID}|${LINK}`, name: "L", projectIds: ["/p/.git"] }]);
  assert.deepEqual(qualifyResult(ID, "link:open", { link: { id: LINK }, state: {}, projects: [{ id: "/p/.git", path: "/p", name: "p" }] }), {
    link: { id: `${ID}|${LINK}` },
    state: {},
    projects: [{ id: "/p/.git", path: `${ID}|/p`, name: "p" }],
  });
  assert.deepEqual(qualifyResult(ID, "link:snapshot", { link: { id: LINK }, state: {} }), { link: { id: `${ID}|${LINK}` }, state: {} });
  assert.deepEqual(qualifyResult(ID, "chat:runs", { runs: { "/p#2": {} }, seq: 1 }), { runs: { [`${ID}|/p#2`]: {} }, seq: 1 });
  assert.deepEqual(qualifyResult(ID, "worktree:create", { project: { path: "/p", state: {} }, worktreeId: 2 }), { project: { path: `${ID}|/p`, state: {} }, worktreeId: 2 });
  assert.deepEqual(qualifyResult(ID, "terminal:list", { terminals: [{ id: "t", chatId: "/p#2" }] }), { terminals: [{ id: "t", chatId: `${ID}|/p#2` }] });
  assert.deepEqual(qualifyResult(ID, "terminal:open", { id: "t", chatId: "/p#2" }), { id: "t", chatId: `${ID}|/p#2` });
  assert.deepEqual(qualifyResult(ID, "accounts:scopes", [{ key: "/p", projects: [{ path: "/p" }] }]), [{ key: `${ID}|/p`, projects: [{ path: `${ID}|/p` }] }]);
  assert.equal(qualifyResult(ID, "project:switch", null), null);
  assert.deepEqual(qualifyResult(ID, "state:read", { state: { x: 1 }, version: 2, epoch: "e" }), { state: { x: 1 }, version: 2, epoch: "e" });
});

test("this Mac's own actions are local-only, and the preload refuses the same ones", () => {
  for (const channel of ["editor:open", "project:reveal", "skills:open", "skills:reveal", "project:open", "image:menu", "update:install", "notification:state", "settings:notify-when-waiting", "phone:status", "devices:list", "canvas:snapshot", "computers:list", "app:version", "accounts:add"])
    assert.equal(isLocalOnly(channel), true, channel);
  for (const channel of ["project:open-at", "project:switch", "chat:send", "git:push", "skills:list", "attachment:preview", "fs:list-dirs", "media:read", "accounts:scope"])
    assert.equal(isLocalOnly(channel), false, channel);
  assert.equal(ALIASES["project:open-at"], "project:open");
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const list = (name) => {
    const match = new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(preload);
    assert.ok(match, `preload.cjs declares ${name}`);
    return JSON.parse(match[1].replace(/,\s*\]$/, "]"));
  };
  assert.deepEqual(list("LOCAL_ONLY"), [...LOCAL_ONLY]);
  assert.deepEqual(list("LOCAL_ONLY_PREFIXES"), [...LOCAL_ONLY_PREFIXES]);
});
```

The last test reads the preload's lists. They arrive in Task 13, so leave that test failing until then: run this task's steps with `--test-name-pattern "loses|naming it"`.

In `apps/desktop/electron/computers-ipc.test.cjs`, replace the third test with:

```js
test("a call to a computer goes out without its id and comes back naming it, and its events reach every window named too", async () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const invoked = [];
  const { ipc, call, sent } = setup({
    invoke: async (id, method, args) => {
      invoked.push([id, method, args]);
      return method === "project:switch" ? { path: "/p", name: "p", state: {} } : null;
    },
  });
  ipc.event(ID, "project:state", { path: "/p" });
  assert.deepEqual(sent, [["computers:event", { computerId: ID, channel: "project:state", payload: { path: `${ID}|/p` } }]]);
  assert.deepEqual(await call("computers:invoke", ID, "project:switch", [`${ID}|/p`]), { path: `${ID}|/p`, name: "p", state: {} });
  await call("computers:invoke", ID, "project:open-at", [`${ID}|/q`, { takeNotice: true }]);
  assert.deepEqual(invoked, [
    [ID, "project:switch", ["/p"]],
    [ID, "project:open", ["/q", { takeNotice: true }]],
  ]);
  await assert.rejects(call("computers:invoke", ID, "project:reveal", ["/p"]), { message: "Not available on a remote computer" });
  assert.equal(invoked.length, 2, "a local-only call never reaches the computer");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-name-pattern "loses|naming it|goes out without" apps/desktop/electron/computer-routing.test.cjs apps/desktop/electron/computers-ipc.test.cjs`
Expected: FAIL (`Cannot find module './computer-routing.cjs'`).

- [ ] **Step 3: `computer-routing.cjs`**

Create `apps/desktop/electron/computer-routing.cjs`:

```js
const { qualifyKey } = require("@milagre/shared/chat-scopes");

// What only this Mac's own window does (spec "Routing": its editors and Finder, the folder dialog, image menus that read
// local paths, notification settings, updates), plus its own host, devices, accounts, canvas and Links across Projects.
// preload.cjs keeps the same two lists and refuses them before any IPC; computer-routing.test.cjs compares them.
const LOCAL_ONLY = Object.freeze([
  "project:open",
  "project:reveal",
  "skills:open",
  "skills:reveal",
  "runtime:connection",
  "runtime:restart-host",
  "accounts:list",
  "accounts:add",
  "accounts:select",
  "accounts:login",
  "accounts:cancel",
  "accounts:remove",
  "agent:update-cli",
  "linear:connect",
  "linear:disconnect",
]);
const LOCAL_ONLY_PREFIXES = Object.freeze(["app:", "canvas:", "computers:", "devices:", "editor:", "image:", "linked:", "notification:", "phone:", "settings:", "update:", "usage:"]);
const NOT_REMOTE = "Not available on a remote computer";
/** @param {string} channel */
const isLocalOnly = (channel) => LOCAL_ONLY.includes(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix));
// The window's names for calls whose daemon method is named otherwise: Add project's remote folder picker opens a path.
/** @type {Readonly<Record<string, string>>} */
const ALIASES = Object.freeze({ "project:open-at": "project:open" });

/**
 * A remote call's arguments without `${computerId}|` anywhere. Computer ids are UUIDs, so a UUID and a bar never appear
 * in a path, a chat key or a message by chance.
 * @param {string} computerId @param {unknown} value @returns {any}
 */
function stripComputer(computerId, value, depth = 0) {
  const mark = `${computerId}|`;
  if (typeof value === "string") return value.includes(mark) ? value.split(mark).join("") : value;
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripComputer(computerId, item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [stripComputer(computerId, key, depth + 1), stripComputer(computerId, item, depth + 1)]));
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** @param {string} id @param {unknown} value */
const key = (id, value) => (typeof value === "string" ? qualifyKey(id, value) : value);
/** A Link id (a bare UUID) as the window keeps a computer's. @param {string} id @param {unknown} linkId */
const linkId = (id, linkId) => (typeof linkId === "string" && !linkId.includes("|") ? `${id}|${linkId}` : linkId);
/** `value` with its `name` field passed through `how`. @param {string} id @param {any} value @param {string} name @param {(id: string, value: any) => unknown} how */
const field = (id, value, name, how) => (isObject(value) && name in value ? { ...value, [name]: how(id, value[name]) } : value);
/** A map keyed by chat key. @param {string} id @param {any} record */
const keyed = (id, record) => (isObject(record) ? Object.fromEntries(Object.entries(record).map(([chat, item]) => [key(id, chat), item])) : record);
/** @param {string} id @param {any} list @param {(id: string, item: any) => any} how */
const each = (id, list, how) => (Array.isArray(list) ? list.map((item) => how(id, item)) : list);
const withPath = (id, item) => field(id, item, "path", key);
const withChat = (id, item) => field(id, item, "chatId", key);
const withLink = (id, item) => field(id, item, "id", linkId);

/** @type {Record<string, (id: string, payload: any) => any>} */
const EVENTS = {
  "project:state": withPath,
  "link:state": (id, payload) => field(id, payload, "linkId", linkId),
  "agent:event": withChat,
  "terminal:changed": withChat,
  "notification:waiting": withChat,
  "worktree:renamed": (id, payload) => field(id, payload, "projectPath", key),
  "agent:ports": keyed,
  "runtime:snapshot": (id, snapshot) =>
    isObject(snapshot)
      ? {
          ...snapshot,
          projects: each(id, snapshot.projects, withPath),
          ...(snapshot.links ? { links: each(id, snapshot.links, (id, item) => field(id, item, "linkId", linkId)) } : {}),
          runs: field(id, snapshot.runs, "runs", keyed),
          ports: keyed(id, snapshot.ports),
        }
      : snapshot,
};

const OPEN_PROJECT = (id, result) => withPath(id, result);
const PROJECT_LIST = (id, result) => each(id, result, withPath);
/** @type {Record<string, (id: string, result: any) => any>} */
const RESULTS = {
  "project:open": OPEN_PROJECT,
  "project:current": OPEN_PROJECT,
  "project:switch": OPEN_PROJECT,
  "project:read": OPEN_PROJECT,
  "project:recent": PROJECT_LIST,
  "project:set-hidden": PROJECT_LIST,
  "project:forget": PROJECT_LIST,
  "project:registry": PROJECT_LIST,
  "project:position": PROJECT_LIST,
  "link:list": (id, result) => each(id, result, withLink),
  "link:create": withLink,
  "link:update": withLink,
  "link:snapshot": (id, result) => field(id, result, "link", withLink),
  "link:open": (id, result) => (isObject(result) ? { ...field(id, result, "link", withLink), projects: each(id, result.projects, withPath) } : result),
  "chat:runs": (id, result) => field(id, result, "runs", keyed),
  "agent:ports": keyed,
  "worktree:create": (id, result) => field(id, result, "project", withPath),
  "terminal:list": (id, result) => field(id, result, "terminals", (id, list) => each(id, list, withChat)),
  "terminal:open": withChat,
  "accounts:scopes": (id, result) => each(id, result, (id, scope) => field(id, field(id, scope, "key", key), "projects", (id, list) => each(id, list, withPath))),
};

/** A computer's event as the window keeps it: its Project paths, Link ids and chat keys name the computer. */
const qualifyEvent = (computerId, channel, payload) => (EVENTS[channel] ? EVENTS[channel](computerId, payload) : payload);
/** The same for one call's result. */
const qualifyResult = (computerId, method, result) => (RESULTS[method] ? RESULTS[method](computerId, result) : result);

module.exports = { LOCAL_ONLY, LOCAL_ONLY_PREFIXES, NOT_REMOTE, isLocalOnly, ALIASES, stripComputer, qualifyEvent, qualifyResult };
```

- [ ] **Step 4: `computers-ipc.cjs` routes through it**

In `apps/desktop/electron/computers-ipc.cjs`, add at the top:

```js
const { ALIASES, NOT_REMOTE, isLocalOnly, qualifyEvent, qualifyResult, stripComputer } = require("./computer-routing.cjs");
```

Replace the `computers:invoke` handler with:

```js
  // One call on a computer: this Mac's own actions are refused, its id leaves the arguments, and what comes back names it.
  ipcMain.handle("computers:invoke", async (_event, id, channel, args) => {
    const computerId = String(id);
    const name = String(channel);
    if (isLocalOnly(name)) throw new Error(NOT_REMOTE);
    const method = ALIASES[name] ?? name;
    const result = await computers.invoke(computerId, method, stripComputer(computerId, Array.isArray(args) ? args : []));
    return qualifyResult(computerId, method, result);
  });
```

and the returned `event` with:

```js
    event: (computerId, channel, payload) => send("computers:event", { computerId, channel, payload: qualifyEvent(computerId, channel, payload) }),
```

Add `"electron/computer-routing.cjs"` to `include` in `apps/desktop/tsconfig.electron.json`.

- [ ] **Step 5: Run the tests**

Run: `node --test --test-name-pattern "loses|naming it|goes out without|tells the asking|reads this Mac" apps/desktop/electron/computer-routing.test.cjs apps/desktop/electron/computers-ipc.test.cjs && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx oxfmt apps/desktop/electron/computer-routing.cjs apps/desktop/electron/computer-routing.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/tsconfig.electron.json
git add apps/desktop/electron/computer-routing.cjs apps/desktop/electron/computer-routing.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/tsconfig.electron.json
git commit -m "feat(desktop): calls to a computer go without its id and come back naming it"
```

---
### Task 13: One bridge for this Mac and for every computer

The preload builds `window.milagre` from one factory, and `window.milagre.on(computerId)` gets the same calls carried to a paired computer, with its events. The existing flat calls stay as this Mac's (spec "Routing"). A remote bridge refuses local-only channels before any IPC. In the renderer, `bridgeFor(computerId)` and `bridgeForKey(key)` choose the bridge, `useBridge()` reads the one App provides for the Project on screen, and `onAnyAgentEvent` hears every computer's agent events.

**Files:**
- Modify: `apps/desktop/electron/preload.cjs` (rewritten)
- Modify: `apps/desktop/app/src/electron.d.ts` (`MilagreBridge`)
- Create: `apps/desktop/app/src/lib/computer-bridge.ts`, `apps/desktop/app/src/lib/computer-bridge.test.ts`

**Interfaces:**
- Consumes: `computerOfKey`, `LOCAL_COMPUTER` (Task 11); the `computers:*` IPC (Tasks 4, 12).
- Produces:
  - `type MilagreBridge`: every member of today's `window.milagre`, except the window-level `on`, `computers`, `onComputersChanged`, `onComputerAddPending` and `onComputerEvent`.
  - `window.milagre: MilagreBridge & { on(computerId: string): MilagreBridge; computers; onComputersChanged; onComputerAddPending; onComputerEvent }`
  - From `lib/computer-bridge.ts`:
    - `bridgeFor(computerId: string | null | undefined): MilagreBridge`
    - `bridgeForKey(key: string | null | undefined): MilagreBridge`
    - `isRemoteKey(key: string | null | undefined): boolean`
    - `forgetBridge(computerId: string): void`
    - `BridgeContext` and `useBridge(): MilagreBridge`
    - `onAnyAgentEvent(callback: (payload: AgentEventPayload) => void): () => void`

- [ ] **Step 1: Write the failing renderer test**

Create `apps/desktop/app/src/lib/computer-bridge.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const made: string[] = [];
const local = { name: "local", onAgentEvent: (callback: any) => ((localAgent = callback), () => (localAgent = null)), onComputerEvent: (callback: any) => ((computerEvent = callback), () => (computerEvent = null)) };
let localAgent: ((payload: any) => void) | null = null;
let computerEvent: ((event: any) => void) | null = null;
(globalThis as any).window = { milagre: { ...local, on: (id: string) => (made.push(id), { name: id }) } };
const { bridgeFor, bridgeForKey, isRemoteKey, forgetBridge, onAnyAgentEvent } = await import("./computer-bridge.ts");

test("this Mac's keys use window.milagre, a computer's use its own bridge, made once", () => {
  assert.equal(bridgeForKey("/code/app#2"), (globalThis as any).window.milagre);
  assert.equal(bridgeFor("local"), (globalThis as any).window.milagre);
  assert.equal(bridgeFor(null), (globalThis as any).window.milagre);
  assert.deepEqual(bridgeForKey(`${ID}|/code/app#2`), { name: ID });
  assert.equal(bridgeForKey(`milagre-link:${ID}|f1713d69-569d-405b-a0b2-19bfdf565a76`), bridgeFor(ID));
  assert.deepEqual(made, [ID]);
  forgetBridge(ID);
  bridgeFor(ID);
  assert.deepEqual(made, [ID, ID]);
  assert.equal(isRemoteKey(`${ID}|/p`), true);
  assert.equal(isRemoteKey("/p"), false);
  assert.equal(isRemoteKey(null), false);
});

test("agent events from this Mac and from every computer reach one listener", () => {
  const heard: any[] = [];
  const off = onAnyAgentEvent((payload) => heard.push(payload.chatId));
  localAgent!({ chatId: "/p#1", event: { type: "turn-started" } });
  computerEvent!({ computerId: ID, channel: "agent:event", payload: { chatId: `${ID}|/p#1`, event: { type: "turn-started" } } });
  computerEvent!({ computerId: ID, channel: "project:state", payload: { path: `${ID}|/p` } });
  assert.deepEqual(heard, ["/p#1", `${ID}|/p#1`]);
  off();
  assert.equal(localAgent, null);
  assert.equal(computerEvent, null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/desktop/app/src/lib/computer-bridge.test.ts`
Expected: FAIL (`Cannot find module './computer-bridge.ts'`).

- [ ] **Step 3: `computer-bridge.ts`**

Create `apps/desktop/app/src/lib/computer-bridge.ts`:

```ts
import { createContext, useContext } from "react";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { MilagreBridge } from "../electron";

type AgentEventPayload = Parameters<Parameters<MilagreBridge["onAgentEvent"]>[0]>[0];

const remotes = new Map<string, MilagreBridge>();

/** One computer's calls (spec "Routing"): this Mac's window.milagre, or a paired computer's, carried there by main. */
export function bridgeFor(computerId: string | null | undefined): MilagreBridge {
  if (!computerId || computerId === LOCAL_COMPUTER) return window.milagre;
  let bridge = remotes.get(computerId);
  if (!bridge) {
    bridge = window.milagre.on(computerId);
    remotes.set(computerId, bridge);
  }
  return bridge;
}

/** The calls of the computer a scope or chat key belongs to. */
export const bridgeForKey = (key: string | null | undefined) => bridgeFor(key ? computerOfKey(key) : LOCAL_COMPUTER);

/** Whether a scope or chat key is another Mac's. */
export const isRemoteKey = (key: string | null | undefined) => Boolean(key) && computerOfKey(key!) !== LOCAL_COMPUTER;

/** Drops a removed computer's bridge. */
export function forgetBridge(computerId: string) {
  remotes.delete(computerId);
}

/** The bridge of the Project or Link on screen, which App provides; this Mac's anywhere else. */
export const BridgeContext = createContext<MilagreBridge | null>(null);
export function useBridge(): MilagreBridge {
  return useContext(BridgeContext) ?? window.milagre;
}

/** Agent events from this Mac and from every paired computer, raw (keys already name their computer). */
export function onAnyAgentEvent(callback: (payload: AgentEventPayload) => void) {
  const offLocal = window.milagre.onAgentEvent(callback);
  const offRemote = window.milagre.onComputerEvent?.((event) => {
    if (event.channel === "agent:event") callback(event.payload);
  });
  return () => {
    offLocal();
    offRemote?.();
  };
}
```

- [ ] **Step 4: The `MilagreBridge` type**

In `apps/desktop/app/src/electron.d.ts`, just above `declare global {`, add `export type MilagreBridge = {` and move into it every member of today's `milagre: { … }`, from `simulators: SimulatorApi;` through `onOpenPhoneSettings: …;`, except the four computer members added in Task 4. Close it with `};`. Then make the global declaration:

```ts
declare global {
  interface Window {
    milagre: MilagreBridge & {
      /** The same calls on a paired computer, carried there by main; this Mac's own actions refuse with "Not available on a remote computer". */
      on: (computerId: string) => MilagreBridge;
      computers: ComputersApi;
      onComputersChanged: (callback: (snapshot: ComputersSnapshot) => void) => () => void;
      /** The computer being added is waiting for its owner's Allow. */
      onComputerAddPending: (callback: () => void) => () => void;
      /** Every computer's runtime events. */
      onComputerEvent: (callback: (event: ComputerEvent) => void) => () => void;
    };
  }
}
```

- [ ] **Step 5: The preload, rewritten**

Replace `apps/desktop/electron/preload.cjs` with:

```js
// @ts-check
/** @typedef {typeof import("../app/src/electron.d.ts")} BridgeTypes */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// What only this Mac's own window does: its editors and Finder, the folder dialog, the clipboard and image menus,
// notifications, updates, its own host, devices and accounts. A paired computer's bridge refuses them before any IPC,
// and main refuses them again (computer-routing.cjs keeps the same lists; computer-routing.test.cjs compares them).
const NOT_REMOTE = "Not available on a remote computer";
const LOCAL_ONLY = [
  "project:open",
  "project:reveal",
  "skills:open",
  "skills:reveal",
  "runtime:connection",
  "runtime:restart-host",
  "accounts:list",
  "accounts:add",
  "accounts:select",
  "accounts:login",
  "accounts:cancel",
  "accounts:remove",
  "agent:update-cli",
  "linear:connect",
  "linear:disconnect",
];
const LOCAL_ONLY_PREFIXES = ["app:", "canvas:", "computers:", "devices:", "editor:", "image:", "linked:", "notification:", "phone:", "settings:", "update:", "usage:"];
/** @param {string} channel */
const isLocalOnly = (channel) => LOCAL_ONLY.includes(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix));

/**
 * Every call and event the window has, over whatever carries them: this Mac's IPC, or a paired computer's through main.
 * @param {(channel: string, ...args: any[]) => Promise<any>} invoke
 * @param {(channel: string, callback: (payload: any) => void) => () => void} listen
 * @param {(channel: string, ...args: any[]) => void} send
 * @returns {import("../app/src/electron.d.ts").MilagreBridge}
 */
function makeBridge(invoke, listen, send) {
  return {
    simulators: {
      list: (request) => invoke("simulator:list", request),
      attach: (request) => invoke("simulator:attach", request),
      detach: (request) => invoke("simulator:detach", request),
      open: (request) => invoke("simulator:open", request),
      offer: (request) => invoke("simulator:offer", request),
      status: (request) => invoke("simulator:status", request),
      control: (request) => invoke("simulator:control", request),
      input: (request) => invoke("simulator:input", request),
      close: (request) => invoke("simulator:close", request),
    },
    browsers: {
      list: (request) => invoke("browser:list", request),
      attach: (request) => invoke("browser:attach", request),
      open: (request) => invoke("browser:open", request),
      frame: (request) => invoke("browser:frame", request),
      status: (request) => invoke("browser:status", request),
      control: (request) => invoke("browser:control", request),
      input: (request) => invoke("browser:input", request),
      close: (request) => invoke("browser:close", request),
    },
    terminals: {
      list: (request) => invoke("terminal:list", request),
      open: (request) => invoke("terminal:open", request),
      read: (request) => invoke("terminal:read", request),
      input: (request) => invoke("terminal:input", request),
      resize: (request) => invoke("terminal:resize", request),
      close: (request) => invoke("terminal:close", request),
    },
    onTerminalsChanged: (callback) => listen("terminal:changed", callback),
    // ⌘W closes the focused Terminal instead of the window; the main process needs to know where focus is to decide.
    setTerminalFocused: (focused) => send("app:terminal-focused", focused === true),
    onCloseFocusedTerminal: (callback) => listen("app:close-focused-terminal", () => callback()),
    artifacts: {
      get: (request) => invoke("artifact:get", request),
      list: (request) => invoke("artifact:list", request),
      addComments: (request) => invoke("artifact:add-comments", request),
      comments: (request) => invoke("artifact:comments", request),
    },
    getRuntimeConnection: () => invoke("runtime:connection"),
    restartHost: () => invoke("runtime:restart-host"),
    onRuntimeConnection: (callback) => listen("runtime:connection", callback),
    onRuntimeSnapshot: (callback) => listen("runtime:snapshot", callback),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    readAttachment: (file) => invoke("attachment:preview", file),
    searchProjectFiles: (root, query) => invoke("project:files", root, query),
    listSkills: (projectPath) => invoke("skills:list", projectPath),
    readSkill: (projectPath, file) => invoke("skills:read", projectPath, file),
    openSkill: (request) => invoke("skills:open", request),
    revealSkill: (projectPath, file) => invoke("skills:reveal", projectPath, file),
    listBranches: (projectPath) => invoke("project:branches", projectPath),
    getProjectImage: (projectPath) => invoke("project:image", projectPath),
    setProjectIcon: (projectPath, icon) => invoke("project:set-icon", projectPath, icon),
    getAppVersion: () => invoke("app:version"),
    createWorktree: (request) => invoke("worktree:create", request),
    getWorktreeRoots: () => invoke("worktree:roots"),
    getWorktreeStatus: (worktreePath, base) => invoke("worktree:status", worktreePath, base),
    removeWorktree: (worktreePath, options) => invoke("worktree:remove", worktreePath, options),
    readFilesToCopy: (projectPath) => invoke("files-to-copy:read", projectPath),
    previewFilesToCopy: (projectPath, patterns) => invoke("files-to-copy:preview", projectPath, patterns),
    saveFilesToCopy: (projectPath, patterns) => invoke("files-to-copy:save", projectPath, patterns),
    readWorktreeSetup: (projectPath) => invoke("worktree-setup:read", projectPath),
    saveWorktreeSetup: (projectPath, command) => invoke("worktree-setup:save", projectPath, command),
    readMainSync: (projectPath) => invoke("main-sync:read", projectPath),
    saveMainSync: (projectPath, override) => invoke("main-sync:save", projectPath, override),
    readMainSyncDefault: () => invoke("main-sync:default:read"),
    saveMainSyncDefault: (value) => invoke("main-sync:default:save", value),
    onMainSyncStatus: (callback) => listen("main-sync:status", callback),
    readLinearStatus: () => invoke("linear:status"),
    connectLinear: () => invoke("linear:connect"),
    disconnectLinear: () => invoke("linear:disconnect"),
    readLinearEnabled: () => invoke("linear:enabled:read"),
    saveLinearEnabled: (value) => invoke("linear:enabled:save", value),
    onLinearStatusChanged: (callback) => listen("linear:status-changed", callback),
    onWorktreeRenamed: (callback) => listen("worktree:renamed", callback),
    refreshDiffs: (projectPath, worktreeIds) => invoke("worktree:refresh-diffs", projectPath, worktreeIds),
    readPullRequest: (worktreePath) => invoke("worktree:pull-request", worktreePath),
    readPullRequests: (worktreePath, refs) => invoke("worktree:pull-requests", worktreePath, refs),
    revealInFolder: (folder) => invoke("project:reveal", folder),
    copyImage: (file) => invoke("image:copy", file),
    saveImage: (file, name) => invoke("image:save", file, name),
    showImageMenu: (file, name) => invoke("image:menu", file, name),
    git: {
      changes: (request) => invoke("git:changes", request),
      diffFiles: (request) => invoke("git:diff-files", request),
      diffFile: (request) => invoke("git:diff-file", request),
      generate: (request) => invoke("git:generate", request),
      commit: (request) => invoke("git:commit", request),
      push: (request) => invoke("git:push", request),
      openPr: (request) => invoke("git:open-pr", request),
    },
    listEditors: () => invoke("editor:list"),
    openInEditor: (request) => invoke("editor:open", request),
    getCurrentProject: () => invoke("project:current"),
    openProject: () => invoke("project:open"),
    listRecentProjects: () => invoke("project:recent"),
    setProjectHidden: (projectPath, hidden) => invoke("project:set-hidden", projectPath, hidden),
    readProject: (projectPath) => invoke("project:read", projectPath),
    listNamedLinks: () => invoke("link:list"),
    createNamedLink: (request) => invoke("link:create", request),
    updateNamedLink: (request) => invoke("link:update", request),
    openNamedLink: (id) => invoke("link:open", id),
    readLink: (id) => invoke("link:snapshot", id),
    sendLinkMessage: (request) => invoke("link:send", request),
    onLinkState: (callback) => listen("link:state", callback),
    listProjects: () => invoke("project:registry"),
    setProjectPosition: (id, position) => invoke("project:position", id, position),
    getCanvas: () => invoke("canvas:snapshot"),
    addLink: (a, b) => invoke("canvas:link-add", a, b),
    removeLink: (id) => invoke("canvas:link-remove", id),
    setWorktreePosition: (id, worktreePath, position) => invoke("canvas:worktree-position", id, worktreePath, position),
    openCanvasProject: (projectPath) => invoke("canvas:open-project", projectPath),
    getLinkedWork: () => invoke("linked:snapshot"),
    stopNegotiation: (id) => invoke("linked:stop-negotiation", id),
    onAppShortcut: (callback) => listen("app:shortcut", callback),
    onLinkedWork: (callback) => listen("linked:changed", callback),
    switchProject: (projectPath) => invoke("project:switch", projectPath),
    forgetProject: (projectPath) => invoke("project:forget", projectPath),
    retryQuit: () => invoke("app:retry-quit"),
    onQuitFailed: (callback) => listen("app:quit-failed", callback),
    onProjectState: (callback) => listen("project:state", callback),
    sendMessage: (request) => invoke("chat:send", request),
    resumeChat: (projectPath, sessionId) => invoke("chat:resume", projectPath, sessionId),
    patchChat: (projectPath, sessionId, patch) => invoke("chat:patch", projectPath, sessionId, patch),
    archiveSubagent: (projectPath, sessionId, id, archived) => invoke("chat:archive-subagent", projectPath, sessionId, id, archived),
    archiveFinishedSubagents: (projectPath, sessionId) => invoke("chat:archive-finished-subagents", projectPath, sessionId),
    addGitNote: (chatId, body) => invoke("chat:git-note", chatId, body),
    setOpenChat: (chatId) => invoke("chat:set-open", chatId),
    getRuns: () => invoke("chat:runs"),
    getMessage: (scope, id) => invoke("chat:message", scope, id),
    readState: (scope) => invoke("state:read", scope),
    readChatMessages: (scope, chatId, options) => invoke("chat:messages", scope, chatId, options),
    searchChats: (scope, query, options) => invoke("chat:search", scope, query, options),
    readSubagent: (scope, chatId, agentId) => invoke("chat:subagent", scope, chatId, agentId),
    listAccountScopes: () => invoke("accounts:scopes"),
    getProjectAccounts: (scopeKey, refresh) => invoke("accounts:scope", scopeKey, refresh),
    assignProjectAccount: (scopeKey, provider, accountId) => invoke("accounts:assign", scopeKey, provider, accountId),
    getModels: (scopeKey) => invoke("agent:models", scopeKey),
    getCliStatus: (scopeKey) => invoke("agent:cli-status", scopeKey),
    updateCli: (provider) => invoke("agent:update-cli", provider),
    stopAdvisor: (chatId, id) => invoke("advisor:stop", chatId, id),
    retryAdvisor: (chatId, id) => invoke("advisor:retry", chatId, id),
    onCliProgress: (callback) => listen("agent:cli-progress", callback),
    interruptAgent: (chatId) => invoke("agent:interrupt", chatId),
    respondToPermission: (chatId, requestId, decision) => invoke("agent:respond-permission", { chatId, requestId, decision }),
    answerQuestion: (chatId, requestId, answers, summary) => invoke("agent:answer-question", { chatId, requestId, answers, summary }),
    setAgentPermissionMode: (chatId, mode) => invoke("agent:set-permission-mode", { chatId, mode }),
    onAgentEvent: (callback) => listen("agent:event", callback),
    getAgentPorts: () => invoke("agent:ports"),
    stopAgentPort: (chatId, pid) => invoke("agent:stop-port", chatId, pid),
    onAgentPorts: (callback) => listen("agent:ports", callback),
    getUpdateState: () => invoke("update:state"),
    checkForUpdates: () => invoke("update:check"),
    getReleaseChannel: () => invoke("update:channel"),
    setReleaseChannel: (channel) => invoke("update:set-channel", channel),
    installUpdate: () => invoke("update:install"),
    onUpdateState: (callback) => listen("update:state", callback),
    getPhoneStatus: () => invoke("phone:status"),
    setPhoneEnabled: (enabled) => invoke("phone:set-enabled", enabled),
    setPhoneLan: (enabled) => invoke("phone:set-lan", enabled),
    resetPhoneAccess: () => invoke("phone:reset"),
    openPhonePairing: () => invoke("phone:open-pairing"),
    listDevices: () => invoke("devices:list"),
    removeDevice: (key) => invoke("devices:remove", key),
    listPendingDevices: () => invoke("devices:pending"),
    allowDevice: (key) => invoke("devices:allow", key),
    denyDevice: (key) => invoke("devices:deny", key),
    onDevicesPending: (callback) => listen("devices:pending", callback),
    onPhoneStatus: (callback) => listen("phone:status", callback),
    listAccounts: (refresh = false) => invoke("accounts:list", refresh),
    accountAction: (action, provider, value) => invoke(`accounts:${action}`, provider, value),
    onAccountsChanged: (callback) => listen("accounts:changed", () => callback()),
    readUsage: (scopeKey) => invoke("usage:read", scopeKey),
    setKeepAwake: (enabled) => invoke("app:set-keep-awake", enabled),
    getCachedUsage: (scopeKey) => invoke("usage:cached", scopeKey),
    setNotifyWhenWaiting: (on) => invoke("settings:notify-when-waiting", on),
    setWindowTranslucent: (on, theme) => invoke("settings:window-translucent", { on, theme }),
    syncNotifications: (state) => invoke("notification:state", state),
    notifyCompletion: (notice) => invoke("notification:completed", notice),
    onOpenChat: (callback) => listen("notification:open-chat", callback),
    onOpenPhoneSettings: (callback) => listen("notification:open-phone-settings", () => callback()),
  };
}

/** @param {string} channel @param {(payload: any) => void} callback */
function listenHere(channel, callback) {
  /** @param {unknown} _event @param {any} payload */
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** This Mac's own IPC. */
const local = makeBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args), listenHere, (channel, ...args) => ipcRenderer.send(channel, ...args));

/** @type {Map<string, import("../app/src/electron.d.ts").MilagreBridge>} */
const remotes = new Map();
/**
 * A paired computer's bridge (spec "Routing"): the same calls, carried by main to that computer (computers-ipc.cjs), and
 * its events, tagged with it. This Mac's own actions refuse with NOT_REMOTE.
 * @param {string} computerId
 */
function remote(computerId) {
  const id = String(computerId);
  let bridge = remotes.get(id);
  if (!bridge) {
    bridge = makeBridge(
      (channel, ...args) => (isLocalOnly(channel) ? Promise.reject(new Error(NOT_REMOTE)) : ipcRenderer.invoke("computers:invoke", id, channel, args)),
      (channel, callback) =>
        listenHere("computers:event", (event) => {
          if (event?.computerId === id && event.channel === channel) callback(event.payload);
        }),
      () => {},
    );
    remotes.set(id, bridge);
  }
  return bridge;
}

/** @type {Window["milagre"]} */
const bridge = {
  ...local,
  on: remote,
  computers: {
    list: () => ipcRenderer.invoke("computers:list"),
    preview: (link) => ipcRenderer.invoke("computers:preview", link),
    add: (link, options) => ipcRenderer.invoke("computers:add", link, options),
    cancelAdd: () => ipcRenderer.invoke("computers:cancel-add"),
    rename: (id, name) => ipcRenderer.invoke("computers:rename", id, name),
    remove: (id) => ipcRenderer.invoke("computers:remove", id),
    setEnabled: (on) => ipcRenderer.invoke("computers:set-enabled", on),
    invoke: (id, method, args) => ipcRenderer.invoke("computers:invoke", id, method, args),
  },
  onComputersChanged: (callback) => listenHere("computers:changed", callback),
  onComputerAddPending: (callback) => listenHere("computers:pending", () => callback()),
  onComputerEvent: (callback) => listenHere("computers:event", callback),
};
contextBridge.exposeInMainWorld("milagre", bridge);
```

The calls are the old ones, in the old order, with `ipcRenderer.invoke(` replaced by `invoke(` and every listener block by `listen(channel, callback)`. `onCloseFocusedTerminal`, `onAccountsChanged` and `onOpenPhoneSettings` keep calling their callback with no argument.

- [ ] **Step 6: Run the tests, the parity test from Task 12, and the typecheck**

Run: `node --test apps/desktop/app/src/lib/computer-bridge.test.ts apps/desktop/electron/computer-routing.test.cjs && npm run typecheck`
Expected: PASS. The routing test now also passes "this Mac's own actions are local-only, and the preload refuses the same ones".

- [ ] **Step 7: The window still talks to this Mac**

Run: `npm run dev --workspace milagre` and open a chat, send "hello", open Settings › Devices, quit with ⌘Q.
Expected: everything works as before (the preload is the only path the dev app uses; checks fake `window.milagre`).

- [ ] **Step 8: Commit**

```bash
npx oxfmt apps/desktop/electron/preload.cjs apps/desktop/app/src/electron.d.ts apps/desktop/app/src/lib/computer-bridge.ts apps/desktop/app/src/lib/computer-bridge.test.ts
git add apps/desktop/electron/preload.cjs apps/desktop/app/src/electron.d.ts apps/desktop/app/src/lib/computer-bridge.ts apps/desktop/app/src/lib/computer-bridge.test.ts
git commit -m "feat(desktop): one bridge for this Mac and each paired computer"
```

---
### Task 14: One state per computer and scope

`state-events.ts` takes every computer's `project:state`, `link:state` and `agent:event`. Their keys already name the computer (Task 12), so the held states, the reads in flight and the held-back events keep apart without a second index. A state is read again from the Mac it belongs to. Chat windows (`chat-messages.ts`) and the sidebar's scope reads (`sidebar-scopes.ts`) also go to that Mac. Drafts need no code: their keys are scope keys, and the test pins that two Macs' identical paths keep two drafts.

**Files:**
- Modify: `apps/desktop/app/src/lib/state-events.ts:62-72` (`readAgain`), `:107-149` (`subscribe`)
- Modify: `apps/desktop/app/src/lib/chat-messages.ts:68`, `:88`
- Modify: `apps/desktop/app/src/lib/sidebar-scopes.ts:121`
- Create: `apps/desktop/app/src/lib/state-events-computers.test.ts`
- Modify: `apps/desktop/app/src/lib/draft-store.test.ts`

**Interfaces:**
- Consumes: `bridgeForKey` (Task 13); `window.milagre.onComputerEvent` (Task 4).
- Produces: no new names. `stateEvents` listeners now also hear paired computers' scopes, with qualified keys.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/app/src/lib/state-events-computers.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { diffState } from "@milagre/shared/state-patch";

// This Mac and one paired computer, each with a Project at the same path, each answering state:read for its own.
const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const PATH = "/code/app";
type Listener = (update: any) => void;
const listeners: { project: Listener[]; computer: Listener[] } = { project: [], computer: [] };
const hosts: Record<string, { epoch: string; version: number; state: any; reads: string[] }> = {
  local: { epoch: "mac", version: 0, state: {}, reads: [] },
  [ID]: { epoch: "studio", version: 0, state: {}, reads: [] },
};
const reader = (who: string) => ({
  async readState(scope: string) {
    hosts[who].reads.push(scope);
    return { state: hosts[who].state, version: hosts[who].version, epoch: hosts[who].epoch };
  },
});
(globalThis as any).window = {
  milagre: {
    ...reader("local"),
    onProjectState: (listener: Listener) => (listeners.project.push(listener), () => {}),
    onLinkState: () => () => {},
    onAgentEvent: () => () => {},
    onComputerEvent: (listener: Listener) => (listeners.computer.push(listener), () => {}),
    on: (id: string) => reader(id),
  },
};
const { stateEvents } = await import("./state-events.ts");
const seen: string[] = [];
stateEvents.onProjectState(({ path, state }) => seen.push(`${path} ${(state as any).title}`));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The Mac's next state, sent as a patch the way its daemon sends it (a computer's arrives named, through main). */
function change(who: string, next: any) {
  const host = hosts[who];
  const base = host.version;
  const patch = diffState(host.state, next);
  host.state = next;
  host.version++;
  const numbering = { patch, base, version: host.version, epoch: host.epoch };
  if (who === "local") for (const listener of listeners.project) listener({ path: PATH, ...numbering });
  else for (const listener of listeners.computer) listener({ computerId: who, channel: "project:state", payload: { path: `${who}|${PATH}`, ...numbering } });
}

test("the same path on this Mac and on a computer keeps two states, each read from and patched by its own Mac", async () => {
  hosts.local.state = { title: "mine" };
  hosts.local.version = 3;
  hosts[ID].state = { title: "theirs" };
  hosts[ID].version = 8;
  change("local", { title: "mine 2" });
  change(ID, { title: "theirs 2" });
  await tick();
  await tick();
  assert.deepEqual(hosts.local.reads, [PATH]);
  assert.deepEqual(hosts[ID].reads, [`${ID}|${PATH}`], "the computer's state is read from the computer");
  assert.deepEqual(new Set(seen), new Set([`${PATH} mine 2`, `${ID}|${PATH} theirs 2`]));
  change(ID, { title: "theirs 3" });
  change("local", { title: "mine 3" });
  await tick();
  assert.deepEqual(seen.slice(2), [`${ID}|${PATH} theirs 3`, `${PATH} mine 3`]);
  assert.equal(hosts[ID].reads.length, 1, "a patch applies to the computer's own state without reading it again");
  assert.equal(hosts.local.reads.length, 1);
});
```

Append to `apps/desktop/app/src/lib/draft-store.test.ts`:

```ts
test("the same path on this Mac and on a paired computer keeps two drafts", () => {
  const remote = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7|/p";
  const store = createDraftStore(draftKey("/p", 1));
  store.set("here");
  store.select(draftKey(remote, 1));
  assert.equal(store.get(), "");
  store.set("there");
  store.select(draftKey("/p", 1));
  assert.equal(store.get(), "here");
  store.select(draftKey(remote, 1));
  assert.equal(store.get(), "there");
});
```

- [ ] **Step 2: Run them to verify the state test fails**

Run: `node --test apps/desktop/app/src/lib/state-events-computers.test.ts apps/desktop/app/src/lib/draft-store.test.ts`
Expected: the state test FAILS (the computer's events are never heard: `seen` holds only this Mac's state). The draft test PASSES and pins the keys.

- [ ] **Step 3: Every computer's events, each scope read from its Mac**

In `apps/desktop/app/src/lib/state-events.ts`, add `import { bridgeForKey } from "./computer-bridge.ts";`. In `readAgain`, replace `window.milagre.readState(scope),` with `bridgeForKey(scope).readState(scope),`. Replace `subscribe` with:

```ts
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  const project = (update: { path: string; state?: CoordinatorState } & Numbered) => {
    if (!numbered(update)) {
      held.delete(update.path);
      if (update.state) for (const listener of projectListeners) listener({ path: update.path, state: update.state });
      return;
    }
    const state = stateFor(update.path, update);
    if (state) for (const listener of projectListeners) listener({ path: update.path, state: state as CoordinatorState });
  };
  const link = (update: { linkId: string; state?: LinkState } & Numbered) => {
    const scope = scopeKey({ kind: "link", linkId: update.linkId });
    if (!numbered(update)) {
      held.delete(scope);
      if (update.state) for (const listener of linkListeners) listener({ linkId: update.linkId, state: update.state });
      return;
    }
    const state = stateFor(scope, update);
    if (state) for (const listener of linkListeners) listener({ linkId: update.linkId, state: state as LinkState });
  };
  const agent = (update: AgentEventUpdate & Numbered) => {
    const { patch: _patch, base: _base, version: _version, epoch: _epoch, resync: _resync, state: whole, ...event } = update;
    const scope = projectOfKey(update.chatId);
    // While its scope is read again, a chat's events wait their turn behind the ones held back.
    const pending = scope ? reading.get(scope) : undefined;
    if (pending) {
      if (numbered(update)) pending.patches.push(update);
      pending.events.push({ event, withState: numbered(update) });
      return;
    }
    let state = whole;
    if (numbered(update) && scope) {
      state = stateFor(scope, update) ?? undefined;
      if (!state) {
        reading.get(scope)?.events.push({ event, withState: true });
        return;
      }
    } else if (scope && state) held.delete(scope);
    for (const listener of agentListeners) listener({ ...event, ...(state ? { state } : {}) });
  };
  window.milagre.onProjectState?.(project);
  window.milagre.onLinkState?.(link);
  window.milagre.onAgentEvent?.(agent);
  // A paired computer's events arrive with keys that name it (computer-routing.cjs), so its scopes keep apart from this Mac's.
  window.milagre.onComputerEvent?.((event) => {
    if (event.channel === "project:state") project(event.payload);
    else if (event.channel === "link:state") link(event.payload);
    else if (event.channel === "agent:event") agent(event.payload);
  });
}
```

The three handlers are the old inline ones, moved into named functions.

- [ ] **Step 4: Chat windows and sidebar reads go to their Mac**

In `apps/desktop/app/src/lib/chat-messages.ts`, add `import { bridgeForKey } from "./computer-bridge.ts";`. In `load`, replace `loading = window.milagre` with `loading = bridgeForKey(scope)`. In `loadEarlier`, replace `await window.milagre.readChatMessages(` with `await bridgeForKey(scope).readChatMessages(`.

In `apps/desktop/app/src/lib/sidebar-scopes.ts`, add `import { bridgeForKey } from "./computer-bridge.ts";` and replace line 121 with:

```ts
      const bridge = bridgeForKey(key);
      const read = isLinkScopeKey(key) ? bridge.readLink(key.slice("milagre-link:".length)) : bridge.readProject(key);
```

- [ ] **Step 5: Run the renderer's tests**

Run: `npm test -- --unit --workspace desktop`
Expected: PASS, the old `state-events.test.ts` included.

- [ ] **Step 6: The checks that read states and chat windows**

Run: `npm test -- --only test-sidebar-all-projects && npm test -- --only test-chat-layout && npm test -- --only test-find-in-chat && npm test -- --only test-chat-pins`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/app/src/lib/state-events.ts apps/desktop/app/src/lib/state-events-computers.test.ts apps/desktop/app/src/lib/chat-messages.ts apps/desktop/app/src/lib/sidebar-scopes.ts apps/desktop/app/src/lib/draft-store.test.ts
git add apps/desktop/app/src/lib/state-events.ts apps/desktop/app/src/lib/state-events-computers.test.ts apps/desktop/app/src/lib/chat-messages.ts apps/desktop/app/src/lib/sidebar-scopes.ts apps/desktop/app/src/lib/draft-store.test.ts
git commit -m "feat(desktop): states, chat windows and drafts kept per computer"
```

---

### Task 15: Every computer's turns and ports

The streaming turns (`useAgentRuns`) and listening ports (`useAgentPorts`) hold every computer's chats. A snapshot from one computer replaces only that computer's entries. A computer that comes online is asked for its turns, since its runtime's first connection sends no snapshot (`daemon-runtime.cjs:56-67`). A removed computer, or every computer once the switch is off, takes its entries with it. Send, Stop, approvals and answers go to the chat's own Mac.

**Files:**
- Modify: `apps/desktop/app/src/lib/agent-runs.ts` (two helpers), `apps/desktop/app/src/lib/agent-runs.test.ts`
- Modify: `apps/desktop/app/src/components/useAgentRuns.ts`
- Modify: `apps/desktop/app/src/lib/ports.ts`

**Interfaces:**
- Consumes: `computerOfKey`, `LOCAL_COMPUTER` (Task 11); `bridgeFor`, `bridgeForKey` (Task 13); `useComputers` (Task 6).
- Produces:
  - `replaceComputerEntries<T>(record: Record<string, T>, computerId: string, next: Record<string, T>): Record<string, T>`
  - `dropComputerRuns(runs: AgentRuns, computerId: string): AgentRuns`

- [ ] **Step 1: Write the failing test**

In `apps/desktop/app/src/lib/agent-runs.test.ts`, add `replaceComputerEntries` and `dropComputerRuns` to its import from `./agent-runs.ts`, and append:

```ts
test("a computer's snapshot replaces only its own turns, and a removed computer takes only its own", () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const run = (text: string) => ({ text, model: "", startedAt: 0, steps: [], approvals: [], questions: [], answered: {} });
  const runs = { "/p#1": run("mine"), [`${ID}|/p#1`]: run("studio old"), [`${OTHER}|/p#1`]: run("atlas") };
  const next = replaceComputerEntries(runs, ID, { [`${ID}|/p#2`]: run("studio new"), "/p#9": run("not studio's") });
  assert.deepEqual(Object.keys(next).sort(), ["/p#1", `${ID}|/p#2`, `${OTHER}|/p#1`].sort());
  assert.equal(next["/p#1"].text, "mine", "this Mac's chat at the same path is untouched");
  const local = replaceComputerEntries(next, "local", { "/p#3": run("mine new") });
  assert.deepEqual(Object.keys(local).sort(), ["/p#3", `${ID}|/p#2`, `${OTHER}|/p#1`].sort());
  assert.deepEqual(Object.keys(dropComputerRuns(local, ID)).sort(), ["/p#3", `${OTHER}|/p#1`].sort());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/desktop/app/src/lib/agent-runs.test.ts`
Expected: FAIL (`replaceComputerEntries is not a function`).

- [ ] **Step 3: The helpers**

Append to `apps/desktop/app/src/lib/agent-runs.ts` (and add `import { computerOfKey } from "@milagre/shared/chat-scopes";` at the top):

```ts
/** `record` (keyed by chat key) with one computer's entries replaced by `next`, a snapshot from it; the others stay. */
export function replaceComputerEntries<T>(record: Record<string, T>, computerId: string, next: Record<string, T>): Record<string, T> {
  const kept = Object.entries(record).filter(([key]) => computerOfKey(key) !== computerId);
  const taken = Object.entries(next ?? {}).filter(([key]) => computerOfKey(key) === computerId);
  return Object.fromEntries([...kept, ...taken]);
}
/** `runs` without a computer's turns: it was removed, or Other computers was turned off. */
export const dropComputerRuns = (runs: AgentRuns, computerId: string) => replaceComputerEntries(runs, computerId, {});
```

- [ ] **Step 4: `useAgentRuns` holds every computer's turns**

Replace the body of `apps/desktop/app/src/components/useAgentRuns.ts` from its imports through the `useEffect` that subscribes, and the four callbacks, so the file reads:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { ChatSendRequest, CoordinatorState, LinkState, PermissionDecision, QuestionAnswers } from "../model";
import { applyRunEvent, clearAnswered, dropComputerRuns, markAnswered, projectOfKey, replaceComputerEntries } from "../lib/agent-runs";
import { answerSummary } from "../lib/question-answers";
import { stateEvents } from "../lib/state-events";
import { bridgeFor, bridgeForKey } from "../lib/computer-bridge";
import { useComputers } from "../lib/computers";
import type { AgentRuns, SentAnswer } from "../lib/agent-runs";

/**
 * Streams agent turns per chat, in every project of every computer, so a chat in a project that isn't open keeps
 * its run and its cards for when the project opens again, and a reload picks them up. Each computer's main process
 * saves its turns; an event that changed a project's state brings that state along, handed to `onState`.
 * `modelFor(chatId)` names the model of a turn that starts without a message from this window.
 */
export function useAgentRuns(onState: (projectPath: string, state: CoordinatorState | LinkState) => void, modelFor: (chatId: string) => string = () => "") {
  const [runs, setRuns] = useState<AgentRuns>({});
  const runsRef = useRef(runs);
  const onStateRef = useRef(onState);
  const modelForRef = useRef(modelFor);
  onStateRef.current = onState;
  modelForRef.current = modelFor;

  const setAll = useCallback((next: AgentRuns) => {
    runsRef.current = next;
    setRuns(next);
  }, []);
  // Per computer, the number of the last agent event its snapshot holds: events it already folded in are skipped.
  const taken = useRef(new Map<string, number>());
  const take = useCallback(
    (computerId: string, snapshot: { runs: AgentRuns; seq: number }) => {
      taken.current.set(computerId, snapshot.seq);
      setAll(replaceComputerEntries(runsRef.current, computerId, snapshot.runs));
    },
    [setAll],
  );

  // The run and the state change in one render, so a finished reply never shows twice or goes missing.
  // A window that loads mid-turn takes the turns from the main process, and skips the events they hold.
  useEffect(() => {
    let recovered = false;
    const unsubscribe = stateEvents.onAgentEvent(({ chatId, event, state, seq }) => {
      if (seq === undefined || seq > (taken.current.get(computerOfKey(chatId)) ?? 0))
        setAll(applyRunEvent(runsRef.current, chatId, event, event.type === "turn-started" ? modelForRef.current(chatId) : ""));
      if (state) onStateRef.current(projectOfKey(chatId), state);
    });
    const recover = window.milagre.onRuntimeSnapshot?.((snapshot) => {
      recovered = true;
      take(LOCAL_COMPUTER, snapshot.runs);
    });
    // A computer's runtime sends a snapshot each time it reconnects (daemon-runtime.cjs).
    const recoverRemote = window.milagre.onComputerEvent?.((event) => {
      if (event.channel === "runtime:snapshot" && event.payload?.runs) take(event.computerId, event.payload.runs);
    });
    void window.milagre
      .getRuns()
      .then((snapshot) => {
        if (!recovered) take(LOCAL_COMPUTER, snapshot);
      })
      .catch(() => {});
    return () => {
      recovered = true;
      unsubscribe();
      recover?.();
      recoverRemote?.();
    };
  }, [setAll, take]);

  // A computer that comes online is asked for its turns: its runtime's first connection sends no snapshot. One that
  // is removed, or every one once Other computers is off, takes its turns with it.
  const { computers } = useComputers();
  const online = computers
    .filter((computer) => computer.state === "online")
    .map((computer) => computer.id)
    .join("\n");
  const known = computers.map((computer) => computer.id).join("\n");
  useEffect(() => {
    for (const id of online.split("\n").filter(Boolean))
      void bridgeFor(id)
        .getRuns()
        .then((snapshot) => take(id, snapshot))
        .catch(() => {});
  }, [online, take]);
  useEffect(() => {
    const ids = new Set(known.split("\n").filter(Boolean));
    let next = runsRef.current;
    for (const key of Object.keys(next)) {
      const id = computerOfKey(key);
      if (id !== LOCAL_COMPUTER && !ids.has(id)) next = dropComputerRuns(next, id);
    }
    if (next !== runsRef.current) setAll(next);
  }, [known, setAll]);

  /** Saves the message and starts or steers its chat's turn, on the chat's own Mac; resolves with the chat's session id. */
  const send = useCallback((request: ChatSendRequest) => bridgeForKey(request.projectPath).sendMessage(request), []);

  const interrupt = useCallback((chatId: string) => bridgeForKey(chatId).interruptAgent(chatId), []);
```

and in `respond` and `answerQuestion`, replace `window.milagre.respondToPermission(` with `bridgeForKey(chatId).respondToPermission(` and `window.milagre.answerQuestion(` with `bridgeForKey(chatId).answerQuestion(`. The `answer` callback and the `return` stay as they are.

- [ ] **Step 5: Ports from every computer**

Replace `useAgentPorts` in `apps/desktop/app/src/lib/ports.ts` with:

```ts
/** Every chat's listening ports, by chat key, on this Mac and on each paired computer. */
export function useAgentPorts() {
  const [ports, setPorts] = useState<AgentPorts>({});
  useEffect(() => {
    // An update that arrives first is newer than the snapshot.
    let live = true;
    let updated = false;
    const mine = (next: AgentPorts) => setPorts((current) => replaceComputerEntries(current, LOCAL_COMPUTER, next));
    const unsubscribe = window.milagre.onAgentPorts((next) => {
      updated = true;
      mine(next);
    });
    const recover = window.milagre.onRuntimeSnapshot?.((snapshot) => {
      updated = true;
      mine(snapshot.ports);
    });
    // A computer's ports arrive keyed by its chat keys (computer-routing.cjs); each replaces only that computer's.
    const remote = window.milagre.onComputerEvent?.((event) => {
      const next = event.channel === "agent:ports" ? event.payload : event.channel === "runtime:snapshot" ? event.payload?.ports : null;
      if (next) setPorts((current) => replaceComputerEntries(current, event.computerId, next));
    });
    void window.milagre
      .getAgentPorts()
      .then((next) => {
        // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
        if (live && !updated) mine(next);
      })
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
      recover?.();
      remote?.();
    };
  }, []);
  return ports;
}
```

and add the imports `import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";` and `import { replaceComputerEntries } from "./agent-runs";`.

- [ ] **Step 6: Run the tests and the checks that stream turns**

Run: `npm test -- --unit --workspace desktop && npm run typecheck`
Expected: PASS.

Run: `npm test -- --only test-chat-send-feedback && npm test -- --only test-question-card && npm test -- --only test-ports && npm test -- --only test-subagents && npm test -- --only test-project-attention`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/app/src/lib/agent-runs.ts apps/desktop/app/src/lib/agent-runs.test.ts apps/desktop/app/src/components/useAgentRuns.ts apps/desktop/app/src/lib/ports.ts
git add apps/desktop/app/src/lib/agent-runs.ts apps/desktop/app/src/lib/agent-runs.test.ts apps/desktop/app/src/components/useAgentRuns.ts apps/desktop/app/src/lib/ports.ts
git commit -m "feat(desktop): every computer's turns and ports, and sends to the chat's own Mac"
```

---
### Task 16: The open Project's screens talk to its own Mac

`App.tsx` reads the open Project's computer from its key and routes every call about it there. Components under it that only know a folder (git, diffs, files, attachments, simulators, browsers) read the bridge App provides with `BridgeContext`. Libraries that know a chat or scope key route by it. A test lists, per file, the `window.milagre` calls each may still make: this Mac's own window, host, devices, accounts, canvas, editors and notifications, plus the raw listeners for every computer's events. Every other call then reaches the Mac of the Project or chat it is about, and a later change that forgets this fails the unit tests.

Removing the computer whose Project is open, or turning Other computers off while one is open, brings this Mac's Project back (Review Focus).

**Files:**
- Create: `apps/desktop/app/src/lib/routed-bridge.test.ts`
- Modify: `apps/desktop/app/src/App.tsx`
- Modify: `components/useWorktreePullRequests.ts`, `components/changes/useChanges.ts`, `components/changes/useDiffFiles.ts`, `components/changes/useLinkDiffLists.ts`, `components/GitActionsDialog.tsx`, `components/AttachmentPreview.tsx`, `components/useProjectFiles.ts`, `components/useSkills.ts`, `components/SkillsSettings.tsx`, `components/agents/step-details.tsx`, `components/agents/SimulatorTrack.tsx`, `components/agents/BrowserTrack.tsx`, `components/agents/ArtifactCard.tsx`, `components/agents/ArtifactCanvas.tsx`, `components/LinkProjectDialog.tsx`, `components/LinkWorkspace.tsx`, `components/SidebarNav.tsx`, `components/Settings.tsx`, `components/ProjectAccountsSettings.tsx`, `components/usage/useUsage.ts`, `lib/subagent-transcripts.ts`, `lib/terminal-actions.ts`, `lib/terminal-sessions.ts`, `lib/project-images.ts` (all under `apps/desktop/app/src/`)

**Interfaces:**
- Consumes: `bridgeFor`, `bridgeForKey`, `isRemoteKey`, `forgetBridge`, `BridgeContext`, `useBridge`, `onAnyAgentEvent` (Task 13); `computerOfKey`, `LOCAL_COMPUTER` (Task 11); `useComputers` (Task 6).
- Produces: `useDiffFiles({ cwd, base, mode, active, bridge })`, where `bridge: MilagreBridge` is now required. App renders `BridgeContext.Provider` around the project view, and `LinkWorkspace` around the Link view.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/app/src/lib/routed-bridge.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The window.milagre calls each file may make: this Mac's own (its window, host, devices, accounts, canvas, editors,
// notifications, image menus over local bytes) and the raw listeners that take every computer's events. Any other call
// goes through bridgeFor / bridgeForKey / useBridge, so it reaches the computer of the Project or chat it is about.
const ALLOWED: Record<string, string[]> = {
  "App.tsx": [
    "onAccountsChanged", "listRecentProjects", "onQuitFailed", "updateCli", "getCurrentProject", "onRuntimeConnection", "getRuntimeConnection",
    "onRuntimeSnapshot", "onComputerEvent", "onWorktreeRenamed", "revealInFolder", "setKeepAwake", "syncNotifications", "setNotifyWhenWaiting",
    "notifyCompletion", "onOpenChat", "onOpenPhoneSettings", "openProject", "openCanvasProject", "onAppShortcut", "restartHost", "retryQuit",
  ],
  "components/Settings.tsx": [
    "listRecentProjects", "onPhoneStatus", "getPhoneStatus", "listDevices", "removeDevice", "openPhonePairing", "setPhoneEnabled", "setPhoneLan",
    "resetPhoneAccess", "getAppVersion", "getReleaseChannel", "setReleaseChannel", "checkForUpdates", "readMainSyncDefault", "saveMainSyncDefault",
    "readLinearEnabled", "readLinearStatus", "onLinearStatusChanged", "saveLinearEnabled", "connectLinear", "disconnectLinear", "onMainSyncStatus", "computers",
  ],
  "components/SidebarNav.tsx": ["listRecentProjects", "listNamedLinks", "listProjects", "revealInFolder", "getCanvas", "addLink", "removeLink"],
  "components/LinkWorkspace.tsx": ["syncNotifications", "revealInFolder"],
  "components/ComputerAllowPrompt.tsx": ["onDevicesPending", "listPendingDevices", "allowDevice", "denyDevice"],
  "components/UpdateNotice.tsx": ["onUpdateState", "getUpdateState", "installUpdate", "checkForUpdates"],
  "components/AccountsSettings.tsx": ["listAccounts", "onAccountsChanged", "accountAction", "onCliProgress", "updateCli"],
  "components/ProjectAccountsSettings.tsx": ["listAccountScopes", "onAccountsChanged", "accountAction"],
  "components/CanvasView.tsx": ["getCanvas", "stopNegotiation", "addLink", "removeLink", "setProjectPosition", "setWorktreePosition"],
  "components/AddComputerDialog.tsx": ["onComputerAddPending", "computers"],
  "components/useAgentRuns.ts": ["onRuntimeSnapshot", "onComputerEvent", "getRuns"],
  "components/usePastedImages.ts": ["getPathForFile"],
  "components/usage/useUsage.ts": ["onAccountsChanged", "readUsage", "getCachedUsage"],
  "components/terminal/TerminalPanel.tsx": ["onCloseFocusedTerminal", "setTerminalFocused"],
  "components/SkillsSettings.tsx": ["openSkill", "revealSkill"],
  "components/Attachments.tsx": ["showImageMenu"],
  "components/agents/GeneratedImage.tsx": ["copyImage", "saveImage", "showImageMenu"],
  "components/motion/MediaLightbox.tsx": ["showImageMenu"],
  "lib/state-events.ts": ["onProjectState", "onLinkState", "onAgentEvent", "onComputerEvent"],
  "lib/computer-bridge.ts": ["on", "onAgentEvent", "onComputerEvent"],
  "lib/computers.ts": ["computers", "onComputersChanged"],
  "lib/ports.ts": ["onAgentPorts", "onRuntimeSnapshot", "getAgentPorts", "onComputerEvent"],
  "lib/settings.ts": ["setWindowTranslucent"],
  "lib/editors.ts": ["listEditors", "openInEditor"],
  "lib/linked-work.ts": ["getLinkedWork", "onLinkedWork"],
  "lib/terminal-sessions.ts": ["setTerminalFocused"],
  "lib/terminal-actions.ts": ["onTerminalsChanged", "onComputerEvent"],
};

function sources(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

test("every window.milagre call outside this Mac's own goes through its computer's bridge", () => {
  const wrong: string[] = [];
  for (const file of sources(SRC)) {
    const name = path.relative(SRC, file).split(path.sep).join("/");
    const code = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const [, method] of code.matchAll(/window\.milagre\??\s*\.\s*(\w+)/g))
      if (!(ALLOWED[name] ?? []).includes(method)) wrong.push(`${name}: window.milagre.${method}`);
  }
  assert.deepEqual([...new Set(wrong)], []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/desktop/app/src/lib/routed-bridge.test.ts`
Expected: FAIL, listing every call this task routes (for example `App.tsx: window.milagre.getCliStatus`, `components/GitActionsDialog.tsx: window.milagre.git`).

- [ ] **Step 3: `App.tsx`**

Add the imports:

```tsx
import { BridgeContext, bridgeFor, bridgeForKey, forgetBridge, isRemoteKey, onAnyAgentEvent } from "./lib/computer-bridge";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { useComputers } from "./lib/computers";
import type { WorktreeRename } from "@milagre/shared/project-edits";
```

Make these replacements (each old text is unique in the file):

| Old | New |
| --- | --- |
| `void window.milagre`<br>`      .getCliStatus(accountScope)` | `void bridgeForKey(accountScope)`<br>`      .getCliStatus(accountScope)` |
| `void window.milagre`<br>`      .getModels(accountScope)` | `void bridgeForKey(accountScope)`<br>`      .getModels(accountScope)` |
| `if (project) void window.milagre.listBranches(project.path).then(setBranches);` | `if (project) void bridgeForKey(project.path).listBranches(project.path).then(setBranches, () => {});` |
| `void window.milagre.setAgentPermissionMode(chatKey(project.path, selectedSession.id), mode)` | `void bridgeForKey(project.path).setAgentPermissionMode(chatKey(project.path, selectedSession.id), mode)` |
| `reportChatAction(window.milagre.patchChat(current.path, sessionId, patch),` | `reportChatAction(bridgeForKey(current.path).patchChat(current.path, sessionId, patch),` |
| `(action === "stop" ? window.milagre.stopAdvisor : window.milagre.retryAdvisor)(` | `(action === "stop" ? bridgeForKey(current.path).stopAdvisor : bridgeForKey(current.path).retryAdvisor)(` |
| `reportChatAction(window.milagre.archiveSubagent(current.path,` | `reportChatAction(bridgeForKey(current.path).archiveSubagent(current.path,` |
| `reportChatAction(window.milagre.archiveFinishedSubagents(current.path,` | `reportChatAction(bridgeForKey(current.path).archiveFinishedSubagents(current.path,` |
| `await window.milagre.patchChat(projectPath, sessionId, { archived: true, unread: false });` | `await bridgeForKey(projectPath).patchChat(projectPath, sessionId, { archived: true, unread: false });` |
| `remove: (worktree, options) => window.milagre.removeWorktree(worktree.path, options),` | `remove: (worktree, options) => bridgeForKey(options.projectPath).removeWorktree(worktree.path, options),` |
| `void window.milagre`<br>`            .listBranches(projectPath)` | `void bridgeForKey(projectPath)`<br>`            .listBranches(projectPath)` |
| `await window.milagre.getWorktreeRoots()` | `await bridgeForKey(project?.path).getWorktreeRoots()` |
| `await window.milagre.getWorktreeStatus(worktree.path, worktree.base!)` | `await bridgeForKey(project?.path).getWorktreeStatus(worktree.path, worktree.base!)` |
| `await window.milagre.readChatMessages(project.path, sessionId, { turns: 30 })` | `await bridgeForKey(project.path).readChatMessages(project.path, sessionId, { turns: 30 })` |
| `void window.milagre.addGitNote(chatKey(current.path, sessionId), body)` | `void bridgeForKey(current.path).addGitNote(chatKey(current.path, sessionId), body)` |
| `window.milagre.onAgentEvent(({ chatId, event }) => {` | `onAnyAgentEvent(({ chatId, event }) => {` |
| `replaceProject(() => window.milagre.switchProject(projectPath), projectPath)` | `replaceProject(() => bridgeForKey(projectPath).switchProject(projectPath), projectPath)` |
| `const next = await window.milagre.openNamedLink(id);` | ``const next = await bridgeForKey(`milagre-link:${id}`).openNamedLink(id);`` |
| `const next = await window.milagre.openNamedLink(link.id);` | ``const next = await bridgeForKey(`milagre-link:${link.id}`).openNamedLink(link.id);`` |
| `const next = await window.milagre.openCanvasProject(projectPath);` | `const next = await (isRemoteKey(projectPath) ? bridgeForKey(projectPath).switchProject(projectPath) : window.milagre.openCanvasProject(projectPath));` |
| `const created = await window.milagre.createWorktree({` | `const created = await bridgeForKey(project.path).createWorktree({` |
| `void window.milagre`<br>`      .listBranches(project.path)` | `void bridgeForKey(project.path)`<br>`      .listBranches(project.path)` |
| `(await window.milagre.listNamedLinks()).find((item) => item.id === id)` | ``(await bridgeForKey(`milagre-link:${id}`).listNamedLinks()).find((item) => item.id === id)`` |
| `(pid) => window.milagre.stopAgentPort(chatKey(project.path, selectedSession.id), pid)` | `(pid) => bridgeForKey(project.path).stopAgentPort(chatKey(project.path, selectedSession.id), pid)` |
| `void window.milagre`<br>`                              .resumeChat(project.path, selectedSession.id)` | `void bridgeForKey(project.path)`<br>`                              .resumeChat(project.path, selectedSession.id)` |
| `await window.milagre.searchChats(project.path, query)` | `await bridgeForKey(project.path).searchChats(project.path, query)` |
| `void window.milagre.refreshDiffs(project.path, [gitDialog.worktreeId])` | `void bridgeForKey(project.path).refreshDiffs(project.path, [gitDialog.worktreeId])` |

In `revealChat`, replace `if (!project) return;` with `if (!project || isRemoteKey(project.path)) return;`.

Replace the "chat on screen" effect (`// The main process reads the chat on screen …` through its `}, [selectedSessionId, view, project?.path, selectedLink?.link.id]);`) with:

```tsx
  // The main process reads the chat on screen (on opening it, and when the window regains focus over it),
  // and leaves a chat unread when its turn ends anywhere else, or while no window has focus. The Mac that had the
  // chat on screen before hears there is none when the next one is on another Mac.
  const openChatComputer = useRef<string>(LOCAL_COMPUTER);
  useEffect(() => {
    if (selectedLink) return;
    const key = view === "chat" && project && selectedSessionId !== null ? chatKey(project.path, selectedSessionId) : null;
    const computerId = project ? computerOfKey(project.path) : LOCAL_COMPUTER;
    if (openChatComputer.current !== computerId) void bridgeFor(openChatComputer.current).setOpenChat(null).catch(() => {});
    openChatComputer.current = computerId;
    void bridgeFor(computerId).setOpenChat(key).catch(() => {});
  }, [selectedSessionId, view, project?.path, selectedLink?.link.id]);
```

Replace the worktree-renamed effect with:

```tsx
  // A new worktree's branch is renamed a few seconds in, once its chat's name is picked; its Mac saves the new name.
  useEffect(() => {
    const renamed = (rename: WorktreeRename) => {
      if (projectRef.current?.path === rename.projectPath) void bridgeForKey(rename.projectPath).listBranches(rename.projectPath).then(setBranches, () => {});
    };
    const offLocal = window.milagre.onWorktreeRenamed(renamed);
    const offRemote = window.milagre.onComputerEvent?.((event) => {
      if (event.channel === "worktree:renamed") renamed(event.payload);
    });
    return () => {
      offLocal();
      offRemote?.();
    };
  }, []);
```

In the effect that subscribes to `onRuntimeSnapshot`, after `const snapshotOff = …;`, add:

```tsx
    // A computer's runtime sends a snapshot after each reconnect, with its open Projects' and Links' states (keys name it).
    const remoteSnapshotOff = window.milagre.onComputerEvent?.((event) => {
      if (event.channel !== "runtime:snapshot" || !event.payload) return;
      for (const next of event.payload.projects ?? []) receiveState(next.path, next.state);
      for (const next of event.payload.links ?? []) setLinkStates((previous) => ({ ...previous, [next.linkId]: next.state }));
    });
```

and add `remoteSnapshotOff?.();` to its cleanup.

After `useApplyOtherComputers();`, add:

```tsx
  // The computer whose Project or Link is open was removed, or Other computers turned off: this Mac's Project comes back.
  const { computers: pairedComputers } = useComputers();
  const knownComputers = pairedComputers.map((computer) => computer.id).join("\n");
  useEffect(() => {
    const open = selectedLinkRef.current ? `milagre-link:${selectedLinkRef.current.link.id}` : projectRef.current?.path;
    if (!open || !isRemoteKey(open)) return;
    const computerId = computerOfKey(open);
    if (knownComputers.split("\n").includes(computerId)) return;
    forgetBridge(computerId);
    void loadInitialProject();
  }, [knownComputers]);
```

Finally, find the `return (` of the project view (the one whose JSX holds `<SidebarNav` with `projectPath={project.path}`), and wrap everything it returns in `<BridgeContext.Provider value={bridgeForKey(project.path)}>` … `</BridgeContext.Provider>`.

- [ ] **Step 4: The components and libraries**

In each file, import what it uses from `../lib/computer-bridge` (or `./computer-bridge` from `lib/`, `../../lib/computer-bridge` two folders down), then:

| File | Change |
| --- | --- |
| `components/useWorktreePullRequests.ts` | `window.milagre.readPullRequest(path)` → `bridgeForKey(projectPath).readPullRequest(path)`; `window.milagre.onAgentEvent(` → `onAnyAgentEvent(`; `window.milagre.readPullRequests(path, selected)` → `bridgeForKey(projectPath).readPullRequests(path, selected)` |
| `components/changes/useChanges.ts` | `window.milagre.onAgentEvent(` → `onAnyAgentEvent(`; `useDiffFiles({ cwd: cwd ?? "", base, mode, active: shown })` → `useDiffFiles({ cwd: cwd ?? "", base, mode, active: shown, bridge: bridgeForKey(chatId) })` |
| `components/changes/useDiffFiles.ts` | Add `bridge` to the parameters: `({ cwd, base, mode, active, bridge }: { cwd: string; base?: string; mode: DiffMode; active: boolean; bridge: MilagreBridge })` (import `type MilagreBridge` from `../../electron`); `window.milagre.git` → `bridge.git` (both); add `bridge` to the dependency arrays that list `cwd` |
| `components/changes/useLinkDiffLists.ts` | `window.milagre.git.diffFiles(` → `bridgeForKey(chatId).git.diffFiles(`; `window.milagre.onAgentEvent(` → `onAnyAgentEvent(` |
| `components/GitActionsDialog.tsx` | First line of the component: `const bridge = useBridge();`; each `window.milagre.git.` → `bridge.git.` |
| `components/AttachmentPreview.tsx` | First line of the component: `const bridge = useBridge();`; `window.milagre.readAttachment(path)` → `bridge.readAttachment(path)`; add `bridge` to that effect's dependencies |
| `components/useProjectFiles.ts` | First line of the hook: `const bridge = useBridge();`; `window.milagre`<br>`.searchProjectFiles(root, query)` → `bridge`<br>`.searchProjectFiles(root, query)`; add `bridge` to the effect's dependencies |
| `components/useSkills.ts` | First line inside the effect: `const bridge = bridgeForKey(projectPath);`; `typeof window.milagre.listSkills` → `typeof bridge.listSkills`; `window.milagre`<br>`.listSkills(projectPath)` → `bridge`<br>`.listSkills(projectPath)` |
| `components/SkillsSettings.tsx` | `window.milagre.readSkill(projectPath, skill.path)` → `bridgeForKey(projectPath).readSkill(projectPath, skill.path)` |
| `components/agents/step-details.tsx` | `message = window.milagre.getMessage(scope, id);` → `message = bridgeForKey(scope).getMessage(scope, id);` |
| `components/agents/SimulatorTrack.tsx` | `const [api] = useState(() => window.milagre?.simulators);` → `const bridge = useBridge();` + `const [api] = useState(() => bridge?.simulators);` |
| `components/agents/BrowserTrack.tsx` | `const [api] = useState(() => window.milagre?.browsers);` → `const bridge = useBridge();` + `const [api] = useState(() => bridge?.browsers);` |
| `components/agents/ArtifactCard.tsx` | `const comments = window.milagre?.artifacts?.comments;` → `const comments = chatId ? bridgeForKey(chatId).artifacts?.comments : undefined;`; `window.milagre.artifacts.addComments?.(` → `bridgeForKey(chatId).artifacts.addComments?.(` |
| `components/agents/ArtifactCanvas.tsx` | both `window.milagre.artifacts.get(` → `bridgeForKey(chatId).artifacts.get(` |
| `components/LinkProjectDialog.tsx` | First line of the component: ``const bridge = bridgeForKey(link ? `milagre-link:${link.id}` : null);``; `window.milagre`<br>`.listProjects()` → `bridge`<br>`.listProjects()`; `window.milagre.updateNamedLink(` → `bridge.updateNamedLink(`; `window.milagre.createNamedLink(` → `bridge.createNamedLink(` |
| `components/LinkWorkspace.tsx` | After `owner` is computed: `const bridge = bridgeForKey(owner);`. `window.milagre.` → `bridge.` for `setOpenChat`, `sendLinkMessage`, `patchChat` (three), `resumeChat`, `stopAdvisor`, `retryAdvisor`, `archiveSubagent`, `archiveFinishedSubagents`, `setAgentPermissionMode`, `searchChats`, `addGitNote`. Keep `syncNotifications` and `revealInFolder` (Task 18 hides the latter). Wrap the component's returned JSX in `<BridgeContext.Provider value={bridge}>` … `</BridgeContext.Provider>` |
| `components/SidebarNav.tsx` | `void window.milagre`<br>`.patchChat(key, Number(id),` → `void bridgeForKey(key)`<br>`.patchChat(key, Number(id),`; `window.milagre?.forgetProject?.(path)` → `bridgeForKey(path).forgetProject(path)`; `window.milagre?.setProjectHidden?.(path, !show)` → `bridgeForKey(path).setProjectHidden(path, !show)` |
| `components/Settings.tsx` | `window.milagre.saveFilesToCopy(projectPath,` / `previewFilesToCopy(projectPath,` / `readFilesToCopy(projectPath)` / `saveWorktreeSetup(projectPath,` / `readWorktreeSetup(projectPath)` (two) / `readMainSync(projectPath)` / `saveMainSync(projectPath,` → `bridgeForKey(projectPath).…`; `window.milagre.setProjectIcon(project.path,` → `bridgeForKey(project.path).setProjectIcon(project.path,`; in `ProjectSettings`, `window.milagre.listRecentProjects()` → `bridgeForKey(project.path).listRecentProjects()` and `window.milagre.setProjectHidden(project.path,` → `bridgeForKey(project.path).setProjectHidden(project.path,` |
| `components/ProjectAccountsSettings.tsx` | `window.milagre.getProjectAccounts(scope, refresh)` → `bridgeForKey(scope).getProjectAccounts(scope, refresh)`; `window.milagre.assignProjectAccount(scope,` → `bridgeForKey(scope).assignProjectAccount(scope,` |
| `components/usage/useUsage.ts` | Accounts and their usage stay on their own computer (ADR-0005): at the top of the hook, `const localScope = isRemoteKey(scopeKey) ? undefined : scopeKey;`; pass `localScope` instead of `scopeKey` to `readUsage(` and `getCachedUsage(` (the comparisons with `scopeKey` stay) |
| `lib/subagent-transcripts.ts` | `loading = window.milagre` → `loading = bridgeForKey(chatKey)` |
| `lib/terminal-actions.ts` | In `refreshTerminals`, `openTerminal` and `busyTerminals`: `window.milagre.terminals.` → `bridgeForKey(chatId).terminals.`; in `closeTerminal`: `window.milagre.terminals.close(` → `bridgeForKey(terminal.chatId).terminals.close(` |
| `lib/terminal-sessions.ts` | `api: window.milagre.terminals,` → `api: bridgeForKey(info.chatId).terminals,` |
| `lib/project-images.ts` | `window.milagre?.getProjectImage(path).then(` → `(window.milagre ? bridgeForKey(path).getProjectImage(path) : Promise.resolve(null)).then(` |

In `lib/terminal-actions.ts`, replace `useTerminalSync`'s effect body with:

```ts
    if (!chatId) return;
    void refreshTerminals(chatId).catch(() => {});
    const changed = (payload: { chatId: string }) => {
      if (payload?.chatId === chatId) void refreshTerminals(chatId).catch(() => {});
    };
    const offLocal = window.milagre.onTerminalsChanged(changed);
    const offRemote = window.milagre.onComputerEvent?.((event) => {
      if (event.channel === "terminal:changed") changed(event.payload);
    });
    return () => {
      offLocal();
      offRemote?.();
    };
```

- [ ] **Step 5: Run the routing test, the unit tests and the typecheck**

Run: `node --test apps/desktop/app/src/lib/routed-bridge.test.ts && npm test -- --unit --workspace desktop && npm run typecheck && npm run lint`
Expected: PASS. If the routing test names a call this task's table missed, route it the same way: by the key the code already has, or by `useBridge()` inside the provider.

- [ ] **Step 6: Every Electron check (this task touches most screens)**

Run: `npm test -- --electron`
Expected: PASS for every check. On a failure, run that one with `npm test -- --only <name>` and fix the routing, not the check: a check that fakes `window.milagre` keeps working because this Mac's keys route to it.

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/app/src
git add apps/desktop/app/src
git commit -m "feat(desktop): the open Project's calls go to its own computer"
```

---
### Task 17: The merged sidebar, each row naming its computer

With "Other computers" on and at least one computer added, the sidebar lists every Project and Link of every computer in one list, by name. On a tie This Mac's comes first, then the computers in the popover's order. Every chat row, pinned ones included, gets a second line that starts with a laptop icon and its computer's name, then the PR chips. An offline computer's Projects and rows are dimmed and its rows read "studio, offline". With only this Mac nothing changes.

**Files:**
- Create: `apps/desktop/app/src/lib/computer-scopes.ts`, `apps/desktop/app/src/lib/computer-scopes.test.ts`
- Modify: `apps/desktop/app/src/components/SidebarNav.tsx` (scopes, `showAll`, groups, `ScopeHeader`, `ChatList`)
- Modify: `apps/desktop/app/src/components/sidebar/ChatRow.tsx` (`RowComputer`, the second line)
- Modify: `scripts/test-sidebar-computers.cjs`

**Interfaces:**
- Consumes: `useComputers`, `isDimmed` (Task 6); `bridgeFor` (Task 13); `computerOfKey`, `LOCAL_COMPUTER` (Task 11); `RECENT_PROJECTS_CHANGED`, `RecentProject` (`lib/project-list.ts`).
- Produces:
  - `type ComputerScope = { key: string; name: string; initial: string; link: NamedProjectLink | null; computerId: string }`
  - `computerScopes(computerId, recent, links): ComputerScope[]`
  - `mergeScopes<T>(scopes: T[], computerOrder: string[]): T[]`
  - `useComputerScopes(computers: ComputerView[]): ComputerScope[]`
  - `type RowComputer = { name: string; offline: boolean }`, with `ChatRow`'s new `computer?: RowComputer` prop and `ChatList`'s `computer?: RowComputer`
  - Markers: `[data-chat-computer]` on the row's second line and `data-offline` on a dimmed `[data-sidebar-scope]`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/desktop/app/src/lib/computer-scopes.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

(globalThis as any).window = { milagre: {}, addEventListener() {}, removeEventListener() {} };
const { computerScopes, mergeScopes } = await import("./computer-scopes.ts");

const A = "c-atlas";
const S = "c-studio";
test("a computer's Projects (hidden left out) then its Links, keyed as the window keeps them", () => {
  const scopes = computerScopes(A, [{ path: `${A}|/a/web`, name: "atlas-web", openedAt: "" }, { path: `${A}|/a/old`, name: "old", openedAt: "", hidden: true }], [
    { id: `${A}|f1713d69-569d-405b-a0b2-19bfdf565a76`, name: "Checkout", projectIds: [], createdAt: "" } as any,
  ]);
  assert.deepEqual(
    scopes.map((scope) => [scope.key, scope.name, scope.computerId, Boolean(scope.link)]),
    [
      [`${A}|/a/web`, "atlas-web", A, false],
      [`milagre-link:${A}|f1713d69-569d-405b-a0b2-19bfdf565a76`, "Checkout", A, true],
    ],
  );
});

test("every computer's scopes in one list: Projects by name, then Links; on a tie, This Mac first, then the computers in order", () => {
  const scope = (key: string, name: string, computerId: string, link = false) => ({ key, name, computerId, link: link ? {} : null });
  const merged = mergeScopes(
    [
      scope("/work/milagre-ade", "milagre-ade", "local"),
      scope(`${S}|/s/homelab`, "homelab", S),
      scope(`${A}|/a/web`, "atlas-web", A),
      scope(`${S}|/s/app`, "app", S),
      scope("/work/app", "App", "local"),
      scope("milagre-link:x", "Checkout", "local", true),
      scope(`${A}|/a/app`, "app", A),
    ],
    [A, S],
  );
  assert.deepEqual(
    merged.map((item) => item.key),
    ["/work/app", `${A}|/a/app`, `${S}|/s/app`, `${A}|/a/web`, `${S}|/s/homelab`, "/work/milagre-ade", "milagre-link:x"],
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/desktop/app/src/lib/computer-scopes.test.ts`
Expected: FAIL (`Cannot find module './computer-scopes.ts'`).

- [ ] **Step 3: `computer-scopes.ts`**

Create `apps/desktop/app/src/lib/computer-scopes.ts`:

```ts
import { useEffect, useState } from "react";
import type { NamedProjectLink } from "@milagre/shared/model";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import type { ComputerView } from "../electron";
import { bridgeFor } from "./computer-bridge.ts";
import { RECENT_PROJECTS_CHANGED, type RecentProject } from "./project-list.ts";

/** One Project or Link of a computer, keyed as the window keeps it (`${id}|path`, `milagre-link:${id}|uuid`). */
export type ComputerScope = { key: string; name: string; initial: string; link: NamedProjectLink | null; computerId: string };

/** A computer's Projects (those not hidden) then its Links, from its own lists; main has already qualified their keys. */
export function computerScopes(computerId: string, recent: RecentProject[], links: NamedProjectLink[]): ComputerScope[] {
  return [
    ...recent
      .filter((project) => !project.hidden)
      .map((project) => ({ key: project.path, name: project.name, initial: project.name.slice(0, 1).toUpperCase(), link: null, computerId })),
    ...links.map((link) => ({ key: `milagre-link:${link.id}`, name: link.name, initial: "", link, computerId })),
  ];
}

/**
 * Every computer's scopes in one list (spec "sidebar-scopes.ts … merged by Project name order"): Projects by name, then
 * Links by name; on a tie This Mac's first, then the computers in the popover's order.
 */
export function mergeScopes<T extends { key: string; name: string; link: unknown; computerId: string }>(scopes: T[], computerOrder: string[]): T[] {
  const rank = (scope: T) => (scope.computerId === LOCAL_COMPUTER ? -1 : computerOrder.indexOf(scope.computerId));
  return [...scopes].sort(
    (a, b) =>
      Number(Boolean(a.link)) - Number(Boolean(b.link)) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      rank(a) - rank(b) ||
      a.key.localeCompare(b.key),
  );
}

/**
 * Each paired computer's Projects and Links, read from it (from its cache in main while it is away), again when its
 * state changes, and when a Project is hidden or shown. A failed read keeps the last list.
 */
export function useComputerScopes(computers: ComputerView[]): ComputerScope[] {
  const [byComputer, setByComputer] = useState<Record<string, ComputerScope[]>>({});
  const [changed, setChanged] = useState(0);
  const states = computers.map((computer) => `${computer.id}:${computer.state}`).join("\n");
  useEffect(() => {
    const bump = () => setChanged((count) => count + 1);
    window.addEventListener(RECENT_PROJECTS_CHANGED, bump);
    return () => window.removeEventListener(RECENT_PROJECTS_CHANGED, bump);
  }, []);
  useEffect(() => {
    let live = true;
    for (const computer of computers) {
      if (computer.state === "off") continue;
      const bridge = bridgeFor(computer.id);
      void Promise.all([bridge.listRecentProjects().catch(() => null), bridge.listNamedLinks().catch(() => null)]).then(([recent, links]) => {
        if (!live || !Array.isArray(recent)) return;
        setByComputer((previous) => ({ ...previous, [computer.id]: computerScopes(computer.id, recent, Array.isArray(links) ? links : []) }));
      });
    }
    return () => {
      live = false;
    };
  }, [states, changed]);
  const ids = new Set(computers.map((computer) => computer.id));
  return Object.entries(byComputer)
    .filter(([id]) => ids.has(id))
    .flatMap(([, scopes]) => scopes);
}
```

- [ ] **Step 4: Run the unit test**

Run: `node --test apps/desktop/app/src/lib/computer-scopes.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the check**

In `scripts/test-sidebar-computers.cjs`'s fixture, add before `window.milagre = new Proxy(`:

```js
const remoteState = (title, body) => ({ next_id: 9, projects: { 1: { id: 1, name: "p" } }, worktrees: { 1: { id: 1, name: "main", path: "/remote", project_id: 1 } }, sessions: { 4: { id: 4, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title } }, connections: {}, events: [], messages: [{ id: 4, session_id: 4, role: "user", body }], approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] });
const remoteProjects = {
  "c-atlas": { path: "c-atlas|/Users/a/atlas-web", name: "atlas-web", state: remoteState("Fix flaky deploy check", "The deploy check fails about one run in five.") },
  "c-studio": { path: "c-studio|/Users/s/homelab", name: "homelab", state: remoteState("Backup rotation", "Rotate the nightly backups.") },
};
window.sent = [];
// Each computer's bridge, as main would answer it: keys already name the computer.
const projectsOf = (id) => Object.values(remoteProjects).filter((project) => project.path.startsWith(id + "|"));
const projectAt = async (key) => Object.values(remoteProjects).find((project) => project.path === key);
const remote = (id) => new Proxy({
  listRecentProjects: async () => projectsOf(id).map(({ path, name }) => ({ path, name })),
  listNamedLinks: async () => [],
  readProject: projectAt,
  switchProject: projectAt,
  // As main's offline cache answers a chat it kept nothing of (Task 20).
  readChatMessages: async () => ({ messages: [], hasMore: false, total: 0 }),
  getRuns: async () => ({ runs: {}, seq: 0 }),
  listBranches: async () => ["main"],
  sendMessage: async (request) => (window.sent.push(request), { sessionId: 4 }),
}, { get(target, key) { return target[key] ?? (String(key).startsWith("on") ? () => () => {} : async () => null); } });
const remotes = { "c-atlas": remote("c-atlas"), "c-studio": remote("c-studio") };
```

and in the Proxy's target add `on: (id) => remotes[id],`.

In `browserChecks`, insert before the block that starts `await openPopover();` followed by `await evaluate(\`document.querySelector('[data-add-computer-row]').click()\`);`:

```js
    const scopes = () => evaluate(`[...document.querySelectorAll('[data-sidebar-scope]')].map((section) => section.dataset.sidebarScope)`);
    // Scope keys hold "|" and "/", which a double-quoted attribute selector takes as they are.
    const inScope = (scope, rest) => `[data-sidebar-scope="${scope}"] ${rest}`;
    const computerLines = (scope) =>
      evaluate(`[...document.querySelectorAll(${JSON.stringify(inScope(scope, "[data-chat-computer]"))})].map((line) => line.textContent.trim())`);
    await waitFor(`document.querySelectorAll('[data-sidebar-scope]').length === 3`);
    assert.deepEqual(await scopes(), ["c-atlas|/Users/a/atlas-web", "c-studio|/Users/s/homelab", "/work/milagre-ade"], "one list, by Project name");
    await waitFor(`document.querySelectorAll('[data-chat-computer]').length >= 3`);
    assert.deepEqual(await computerLines("/work/milagre-ade"), ["victor-mbp"]);
    assert.deepEqual(await computerLines("c-atlas|/Users/a/atlas-web"), ["atlas"]);
    assert.deepEqual(await computerLines("c-studio|/Users/s/homelab"), ["studio, offline"]);
    assert.equal(await evaluate(`document.querySelector('[data-sidebar-scope="c-studio|/Users/s/homelab"]').hasAttribute('data-offline')`), true, "the offline computer's Project is dimmed");
    assert.equal(await evaluate(`document.querySelector('[data-sidebar-scope="c-atlas|/Users/a/atlas-web"]').hasAttribute('data-offline')`), false);
    await screenshot("merged-list");
    console.log("PASS: every computer's Projects in one list by name, each row naming its computer, the offline one dimmed");

    await evaluate(`[...document.querySelectorAll('[data-sidebar-scope="c-atlas|/Users/a/atlas-web"] [data-chat-id] button')].find((b) => b.textContent.includes('Fix flaky deploy check')).click()`);
    await waitFor(`document.querySelector('[data-chat-pane]')?.textContent.includes('The deploy check fails about one run in five.')`);
    await screenshot("remote-chat");
    console.log("PASS: a remote computer's chat opens from the merged list");

    await evaluate(`window.setOther(false)`);
    await waitFor(`!document.querySelector('[data-chat-computer]')`);
    await waitFor(`!document.querySelector('[data-computers-button]')`);
    await evaluate(`window.setOther(true)`);
    await waitFor(`!!document.querySelector('[data-computers-button]')`);
    console.log("PASS: with only this Mac, rows have no computer line");
```

and change the later `await evaluate(\`window.setOther(false)\`);` block so that it stays the last step (it already is). Opening a remote chat leaves atlas-web open. With Other computers off, Task 16's effect brings this Mac's Project back, which is what the "only this Mac" step expects.

- [ ] **Step 6: Run the check to verify it fails**

Run: `npm test -- --only test-sidebar-computers`
Expected: FAIL (`Timed out: document.querySelectorAll('[data-sidebar-scope]').length === 3`).

- [ ] **Step 7: The second line on a row**

In `apps/desktop/app/src/components/sidebar/ChatRow.tsx`, import `LaptopIcon` from `@hugeicons/core-free-icons` (beside the existing icon imports), and export:

```ts
/** The computer a row's chat lives on, shown on its second line once there are two or more computers. */
export type RowComputer = { name: string; offline: boolean };
```

Add `computer` to `ChatRow`'s props (`computer?: RowComputer;` in the type, `computer,` in the destructuring). After `const hiddenPullRequests = …;`, add:

```ts
  const twoLines = hasPullRequests || item.worktreeCount !== undefined || Boolean(computer);
```

and use `twoLines` in place of `hasPullRequests || item.worktreeCount !== undefined` in the row button's height class and in `ChatMarkDot`'s `topAligned`. Inside the title span, show the worktree count there only without a computer: change `{item.worktreeCount !== undefined && <span …>` to `{item.worktreeCount !== undefined && !computer && <span …>`. Add `${computer?.offline ? "opacity-50" : ""}` to the outer `div[data-chat-id]`'s class list. Replace the PR strip's condition and its first children:

```tsx
        {(hasPullRequests || computer) && !renaming && (
          <div
            data-chat-prs
            className={`sidebar-copy absolute bottom-1 left-9 z-20 flex max-w-[calc(100%-72px)] min-w-0 items-center gap-2 ${archiving ? "opacity-30" : ""}`}
          >
            {computer && (
              <span data-chat-computer className="flex min-w-0 shrink items-center gap-1 truncate text-[12px] leading-4 text-ink-3">
                <HugeiconsIcon icon={LaptopIcon} size={12} strokeWidth={2} color="currentColor" className="shrink-0" />
                {computer.offline ? `${computer.name}, offline` : computer.name}
              </span>
            )}
            {computer && item.worktreeCount !== undefined && <span className="shrink-0 text-[12px] leading-4 text-ink-3">· {item.worktreeCount} Worktrees</span>}
            {computer && hasPullRequests && (
              <span aria-hidden className="text-[12px] leading-4 text-ink-3 opacity-60">
                ·
              </span>
            )}
            {shownPullRequests.map((pr) => (
```

The rest of the strip (the chips and `+N`) stays as it is.

- [ ] **Step 8: The merged list in `SidebarNav`**

In `apps/desktop/app/src/components/SidebarNav.tsx`:

1. Import `import { useComputers, isDimmed } from "../lib/computers";`, `import { mergeScopes, useComputerScopes } from "../lib/computer-scopes";`, `import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";` and `type RowComputer` from `./sidebar/ChatRow`.
2. After `const { sidebarAllProjects, chatOrder } = useSettings();`, add:

```tsx
  // Other computers (Settings › Experimental): their Projects join the list, and every row says its computer.
  const { thisMac, computers } = useComputers();
  const remoteScopes = useComputerScopes(computers);
  const multi = computers.length > 0;
  const everyProject = sidebarAllProjects || multi;
  // One object per computer and state, so memo'd rows keep their props.
  const rowComputers = useRef(new Map<string, RowComputer>());
  const rowComputer = (key: string): RowComputer | undefined => {
    if (!multi) return undefined;
    const id = computerOfKey(key);
    const view = computers.find((computer) => computer.id === id);
    const name = id === LOCAL_COMPUTER ? thisMac : (view?.name ?? "Computer");
    const offline = id !== LOCAL_COMPUTER && isDimmed(view);
    const cacheKey = `${id}\n${name}\n${offline}`;
    let made = rowComputers.current.get(cacheKey);
    if (!made) rowComputers.current.set(cacheKey, (made = { name, offline }));
    return made;
  };
```

3. Tag this Mac's scopes and merge. Replace `.map((row) => ({ key: row.path, name: row.name, initial: row.initial, link: null as NamedProjectLink | null }));` with `.map((row) => ({ key: row.path, name: row.name, initial: row.initial, link: null as NamedProjectLink | null, computerId: LOCAL_COMPUTER }));`. Replace the `const scopes = [...orderedProjects, …];` line with:

```tsx
  const localScopes = [
    ...orderedProjects,
    ...namedLinks.map((link) => ({ key: `milagre-link:${link.id}`, name: link.name, initial: "", link, computerId: LOCAL_COMPUTER })),
  ];
  // With other computers, one list by name (their order can't follow this Mac's open history); with this Mac alone, as before.
  const scopes = multi ? mergeScopes([...localScopes, ...remoteScopes], computers.map((computer) => computer.id)) : localScopes;
```

4. Replace `useProjectImages(sidebarAllProjects ? projects.map((row) => row.path) : NO_PATHS)` with `useProjectImages(everyProject ? [...projects.map((row) => row.path), ...remoteScopes.filter((scope) => !scope.link).map((scope) => scope.key)] : NO_PATHS)`, and `const showAll = sidebarAllProjects && !collapsed;` with `const showAll = everyProject && !collapsed;`.
5. In `groups`, add `computer: rowComputer(scope.key)` to both `list` objects. The open one becomes `{ isActive: …, collapsed: false, actions: chatActions, showHints, onPick: pickChat, linkProjectId: …, computer: rowComputer(scope.key) }`, and the other one gets the same final field. Then return `dimmed: scope.computerId !== LOCAL_COMPUTER && isDimmed(computers.find((computer) => computer.id === scope.computerId))` beside `scope, current, state, list`.
6. In the groups' render, destructure `dimmed` too, and add `data-offline={dimmed || undefined}` and `${dimmed ? "opacity-50" : ""}` to the `<section data-sidebar-scope …>`'s `className`.
7. In `ChatList`, add the prop `computer?: RowComputer;` (destructure `computer`) and pass `computer={computer}` on its `<ChatRow …>`.

- [ ] **Step 9: Run the check and the sidebar checks**

Run: `MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-finish" npm test -- --only test-sidebar-computers`
Expected: PASS with six PASS lines; `merged-list.png` and `remote-chat.png` saved.

Run: `npm test -- --only test-sidebar-all-projects && npm test -- --only test-sidebar-pr && npm test -- --only test-chat-pins && npm test -- --only test-chat-order && npm test -- --only test-project-attention && npm test -- --only test-chat-titles && npm test -- --only test-archive-enter && npm test -- --unit --workspace desktop`
Expected: PASS. Rows without a computer render exactly as before.

- [ ] **Step 10: Commit**

```bash
npx oxfmt apps/desktop/app/src/lib/computer-scopes.ts apps/desktop/app/src/lib/computer-scopes.test.ts apps/desktop/app/src/components/SidebarNav.tsx apps/desktop/app/src/components/sidebar/ChatRow.tsx scripts/test-sidebar-computers.cjs
git add apps/desktop/app/src/lib/computer-scopes.ts apps/desktop/app/src/lib/computer-scopes.test.ts apps/desktop/app/src/components/SidebarNav.tsx apps/desktop/app/src/components/sidebar/ChatRow.tsx scripts/test-sidebar-computers.cjs
git commit -m "feat(desktop): one sidebar for every computer, each row naming its computer"
```

---

### Task 18: Local-only actions leave remote chats

On a remote chat the window must not offer what can only act on this Mac (spec: "hidden on remote chats rather than shown disabled"). That covers the row menu's Open in Finder and Open in editor, the ⌘K "Open in editor" and "Reveal folder", the scope menu's Open in Finder, file links in replies that open an editor, a Link chat's reveal, and Skills › Open and Reveal. Copy path copies the other Mac's own path, not the window's key. Files dropped from this Mac are refused with words, since the other Mac can't read them. Pasted images still go, because they travel as data. (The Add project folder dialog is Phase C; image menus are Task 26.)

**Files:**
- Modify: `apps/desktop/app/src/components/sidebar/ChatRow.tsx` (`ChatRowActions.remote`, the menu)
- Modify: `apps/desktop/app/src/App.tsx` (`chatActions`, ⌘K commands, `EditorLinks`, `executeSend`)
- Modify: `apps/desktop/app/src/components/SidebarNav.tsx` (`scopeMenu`)
- Modify: `apps/desktop/app/src/components/LinkWorkspace.tsx` (reveal)
- Modify: `apps/desktop/app/src/components/SkillsSettings.tsx` (open, reveal)
- Modify: `scripts/test-sidebar-computers.cjs`

**Interfaces:**
- Consumes: `isRemoteKey` (Task 13), `unqualifyKey` (Task 11).
- Produces: `ChatRowActions.remote?: boolean`. When it is true, the row menu leaves out "reveal" and "editor".

- [ ] **Step 1: Extend the check**

In `scripts/test-sidebar-computers.cjs`, after `await screenshot("remote-chat");`, add:

```js
    const menuOf = async (scope, title) => {
      await evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(inScope(scope, "[data-chat-id] button"))})].find((b) => b.textContent.includes(${JSON.stringify(title)})); const r = button.getBoundingClientRect(); button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 10 })); })()`);
      await waitFor(`!!document.querySelector('[role="menu"]')`);
      const labels = await evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent.trim())`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await waitFor(`!document.querySelector('[role="menu"]')`);
      return labels;
    };
    const remoteMenu = await menuOf("c-atlas|/Users/a/atlas-web", "Fix flaky deploy check");
    assert.equal(remoteMenu.some((label) => /Finder|editor|Open in/.test(label)), false, `no local-only entry on a remote chat: ${remoteMenu}`);
    assert.ok(remoteMenu.includes("Commit and open PR…"), "git works on the other Mac");
    const localMenu = await menuOf("/work/milagre-ade", "Desktop connect sidebar");
    assert.ok(localMenu.some((label) => /Finder|file manager/.test(label)), "this Mac's chats keep them");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: ["meta"] });
    await waitFor(`!!document.querySelector('dialog[open][aria-label="Command palette"]')`);
    const commands = await evaluate(`[...document.querySelectorAll('dialog[open] [role="option"]')].map((option) => option.textContent.trim())`);
    assert.equal(commands.some((label) => /Reveal folder|Open in editor/.test(label)), false, `no local-only command for a remote chat: ${commands}`);
    await evaluate(`document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog[open]')`);
    console.log("PASS: a remote chat's menus and commands leave out Finder and the editor; this Mac's keep them");
```

A right-click opens the row's menu without opening its chat, so the atlas chat from Task 17 is still the one on screen when ⌘K lists its "Current chat" commands.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only test-sidebar-computers`
Expected: FAIL (`no local-only entry on a remote chat: …,Open in Finder,…`).

- [ ] **Step 3: The row menu**

In `apps/desktop/app/src/components/sidebar/ChatRow.tsx`, add to `ChatRowActions`:

```ts
  /** The chat is on another Mac: the menu leaves out what only acts on this one (Finder, the editor). */
  remote?: boolean;
```

In `ChatMenu`, the entries are one array literal (the one holding `key: "reveal"` and `key: "editor"`). Close that literal with `].filter((entry) => !actions.remote || (entry.key !== "reveal" && entry.key !== "editor"))` instead of `]`.

- [ ] **Step 4: App**

In `apps/desktop/app/src/App.tsx`:

1. Before `const chatActions = useMemo<ChatRowActions>(`, add `const remoteProject = isRemoteKey(project?.path);`. In the memo, replace the `onReveal:` and `onOpenInEditor:` lines with:

```tsx
      ...(remoteProject
        ? { remote: true }
        : {
            onReveal: (id: string) => latest.current.revealChat(Number(id)),
            onOpenInEditor: (id: string) => latest.current.openChatInEditor(Number(id)),
          }),
```

and change its dependency list from `[]` to `[remoteProject]`.

2. In the ⌘K commands, wrap the `{ id: "editor", … }` object and the `{ id: "reveal", … }` object in one spread:

```tsx
        ...(isRemoteKey(project.path)
          ? []
          : [
              { id: "editor", label: "Open in editor", group: "Current chat", icon: "editor", keywords: "code vscode cursor", run: () => openChatInEditor(sessionId) },
              { id: "reveal", label: "Reveal folder", group: "Current chat", icon: "folder", keywords: "finder explorer worktree", run: () => revealChat(sessionId) },
            ]),
```

3. Replace `<EditorLinks root={selectedWorktree?.path ?? project.path}>` with `<EditorLinks root={isRemoteKey(project.path) ? "" : (selectedWorktree?.path ?? project.path)}>`. An empty root turns file links into plain text (`editor-links.tsx:18`).
4. In `executeSend`, after its first `if (…) return false;`, add:

```tsx
    // A file attached from this Mac is a path the other Mac can't read; pasted images travel as data and still go.
    if (isRemoteKey(project.path) && files.length) {
      setNotice("Files from this Mac can't be attached to a chat on another computer. Paste images instead.");
      return false;
    }
```

- [ ] **Step 5: The scope menu, Links and Skills**

In `apps/desktop/app/src/components/SidebarNav.tsx`'s `scopeMenu`, change `"copy-path": { run: () => copy(scope.key) },` to `"copy-path": { run: () => copy(unqualifyKey(scope.key)) },` (import `unqualifyKey` from `@milagre/shared/chat-scopes`), and filter the projected actions:

```tsx
      ...projectMenuActions(IS_MAC)
        .filter((item) => item.key !== "reveal" || !isRemoteKey(scope.key))
        .map((item) => ({ key: item.key, label: item.label, icon: PROJECT_MENU_ICONS[item.key], ...actions[item.key] })),
```

(import `isRemoteKey` from `../lib/computer-bridge`).

In `apps/desktop/app/src/components/LinkWorkspace.tsx`, make both reveals conditional: `onReveal: isRemoteKey(owner) ? undefined : …` for the row actions (line 438's handler), and `onReveal={isRemoteKey(owner) ? undefined : (member) => void window.milagre.revealInFolder(member.worktreePath)}` (line 606). Add `remote: isRemoteKey(owner)` to the row actions object.

In `apps/desktop/app/src/components/SkillsSettings.tsx`, render the Open and Reveal buttons only when `!isRemoteKey(projectPath)` (wrap each button's JSX in `{!isRemoteKey(projectPath) && (…)}`).

- [ ] **Step 6: Run the checks**

Run: `npm test -- --only test-sidebar-computers && npm test -- --only test-command-palette && npm test -- --only test-skills-settings && npm test -- --only test-project-links && npm test -- --only test-chat-attachments && npm test -- --unit --workspace desktop`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/app/src/components/sidebar/ChatRow.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/components/SidebarNav.tsx apps/desktop/app/src/components/LinkWorkspace.tsx apps/desktop/app/src/components/SkillsSettings.tsx scripts/test-sidebar-computers.cjs
git add apps/desktop/app/src/components/sidebar/ChatRow.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/components/SidebarNav.tsx apps/desktop/app/src/components/LinkWorkspace.tsx apps/desktop/app/src/components/SkillsSettings.tsx scripts/test-sidebar-computers.cjs
git commit -m "feat(desktop): a remote chat offers nothing that only acts on this Mac"
```

---

### Task 19: An offline computer's chat: the banner and a disabled composer

When the open Project's computer is offline (or refused), the chat shows the banner from `sidebar-c-sections` v3 above the transcript and the composer is disabled. Its placeholder ends in " (studio is offline)". While the computer is only reconnecting, the composer is disabled without the banner. A send that slips through is refused with "studio is offline." A chat with no cached copy says "No copy of this chat on this Mac yet." under the banner.

**Files:**
- Create: `apps/desktop/app/src/components/OfflineBanner.tsx`
- Modify: `apps/desktop/app/src/components/PromptComposer.tsx` (`offlineName`), `apps/desktop/app/src/components/ChatComposer.tsx` (pass it through)
- Modify: `apps/desktop/app/src/App.tsx` (the open computer, the banner, `sendBlocked`, `executeSend`)
- Modify: `scripts/test-sidebar-computers.cjs`

**Interfaces:**
- Consumes: `isDimmed`, `isReadOnly`, `offlineBanner`, `offlinePlaceholder` (Task 6); `isRemoteKey`, `computerOfKey`.
- Produces:
  - `OfflineBanner({ text, empty }: { text: string; empty: boolean })`, with markers `[data-offline-banner]` and `[data-offline-empty]`
  - `PromptComposer`'s and `ChatComposer`'s `offlineName?: string | null`

- [ ] **Step 1: Extend the check**

In `scripts/test-sidebar-computers.cjs`, after the menus' PASS line, add:

```js
    await evaluate(`[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/homelab"] [data-chat-id] button')].find((b) => b.textContent.includes('Backup rotation')).click()`);
    await waitFor(`!!document.querySelector('[data-offline-banner]')`);
    assert.equal(
      await evaluate(`document.querySelector('[data-offline-banner]').textContent.trim()`),
      "studio is offline. This is the last copy it sent, 2h ago. You can read it until studio is back.",
    );
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').disabled`), true);
    assert.match(await evaluate(`document.querySelector('textarea[aria-label="Prompt"]').placeholder`), / \(studio is offline\)$/);
    assert.equal(await evaluate(`!!document.querySelector('[data-offline-empty]')`), false, "a cached chat shows its copy");
    assert.ok(await evaluate(`document.querySelector('[data-chat-pane]').textContent.includes('Rotate the nightly backups.')`));
    await screenshot("offline-chat");
    console.log("PASS: an offline computer's chat shows the last copy under the banner, with the composer off");

    // The computer comes back: the banner goes and sending works, to that computer.
    await evaluate(`window.setComputers(window.computerList.map((c) => c.id === 'c-studio' ? { ...c, state: 'online', route: 'relay', lastSeen: Date.now() } : c))`);
    await waitFor(`!document.querySelector('[data-offline-banner]') && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
    await evaluate(`(() => { const box = document.querySelector('textarea[aria-label="Prompt"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Keep 8 dailies"); box.dispatchEvent(new Event("input", { bubbles: true })); box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    await waitFor(`window.sent.length === 1`);
    assert.equal(await evaluate(`window.sent[0].projectPath`), "c-studio|/Users/s/homelab", "the send goes to studio's bridge, with the key main strips");
    console.log("PASS: back online, the composer sends to that computer");

    // Removing the computer whose chat is open brings this Mac's Project back.
    await evaluate(`window.setComputers(window.computerList.filter((c) => c.id !== 'c-studio'))`);
    await waitFor(`!document.querySelector('[data-sidebar-scope="c-studio|/Users/s/homelab"]') && !document.querySelector('[data-offline-banner]')`);
    await waitFor(`document.querySelector('[data-sidebar-scope][data-current]')?.dataset.sidebarScope === '/work/milagre-ade'`);
    console.log("PASS: removing the open chat's computer goes back to this Mac's Project");
```

For an uncached chat, add a third remote Project whose `readChatMessages` the fake answers as main's offline cache does with nothing kept. Add to `remoteProjects` a lean one on studio:

```js
  "c-studio-lean": {
    path: "c-studio|/Users/s/notes",
    name: "notes",
    // A host that keeps messages by Chat sends none in its state; the Chat's summary lists it in the sidebar.
    state: { ...remoteState("Never opened here", ""), messages: [], messagesInChats: true, sessions: { 4: { id: 4, worktree_id: 1, agent_name: "Claude", provider: "claude", status: "Idle", title: "Never opened here", summary: { count: 3, firstId: 1, lastId: 3 } } } },
  },
```

The fake bridges from Task 17 already list every Project of their computer and answer `readChatMessages` with nothing kept. Then, before the "comes back" step:

```js
    await evaluate(`[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/notes"] [data-chat-id] button')].find((b) => b.textContent.includes('Never opened here')).click()`);
    await waitFor(`!!document.querySelector('[data-offline-empty]')`);
    assert.equal(await evaluate(`document.querySelector('[data-offline-empty]').textContent.trim()`), "No copy of this chat on this Mac yet.");
    await evaluate(`[...document.querySelectorAll('[data-sidebar-scope="c-studio|/Users/s/homelab"] [data-chat-id] button')].find((b) => b.textContent.includes('Backup rotation')).click()`);
    await waitFor(`document.querySelector('[data-chat-pane]').textContent.includes('Rotate the nightly backups.')`);
```

Update the earlier merged-list assertion to the four scopes it now has: `["c-atlas|/Users/a/atlas-web", "c-studio|/Users/s/homelab", "/work/milagre-ade", "c-studio|/Users/s/notes"]`, and its wait to `=== 4`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only test-sidebar-computers`
Expected: FAIL (`Timed out: !!document.querySelector('[data-offline-banner]')`).

- [ ] **Step 3: The banner**

Create `apps/desktop/app/src/components/OfflineBanner.tsx`:

```tsx
/** Over an offline computer's chat (design sidebar-c-sections v3): the last copy it sent, readable, nothing sendable. */
export function OfflineBanner({ text, empty }: { text: string; empty: boolean }) {
  return (
    <div className="mx-auto mt-3 mb-1 w-full max-w-3xl shrink-0 px-5">
      <div role="status" data-offline-banner className="flex items-center gap-2.5 rounded-[10px] bg-hover px-3 py-2 text-[12.5px] text-ink-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: "var(--ink-3)" }} />
        {text}
      </div>
      {empty && (
        <p data-offline-empty className="mt-6 text-center text-[13px] text-ink-3">
          No copy of this chat on this Mac yet.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: The composer**

In `apps/desktop/app/src/components/PromptComposer.tsx`, add to `PromptComposerProps`:

```ts
  /** The chat's computer is away: the field is disabled and its placeholder says so. */
  offlineName?: string | null;
```

destructure `offlineName`, add `disabled={Boolean(offlineName)}` to the prompt `<textarea>`, and make its `placeholder` expression:

```tsx
                placeholder={
                  (running
                    ? // Antigravity can't be steered mid-turn (ACP has no steering); a message waits for the next turn.
                      provider === "antigravity"
                      ? "Queue a message for the next turn…"
                      : "Steer the agent…"
                    : "Prompt or mention a file with @") + (offlineName ? offlinePlaceholder(offlineName) : "")
                }
```

(import `offlinePlaceholder` from `../lib/computers`). In `ChatComposer.tsx`, add `offlineName?: string | null;` to its props type, destructure it, and pass `offlineName={offlineName}` to `<PromptComposer`.

- [ ] **Step 5: App**

In `apps/desktop/app/src/App.tsx`, import `OfflineBanner` and `isDimmed, isReadOnly, offlineBanner` (from `./lib/computers`). After the `knownComputers` effect from Task 16, add:

```tsx
  // The open Project's computer, when it is another Mac: read-only while it isn't online, with the banner while it is away.
  const openComputer = project && isRemoteKey(project.path) ? pairedComputers.find((computer) => computer.id === computerOfKey(project.path)) : undefined;
  const readOnly = Boolean(project && isRemoteKey(project.path) && isReadOnly(openComputer));
  const awayBanner = openComputer && isDimmed(openComputer) ? offlineBanner(openComputer, Date.now()) : null;
```

In `executeSend`, after the attached-files check from Task 18, add:

```tsx
    if (readOnly) {
      setNotice(`${openComputer?.name ?? "That computer"} is offline.`);
      return false;
    }
```

Inside `<div data-chat-pane …>`, before `<EditorLinks`, add:

```tsx
              {awayBanner && <OfflineBanner text={awayBanner} empty={Boolean(lean && selectedSession && !chatWindow.loading && chatWindow.messages.length === 0)} />}
```

On `<DraftChatComposer`, change `sendBlocked={preparing}` to `sendBlocked={preparing || readOnly}` and add `offlineName={readOnly ? (openComputer?.name ?? "That computer") : null}`.

- [ ] **Step 6: Run the checks**

Run: `MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-finish" npm test -- --only test-sidebar-computers`
Expected: PASS; `offline-chat.png` saved.

Run: `npm test -- --only test-chat-send-feedback && npm test -- --only test-prompt-skills && npm test -- --only test-chat-attachments && npm test -- --only test-chat-layout && npm test -- --only test-chat-drafts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/app/src/components/OfflineBanner.tsx apps/desktop/app/src/components/PromptComposer.tsx apps/desktop/app/src/components/ChatComposer.tsx apps/desktop/app/src/App.tsx scripts/test-sidebar-computers.cjs
git add apps/desktop/app/src/components/OfflineBanner.tsx apps/desktop/app/src/components/PromptComposer.tsx apps/desktop/app/src/components/ChatComposer.tsx apps/desktop/app/src/App.tsx scripts/test-sidebar-computers.cjs
git commit -m "feat(desktop): an offline computer's chat reads its last copy, with the composer off"
```

---
### Task 20: The offline cache

Each computer's last copy lives in `userData/computers/<id>/cache.sqlite`, through `node:sqlite` as ADR-0007 has it: its Project, Link and registry lists, each scope's last whole state, and the chat windows of its last 20 opened chats. Main writes the lists from the calls it routes, and the states it routes from `project:read`, `project:switch` and `project:open`. The window forwards each remote state and chat window as they change (`computers:remember`), held back a few seconds per key. While a computer isn't online, the read calls the window makes are answered from the cache. Anything else fails with "studio is offline." Removing the computer deletes its folder.

**Files:**
- Modify: `packages/core/src/chat-db.cjs:112` (export `database`)
- Create: `apps/desktop/electron/computer-cache.cjs`, `apps/desktop/electron/computer-cache.test.cjs`
- Modify: `apps/desktop/electron/computers-ipc.cjs` (offline reads, writes, `computers:remember`, removal), `apps/desktop/electron/computers-ipc.test.cjs`
- Modify: `apps/desktop/electron/main.cjs` (create the caches, close them on quit), `apps/desktop/electron/preload.cjs` (`computers.remember`), `apps/desktop/tsconfig.electron.json`
- Create: `apps/desktop/app/src/lib/offline-cache.ts`
- Modify: `apps/desktop/app/src/lib/chat-messages.ts` (`set`), `apps/desktop/app/src/App.tsx` (start it), `apps/desktop/app/src/electron.d.ts` (`ComputersApi.remember`), `apps/desktop/app/src/lib/routed-bridge.test.ts` (allow `lib/offline-cache.ts`: `computers`)

**Interfaces:**
- Consumes: `database()` (`@milagre/core/chat-db`); `stripComputer`, `qualifyResult` (Task 12); `stateEvents` (Task 14); `isRemoteKey`, `computerOfKey`.
- Produces:
  - `createComputerCaches({ dir: string, now?: () => number }) => { put(id, kind, key, value): void; get(id, kind, key): unknown | null; remove(id): Promise<void>; close(): void }`, where `kind` is `"recent" | "links" | "registry" | "scope" | "chat"`
  - `registerComputers({ …, cache })`
  - IPC `computers:remember(id, entry)`, with `entry` either `{ kind: "state", scope, state }` or `{ kind: "chat", scope, chatId, window: { messages, hasMore, total } }`
  - `rememberState(scope, state)`, `rememberChat(scope, chatId, window)` and `startOfflineCache()` from `lib/offline-cache.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/electron/computer-cache.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createComputerCaches } = require("./computer-cache.cjs");

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computer-cache-"));
  let clock = 1000;
  const caches = createComputerCaches({ dir, now: () => ++clock });
  t.after(async () => {
    caches.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, caches };
}

test("a computer's lists, states and chat windows are kept in its own cache.sqlite, and read back", async (t) => {
  const { dir, caches } = await setup(t);
  caches.put(ID, "recent", "", [{ path: "/p", name: "p" }]);
  caches.put(ID, "scope", "/p", { name: "p", state: { sessions: { 1: { id: 1 } } } });
  caches.put(ID, "chat", "/p#1", { messages: [{ id: 1, body: "hi" }], hasMore: false, total: 1 });
  assert.deepEqual(caches.get(ID, "recent", ""), [{ path: "/p", name: "p" }]);
  assert.deepEqual(caches.get(ID, "scope", "/p"), { name: "p", state: { sessions: { 1: { id: 1 } } } });
  assert.deepEqual(caches.get(ID, "chat", "/p#1").messages, [{ id: 1, body: "hi" }]);
  assert.equal(caches.get(ID, "chat", "/p#2"), null);
  assert.ok((await fs.stat(path.join(dir, ID, "cache.sqlite"))).isFile());
});

test("only the last 20 opened chats are kept, and removing the computer deletes its folder", async (t) => {
  const { dir, caches } = await setup(t);
  for (let id = 1; id <= 25; id++) caches.put(ID, "chat", `/p#${id}`, { messages: [], hasMore: false, total: 0 });
  assert.equal(caches.get(ID, "chat", "/p#5"), null, "the oldest five are gone");
  assert.notEqual(caches.get(ID, "chat", "/p#6"), null);
  assert.notEqual(caches.get(ID, "chat", "/p#25"), null);
  caches.put(ID, "chat", "/p#6", { messages: [{ id: 6 }], hasMore: false, total: 1 });
  caches.put(ID, "chat", "/p#26", { messages: [], hasMore: false, total: 0 });
  assert.notEqual(caches.get(ID, "chat", "/p#6"), null, "opened again, it is recent again");
  assert.equal(caches.get(ID, "chat", "/p#7"), null);
  await caches.remove(ID);
  await assert.rejects(fs.stat(path.join(dir, ID)), { code: "ENOENT" });
  assert.equal(caches.get(ID, "chat", "/p#6"), null);
});

test("an id that isn't a computer's is refused, so no path leaves the cache folder", async (t) => {
  const { caches } = await setup(t);
  assert.throws(() => caches.put("../x", "recent", "", []), /computer/);
  await assert.rejects(caches.remove(".."), /computer/);
});
```

In `apps/desktop/electron/computers-ipc.test.cjs`, change `setup` to take `{ computers, cache }`, passing `cache` through to `registerComputers`. Its signature becomes `function setup(computers, { cache } = {})`, and the `registerComputers({ … })` call gains `cache,`. Then append:

```js
test("while a computer isn't online, the window's reads come from its cache; anything else says it is offline", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { createComputerCaches } = require("./computer-cache.cjs");
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computers-ipc-cache-"));
  const cache = createComputerCaches({ dir });
  t.after(async () => {
    cache.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  let state = "online";
  const removed = [];
  const { call } = setup(
    {
      list: () => [{ ...studio, id: ID, state }],
      invoke: async (_id, method) =>
        method === "project:recent" ? [{ path: "/p", name: "p" }] : method === "project:switch" ? { path: "/p", name: "p", state: { sessions: { 4: { id: 4 } } } } : null,
      remove: async (id) => void removed.push(id),
    },
    { cache },
  );
  // Online: answers go through, and the lists and states they carry are kept.
  assert.deepEqual(await call("computers:invoke", ID, "project:recent", []), [{ path: `${ID}|/p`, name: "p" }]);
  await call("computers:invoke", ID, "project:switch", [`${ID}|/p`]);
  await call("computers:remember", ID, { kind: "chat", scope: `${ID}|/p`, chatId: 4, window: { messages: [{ id: 9, body: "kept" }], hasMore: true, total: 30 } });
  await call("computers:remember", ID, { kind: "state", scope: `${ID}|/p`, state: { sessions: { 4: { id: 4, title: "newer" } } } });

  state = "offline";
  assert.deepEqual(await call("computers:invoke", ID, "project:recent", []), [{ path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(await call("computers:invoke", ID, "project:switch", [`${ID}|/p`]), { path: `${ID}|/p`, name: "p", state: { sessions: { 4: { id: 4, title: "newer" } } } });
  assert.deepEqual(await call("computers:invoke", ID, "chat:messages", [`${ID}|/p`, 4, { turns: 20 }]), { messages: [{ id: 9, body: "kept" }], hasMore: false, total: 30 });
  assert.deepEqual(await call("computers:invoke", ID, "chat:messages", [`${ID}|/p`, 5, { turns: 20 }]), { messages: [], hasMore: false, total: 0 }, "a chat never kept reads empty");
  assert.deepEqual(await call("computers:invoke", ID, "chat:messages", [`${ID}|/p`, 4, { before: 9 }]), { messages: [], hasMore: false, total: 30 });
  assert.deepEqual(await call("computers:invoke", ID, "chat:runs", []), { runs: {}, seq: 0 });
  await assert.rejects(call("computers:invoke", ID, "project:switch", [`${ID}|/never`]), { message: "studio is offline." });
  await assert.rejects(call("computers:invoke", ID, "chat:send", [{ projectPath: `${ID}|/p` }]), { message: "studio is offline." });

  await call("computers:remove", ID);
  assert.deepEqual(removed, [ID]);
  assert.equal(cache.get(ID, "recent", ""), null, "its cache went with it");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/desktop/electron/computer-cache.test.cjs apps/desktop/electron/computers-ipc.test.cjs`
Expected: FAIL (`Cannot find module './computer-cache.cjs'`).

- [ ] **Step 3: Share the SQLite loader**

In `packages/core/src/chat-db.cjs`, change the export line to:

```js
module.exports = { MESSAGES_MARKER, isMarker, dbFile, readMessages, writeMessages, database };
```

- [ ] **Step 4: `computer-cache.cjs`**

Create `apps/desktop/electron/computer-cache.cjs`:

```js
const fs = require("node:fs");
const path = require("node:path");
const { database } = require("@milagre/core/chat-db");

// Spec "Offline cache": the transcripts of a computer's last 20 opened chats.
const MAX_CHATS = 20;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
  CREATE INDEX IF NOT EXISTS entries_at ON entries (kind, at);
`;
const checked = (computerId) => {
  if (typeof computerId !== "string" || !ID.test(computerId)) throw new Error("That isn't a computer's id.");
  return computerId;
};

/**
 * Each paired computer's last copy (spec "Offline cache"), in `<dir>/<computerId>/cache.sqlite`, keyed as the computer
 * itself names things (no window qualifier): its Project, Link and registry lists (kinds "recent", "links", "registry",
 * key ""), each scope's last whole state ("scope", by scope key: { name, state }), and its last 20 chat windows ("chat",
 * by chat key: { messages, hasMore, total }). node:sqlite, as ADR-0007; one handle per computer, closed by remove/close.
 * @param {{ dir: string; now?: () => number }} options
 */
function createComputerCaches({ dir, now = Date.now }) {
  /** @type {Map<string, any>} */
  const open = new Map();
  function db(computerId) {
    const id = checked(computerId);
    let handle = open.get(id);
    if (!handle) {
      fs.mkdirSync(path.join(dir, id), { recursive: true, mode: 0o700 });
      handle = new (database().DatabaseSync)(path.join(dir, id, "cache.sqlite"));
      handle.exec(SCHEMA);
      open.set(id, handle);
    }
    return handle;
  }
  return {
    /** @param {string} computerId @param {string} kind @param {string} key @param {unknown} value */
    put(computerId, kind, key, value) {
      const handle = db(computerId);
      handle.prepare("INSERT INTO entries (kind, key, payload, at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET payload = excluded.payload, at = excluded.at").run(kind, key, JSON.stringify(value), now());
      if (kind === "chat")
        handle.prepare("DELETE FROM entries WHERE kind = 'chat' AND key NOT IN (SELECT key FROM entries WHERE kind = 'chat' ORDER BY at DESC LIMIT ?)").run(MAX_CHATS);
    },
    /** @param {string} computerId @param {string} kind @param {string} key */
    get(computerId, kind, key) {
      if (!fs.existsSync(path.join(dir, checked(computerId), "cache.sqlite"))) return null;
      const row = db(computerId).prepare("SELECT payload FROM entries WHERE kind = ? AND key = ?").get(kind, key);
      return row ? JSON.parse(String(row.payload)) : null;
    },
    /** Removing a computer deletes its folder. @param {string} computerId */
    async remove(computerId) {
      const id = checked(computerId);
      open.get(id)?.close();
      open.delete(id);
      await fs.promises.rm(path.join(dir, id), { recursive: true, force: true });
    },
    close() {
      for (const handle of open.values()) handle.close();
      open.clear();
    },
  };
}

module.exports = { createComputerCaches };
```

- [ ] **Step 5: Offline reads, writes and `computers:remember` in `computers-ipc.cjs`**

Add `cache = null` to `registerComputers`'s options and, above it:

```js
// Kept as they pass (main sees whole lists and the states a Project opens with); the window forwards the rest.
const KEPT_LISTS = { "project:recent": "recent", "link:list": "links", "project:registry": "registry" };
const OPENED = new Set(["project:read", "project:switch", "project:open", "project:current"]);
// What a window reads that a computer's last copy can answer while it is away.
const MAX_REMEMBERED_CHARS = 32 * 1024 * 1024;
const nameOf = (projectPath, recent) => recent?.find?.((project) => project.path === projectPath)?.name ?? projectPath.split("/").filter(Boolean).at(-1) ?? projectPath;

/** A read answered from the cache, or null when the cache can't answer it. */
function readOffline(cache, id, method, args) {
  if (KEPT_LISTS[method]) return cache.get(id, KEPT_LISTS[method], "") ?? [];
  if (OPENED.has(method)) {
    const scope = args[0];
    const kept = typeof scope === "string" ? cache.get(id, "scope", scope) : null;
    return kept ? { path: scope, name: kept.name, state: kept.state } : null;
  }
  if (method === "link:snapshot" || method === "link:open") {
    const kept = typeof args[0] === "string" ? cache.get(id, "scope", `milagre-link:${args[0]}`) : null;
    if (!kept) return null;
    const link = { id: args[0], name: kept.name, projectIds: [], createdAt: "" };
    return method === "link:open" ? { link, state: kept.state, projects: [] } : { link, state: kept.state };
  }
  if (method === "chat:messages") {
    const [scope, chatId, options] = args;
    const kept = typeof scope === "string" ? cache.get(id, "chat", `${scope}#${chatId}`) : null;
    if (options?.before !== undefined) return { messages: [], hasMore: false, total: kept?.total ?? 0 };
    return kept ? { messages: kept.messages, hasMore: false, total: kept.total } : { messages: [], hasMore: false, total: 0 };
  }
  if (method === "chat:runs") return { runs: {}, seq: 0 };
  if (method === "agent:ports") return {};
  return null;
}
```

Replace the `computers:invoke` handler with:

```js
  ipcMain.handle("computers:invoke", async (_event, id, channel, args) => {
    const computerId = String(id);
    const name = String(channel);
    if (isLocalOnly(name)) throw new Error(NOT_REMOTE);
    const method = ALIASES[name] ?? name;
    const bare = stripComputer(computerId, Array.isArray(args) ? args : []);
    const computer = computers.list().find((item) => item.id === computerId);
    // Away (or off): its last copy answers what it can; nothing is sent.
    if (computer && computer.state !== "online") {
      const kept = cache ? readOffline(cache, computerId, method, bare) : null;
      if (kept === null) throw new Error(`${computer.name} is offline.`);
      return qualifyResult(computerId, method, kept);
    }
    const result = await computers.invoke(computerId, method, bare);
    try {
      if (cache && KEPT_LISTS[method] && Array.isArray(result)) cache.put(computerId, KEPT_LISTS[method], "", result);
      if (cache && OPENED.has(method) && result?.state && typeof result.path === "string")
        cache.put(computerId, "scope", result.path, { name: result.name ?? nameOf(result.path, cache.get(computerId, "recent", "")), state: result.state });
    } catch {
      /* the cache is a copy: a failed write never fails the call */
    }
    return qualifyResult(computerId, method, result);
  });
  // The window forwards a remote scope's whole state and a chat's window as they change (offline-cache.ts).
  ipcMain.handle("computers:remember", (_event, id, entry) => {
    const computerId = String(id);
    if (!cache || !entry || typeof entry !== "object" || typeof entry.scope !== "string") return;
    const scope = stripComputer(computerId, entry.scope);
    const text = JSON.stringify(entry);
    if (text.length > MAX_REMEMBERED_CHARS) return;
    if (entry.kind === "state" && entry.state && typeof entry.state === "object") {
      const recent = cache.get(computerId, "recent", "");
      cache.put(computerId, "scope", scope, { name: nameOf(scope, recent), state: stripComputer(computerId, entry.state) });
    } else if (entry.kind === "chat" && Number.isSafeInteger(entry.chatId) && Array.isArray(entry.window?.messages))
      cache.put(computerId, "chat", `${scope}#${entry.chatId}`, {
        messages: entry.window.messages.slice(-200),
        hasMore: Boolean(entry.window.hasMore),
        total: Number(entry.window.total) || entry.window.messages.length,
      });
  });
```

and in `computers:remove`, after `await computers.remove(String(id));`, add `await cache?.remove(String(id)).catch(() => {});`.

In `main.cjs`, before `computersIpc = registerComputers({`, add:

```js
  const { createComputerCaches } = require("./computer-cache.cjs");
  const computerCaches = createComputerCaches({ dir: path.join(app.getPath("userData"), "computers") });
```

pass `cache: computerCaches,` to `registerComputers`, and in `prepareQuit` change the `Promise.all` line to:

```js
      await Promise.all([runtime.close(), computers.close()]);
      computerCaches.close();
```

In `preload.cjs`'s `computers` group, add `remember: (id, entry) => ipcRenderer.invoke("computers:remember", id, entry),`. In `electron.d.ts`'s `ComputersApi`, add:

```ts
  /** Keeps a remote scope's state or a chat's window as its offline copy. */
  remember: (
    id: string,
    entry: { kind: "state"; scope: string; state: unknown } | { kind: "chat"; scope: string; chatId: number; window: { messages: unknown[]; hasMore: boolean; total: number } },
  ) => Promise<void>;
```

Add `"electron/computer-cache.cjs"` to `include` in `apps/desktop/tsconfig.electron.json`.

- [ ] **Step 6: The window forwards what it keeps current**

Create `apps/desktop/app/src/lib/offline-cache.ts`:

```ts
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { isRemoteKey } from "./computer-bridge.ts";
import { stateEvents } from "./state-events.ts";

// A paired computer's states and chat windows, forwarded to main as they change so its last copy can be read while it
// is away (spec "Offline cache"). Held back per key: a streaming turn changes a state many times a second.
const DELAY_MS = 3000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function later(key: string, write: () => void) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      write();
    }, DELAY_MS),
  );
}
const remember = (scope: string, entry: Parameters<typeof window.milagre.computers.remember>[1]) =>
  void Promise.resolve(window.milagre.computers?.remember?.(computerOfKey(scope), entry)).catch(() => {});

export function rememberState(scope: string, state: unknown) {
  if (!isRemoteKey(scope) || !state) return;
  later(`state\n${scope}`, () => remember(scope, { kind: "state", scope, state }));
}
export function rememberChat(scope: string, chatId: number, chat: { messages: unknown[]; hasMore: boolean; total: number }) {
  if (!isRemoteKey(scope)) return;
  later(`chat\n${scope}#${chatId}`, () => remember(scope, { kind: "chat", scope, chatId, window: { messages: chat.messages, hasMore: chat.hasMore, total: chat.total } }));
}
let started = false;
/** Follows every remote scope's state; App starts it once. */
export function startOfflineCache() {
  if (started) return;
  started = true;
  stateEvents.onProjectState(({ path, state }) => rememberState(path, state));
  stateEvents.onLinkState(({ linkId, state }) => rememberState(`milagre-link:${linkId}`, state));
}
```

In `apps/desktop/app/src/lib/chat-messages.ts`, import `rememberChat` from `./offline-cache.ts`, and at the end of `set(key, next)` add:

```ts
  // A remote chat's window is its computer's offline copy too.
  if (!next.loading && !next.error) {
    const at = key.lastIndexOf("#");
    rememberChat(key.slice(0, at), Number(key.slice(at + 1)), next);
  }
```

In `App.tsx`, import `startOfflineCache` and add `useEffect(() => startOfflineCache(), []);` beside `useApplyOtherComputers();`. In `lib/routed-bridge.test.ts`, add `"lib/offline-cache.ts": ["computers"],` to `ALLOWED`.

- [ ] **Step 7: Run the tests**

Run: `node --test apps/desktop/electron/computer-cache.test.cjs apps/desktop/electron/computers-ipc.test.cjs && npm test -- --unit --workspace desktop && npm test -- --unit --workspace core && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx oxfmt packages/core/src/chat-db.cjs apps/desktop/electron/computer-cache.cjs apps/desktop/electron/computer-cache.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/main.cjs apps/desktop/electron/preload.cjs apps/desktop/tsconfig.electron.json apps/desktop/app/src/lib/offline-cache.ts apps/desktop/app/src/lib/chat-messages.ts apps/desktop/app/src/App.tsx apps/desktop/app/src/electron.d.ts apps/desktop/app/src/lib/routed-bridge.test.ts
git add packages/core/src/chat-db.cjs apps/desktop/electron/computer-cache.cjs apps/desktop/electron/computer-cache.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/main.cjs apps/desktop/electron/preload.cjs apps/desktop/tsconfig.electron.json apps/desktop/app/src/lib/offline-cache.ts apps/desktop/app/src/lib/chat-messages.ts apps/desktop/app/src/App.tsx apps/desktop/app/src/electron.d.ts apps/desktop/app/src/lib/routed-bridge.test.ts
git commit -m "feat(desktop): each computer's last copy, read while it is offline"
```

---

### Task 21: OS notifications for remote chats name the computer

Spec "Routing": "OS notifications for a remote computer's chats go through the existing `AttentionNotifier`, labeled with the computer." Main hands a computer's agent events to the notifier, so it knows that computer's requests and completed turns. A computer's waiting notices go to the notifier with the computer's name before the subtitle, under the same "Notify when waiting" setting. The window labels a remote turn's completion the same way. Clicking one opens the chat by its qualified key, which App already opens on its own Mac.

**Files:**
- Modify: `apps/desktop/electron/notifications.cjs` (`labelFor`), `apps/desktop/electron/notifications.test.cjs`
- Modify: `apps/desktop/electron/computers-ipc.cjs` (`onRemoteEvent`), `apps/desktop/electron/computers-ipc.test.cjs`
- Modify: `apps/desktop/electron/main.cjs` (pass `onRemoteEvent`)
- Modify: `apps/desktop/app/src/lib/computers.ts` (`withComputer`), `apps/desktop/app/src/lib/computers.test.ts`, `apps/desktop/app/src/App.tsx` (the two `notifyCompletion` calls)

**Interfaces:**
- Produces:
  - `labelFor(subtitle: string | undefined, computerName: string | null): string | undefined` (notifications.cjs)
  - `registerComputers({ …, onRemoteEvent?: (computerId, channel, payload) => void })`, where `payload` is already qualified
  - `withComputer(key: string, subtitle: string): string` (lib/computers.ts)

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/electron/notifications.test.cjs` (add `labelFor` to the `require`):

```js
test("a remote chat's notification puts its computer before the subtitle", () => {
  assert.equal(labelFor("Fix login", "studio"), "studio · Fix login");
  assert.equal(labelFor(undefined, "studio"), "studio");
  assert.equal(labelFor("Fix login", null), "Fix login");
});
```

Append to `apps/desktop/electron/computers-ipc.test.cjs`:

```js
test("a computer's events reach main's own listener already naming it", () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const heard = [];
  const handlers = new Map();
  const ipc = registerComputers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    computers: { loaded: Promise.resolve(), list: () => [] },
    thisMac: () => "victor-mbp",
    send: () => {},
    onRemoteEvent: (...event) => heard.push(event),
  });
  ipc.event(ID, "notification:waiting", { chatId: "/p#2", requestId: "q", title: "t", subtitle: "Fix login" });
  assert.deepEqual(heard, [[ID, "notification:waiting", { chatId: `${ID}|/p#2`, requestId: "q", title: "t", subtitle: "Fix login" }]]);
});
```

Append to `apps/desktop/app/src/lib/computers.test.ts` (add `withComputer` to the destructured import):

```ts
test("a remote chat's completion notice names its computer; this Mac's is unchanged", () => {
  assert.equal(withComputer("/p#2", "Fix login"), "Fix login");
  assert.equal(withComputer("c9|/p#2", "Fix login"), "Computer · Fix login", "a computer the list doesn't know yet");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/desktop/electron/notifications.test.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/app/src/lib/computers.test.ts`
Expected: FAIL (`labelFor is not a function`, `onRemoteEvent` never called, `withComputer is not a function`).

- [ ] **Step 3: Implement**

In `apps/desktop/electron/notifications.cjs`, add above `class AttentionNotifier` and export it with the class (`module.exports = { AttentionNotifier, labelFor };`):

```js
/** A remote chat's subtitle, its computer first (spec "Routing": notifications labeled with the computer). */
function labelFor(subtitle, computerName) {
  if (!computerName) return subtitle;
  return subtitle ? `${computerName} · ${subtitle}` : computerName;
}
```

In `apps/desktop/electron/computers-ipc.cjs`, add `onRemoteEvent = () => {}` to the options, and make `event`:

```js
    event: (computerId, channel, payload) => {
      const named = qualifyEvent(computerId, channel, payload);
      try {
        onRemoteEvent(computerId, channel, named);
      } catch {
        /* a listener must not stop the window hearing it */
      }
      send("computers:event", { computerId, channel, payload: named });
    },
```

In `apps/desktop/electron/main.cjs`, import `labelFor` with `AttentionNotifier`, and pass to `registerComputers`:

```js
    // A computer's chats notify like this Mac's, named with the computer; its turns tell the notifier what completed.
    onRemoteEvent: (id, channel, payload) => {
      if (channel === "agent:event") notifier.observe(payload.chatId, payload.event);
      if (channel === "notification:waiting" && notifyWhenWaiting && Notification.isSupported()) {
        const name = computers.list().find((computer) => computer.id === id)?.name ?? null;
        notifier.notify({ ...payload, subtitle: labelFor(payload.subtitle, name) });
      }
    },
```

In `apps/desktop/app/src/lib/computers.ts`, add (importing `computerOfKey`, `LOCAL_COMPUTER` from `@milagre/shared/chat-scopes`):

```ts
/** A completion notice's subtitle: a remote chat's computer first, as main labels its waiting notices. */
export function withComputer(key: string, subtitle: string): string {
  const id = computerOfKey(key);
  if (id === LOCAL_COMPUTER) return subtitle;
  const name = snapshot.computers.find((computer) => computer.id === id)?.name ?? "Computer";
  return subtitle ? `${name} · ${subtitle}` : name;
}
```

In `App.tsx`'s completion effect, wrap both `subtitle: chatTitle(…)` values as `subtitle: withComputer(chatId, chatTitle(…))` (import `withComputer` from `./lib/computers`).

- [ ] **Step 4: Run the tests**

Run: `node --test apps/desktop/electron/notifications.test.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/app/src/lib/computers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx oxfmt apps/desktop/electron/notifications.cjs apps/desktop/electron/notifications.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/main.cjs apps/desktop/app/src/lib/computers.ts apps/desktop/app/src/lib/computers.test.ts apps/desktop/app/src/App.tsx
git add apps/desktop/electron/notifications.cjs apps/desktop/electron/notifications.test.cjs apps/desktop/electron/computers-ipc.cjs apps/desktop/electron/computers-ipc.test.cjs apps/desktop/electron/main.cjs apps/desktop/app/src/lib/computers.ts apps/desktop/app/src/lib/computers.test.ts apps/desktop/app/src/App.tsx
git commit -m "feat(desktop): a remote chat's notifications name its computer"
```

---

### Task 22: End to end: a real Mac's Projects, chats and cache through the window's routing

This extends `computers-e2e.test.cjs` with a test that drives a real throwaway daemon through a local relay the way the window does. It uses `computers-ipc.cjs` over a stand-in `ipcMain`, with the real routing and the real cache. The test lists the remote Project with its key naming the computer, opens it, patches a chat, sees the change arrive as a named event, and reads the chat's window. It then turns the computer off and reads the same list, Project and chat window from the cache.

A real `chat:send` starts an agent turn, and the test Mac has no agent CLI, so sending's routing stays pinned by Task 12's unit test and Task 19's check.

**Files:**
- Modify: `apps/desktop/electron/computers-e2e.test.cjs`

**Interfaces:**
- Consumes: `desk(t, options)`, `linkOf(mac)`, `within`, `first`, `startTestMac`, `until` (this file and `relay-test-kit.cjs`); `registerComputers` (Tasks 4, 12, 20, 21); `createComputerCaches` (Task 20).

- [ ] **Step 1: Write the test**

Append to `apps/desktop/electron/computers-e2e.test.cjs`:

```js
test("the window's routing drives a real Mac: its Project and chats named by computer, events, and its cache once away", async (t) => {
  const { registerComputers } = require("./computers-ipc.cjs");
  const { createComputerCaches } = require("./computer-cache.cjs");
  const forwarded = [];
  // computers.cjs emits into the IPC once it exists; desk() builds computers first, so the hook reads a late binding.
  let ipc = null;
  const { computers, dataDir } = await desk(t, { emit: (id, channel, payload) => ipc?.event(id, channel, payload) });
  const cache = createComputerCaches({ dir: path.join(dataDir, "computers") });
  t.after(() => cache.close());
  const handlers = new Map();
  ipc = registerComputers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    computers,
    thisMac: () => "desk",
    send: (channel, payload) => forwarded.push({ channel, payload }),
    cache,
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender: { isDestroyed: () => false, send() {} } }, ...args);
  const mac = await startTestMac(t, { lan: false });
  const added = await within(computers.add(await linkOf(mac), { name: "studio" }), "the computer to be added");
  await until(() => first(computers)?.state === "online", "online");
  const id = added.id;
  const projectKey = `${id}|${mac.project}`;

  const opened = await within(call("computers:invoke", id, "project:open-at", [projectKey, { takeNotice: true }]), "project:open-at");
  assert.equal(opened.path, projectKey, "the Project's path names its computer");
  const recent = await within(call("computers:invoke", id, "project:recent", []), "project:recent");
  assert.ok(recent.some((project) => project.path === projectKey));
  const chatId = Object.values(opened.state.sessions)[0].id;

  await within(call("computers:invoke", id, "chat:patch", [projectKey, chatId, { title: "Named from the desk" }]), "chat:patch");
  const onMac = await within(mac.client.call("project:read", [mac.project]), "project:read on the Mac");
  assert.equal(onMac.state.sessions[chatId].title, "Named from the desk", "the patch reached the Mac with its own path");
  await until(
    () => forwarded.some(({ channel, payload }) => channel === "computers:event" && payload.computerId === id && payload.channel === "project:state" && payload.payload?.path === projectKey),
    "a state event naming the computer",
  );
  const page = await within(call("computers:invoke", id, "chat:messages", [projectKey, chatId, { turns: 20 }]), "chat:messages");
  assert.ok(Array.isArray(page.messages));
  await within(call("computers:remember", id, { kind: "chat", scope: projectKey, chatId, window: { messages: [{ id: 1, session_id: chatId, role: "user", body: "kept here" }], hasMore: false, total: 1 } }), "remember");

  // Away: not online is all the cache asks, so turning the computer off stands in for it going offline.
  await computers.setEnabled(false);
  assert.ok((await call("computers:invoke", id, "project:recent", [])).some((project) => project.path === projectKey));
  const kept = await call("computers:invoke", id, "project:switch", [projectKey]);
  assert.equal(kept.path, projectKey);
  assert.equal(kept.state.sessions[chatId].title, "Named from the desk");
  assert.deepEqual((await call("computers:invoke", id, "chat:messages", [projectKey, chatId, { turns: 20 }])).messages[0].body, "kept here");
  await assert.rejects(call("computers:invoke", id, "chat:patch", [projectKey, chatId, { title: "x" }]), { message: "studio is offline." });
  await call("computers:remove", id);
  await assert.rejects(fs.stat(path.join(dataDir, "computers", id)), { code: "ENOENT" });
});
```

If `startTestMac`'s returned object has no `client.call("project:read")` answer for an unopened Project, use `mac.client.call("project:open", [mac.project])` there instead; the previous test already does exactly that.

- [ ] **Step 2: Run it**

Run: `node --test --test-name-pattern "window's routing drives a real Mac" apps/desktop/electron/computers-e2e.test.cjs`
Expected: PASS. A failure here is a routing or cache bug, so fix the module, not the test.

- [ ] **Step 3: The whole file**

Run: `node --test apps/desktop/electron/computers-e2e.test.cjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx oxfmt apps/desktop/electron/computers-e2e.test.cjs
git add apps/desktop/electron/computers-e2e.test.cjs
git commit -m "test(desktop): a real Mac's Projects, chats and cache through the window's routing, end to end"
```

---

### Task 23: Phase B is green

**Files:** none new.

- [ ] **Step 1: The repository's checks**

Run: `npm run typecheck && npm run lint && npm test -- --unit`
Expected: PASS for all three.

- [ ] **Step 2: Every Electron check**

Run: `npm test -- --electron`
Expected: PASS for every check. Phase B touched routing under every screen.

- [ ] **Step 3: The phone, whose bundle has the changed shared modules**

Run: `npm run typecheck --workspace @milagre/mobile && npm run lint --workspace @milagre/mobile && npm test -- --unit --workspace mobile`
Expected: PASS.

- [ ] **Step 4: By hand, on two Macs**

With the second Mac added (Task 10's steps), open one of its chats from the merged list and send "hello". Quit Milagre on the second Mac.
Expected: the reply streams; its row reads the second Mac's name; quitting there turns its rows to "<name>, offline" within 30 s, and its chat shows the banner over the last copy with the composer off; reopening Milagre there brings the rows back without a reload of this window.

No commit: nothing changed.

---
## Phase C: remote folders and images (the spec's PR 5)

Phase C ends with Add project offering each online computer and a folder browser on it. Images and files in a remote chat show, and their menus copy and save them, through `media:read`.

### Task 24: `fs:list-dirs` on the daemon

A paired desktop's folder picker lists one folder's subfolders. For each it reports the name, whether it is a git checkout and its branch (read from `HEAD`, with no git process per folder), and whether it is already a Project (registry or recent list). Listing starts at the home folder and refuses any path outside it, checked lexically and again after realpath, so a symlink can't lead out. Hidden folders are left out, and a listing holds at most 500 entries. The home folder is a `startDaemon` option, so tests never list the real one.

**Files:**
- Create: `apps/daemon/src/remote-files.cjs`, `apps/daemon/src/remote-files.test.cjs`
- Modify: `apps/daemon/src/server.cjs` (`homeDir`, `FILE_METHODS`, `remote-files-v1`, the dispatch branch)
- Modify: `apps/daemon/src/connections.test.cjs`

**Interfaces:**
- Produces:
  - `listDirs(request: { path?: string } | undefined, { home: string, projectPaths: () => Promise<string[]> }): Promise<DirListing>`, where `DirListing = { path: string; home: string; parent: string | null; entries: Array<{ name: string; path: string; git: boolean; branch: string | null; project: boolean }> }`. It refuses with an error whose `code` is `"OUTSIDE_HOME"` and whose message is "Only folders in the home folder can be listed."
  - `startDaemon({ …, homeDir = os.homedir() })`. `daemon:status` advertises the capability `remote-files-v1` and the methods `fs:list-dirs` and `media:read` (the latter arrives in Task 25).

- [ ] **Step 1: Write the failing tests**

Create `apps/daemon/src/remote-files.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listDirs } = require("./remote-files.cjs");

/** A home folder: Code/billing (a checkout on main), Code/web (a Project), Code/tree (a worktree's .git file), notes, a hidden folder, links in and out. */
async function home(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-files-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(homeDir, "Code", "billing", ".git"), { recursive: true });
  await fs.writeFile(path.join(homeDir, "Code", "billing", ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.mkdir(path.join(homeDir, "Code", "web", ".git"), { recursive: true });
  await fs.writeFile(path.join(homeDir, "Code", "web", ".git", "HEAD"), "ref: refs/heads/feature/x\n");
  await fs.mkdir(path.join(homeDir, "Code", "tree"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".gitdirs", "tree"), { recursive: true });
  await fs.writeFile(path.join(homeDir, ".gitdirs", "tree", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  await fs.writeFile(path.join(homeDir, "Code", "tree", ".git"), "gitdir: ../../.gitdirs/tree\n");
  await fs.mkdir(path.join(homeDir, "notes"));
  await fs.mkdir(path.join(homeDir, ".hidden"));
  await fs.writeFile(path.join(homeDir, "readme.txt"), "not a folder");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(homeDir, "escape"));
  await fs.symlink(path.join(homeDir, "Code"), path.join(homeDir, "code-link"));
  return { homeDir, outside, options: { home: homeDir, projectPaths: async () => [path.join(homeDir, "Code", "web")] } };
}

test("the home folder lists its visible folders, a link inside it included and one leading out left out", async (t) => {
  const { homeDir, options } = await home(t);
  const listing = await listDirs(undefined, options);
  assert.equal(listing.path, homeDir);
  assert.equal(listing.home, homeDir);
  assert.equal(listing.parent, null);
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.path]),
    [
      ["Code", path.join(homeDir, "Code")],
      ["code-link", path.join(homeDir, "Code")],
      ["notes", path.join(homeDir, "notes")],
    ],
  );
});

test("a folder's checkouts say their branch and whether they are already a Project", async (t) => {
  const { homeDir, options } = await home(t);
  const listing = await listDirs({ path: path.join(homeDir, "Code") }, options);
  assert.equal(listing.parent, homeDir);
  assert.deepEqual(
    listing.entries.map(({ name, git, branch, project }) => [name, git, branch, project]),
    [
      ["billing", true, "main", false],
      ["tree", true, null, false],
      ["web", true, "feature/x", true],
    ],
  );
});

test("a path outside the home folder, up out of it, relative, or through a link leading out is refused", async (t) => {
  const { homeDir, outside, options } = await home(t);
  for (const asked of [outside, "/etc", path.join(homeDir, ".."), `${homeDir}/../outside`, "Code", path.join(homeDir, "escape"), 7])
    await assert.rejects(listDirs({ path: asked }, options), { code: "OUTSIDE_HOME", message: "Only folders in the home folder can be listed." }, String(asked));
});
```

Append to `apps/daemon/src/connections.test.cjs`:

```js
test("a paired desktop may list folders in the daemon's home folder, and only there", async (t) => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-home-")));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(homeDir, "Code"));
  const daemon = await daemonFixture(t, { homeDir });
  const desktop = virtualClient(daemon, { policy: peerPolicy });
  const status = (await desktop.call("daemon:status")).result;
  assert.ok(status.capabilities.includes("remote-files-v1"));
  assert.ok(status.methods.includes("fs:list-dirs"));
  const listing = (await desktop.call("fs:list-dirs", [{}])).result;
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["Code"]);
  assert.deepEqual((await desktop.call("fs:list-dirs", [{ path: "/etc" }])).error, { code: "OUTSIDE_HOME", message: "Only folders in the home folder can be listed." });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/daemon/src/remote-files.test.cjs && node --test --test-name-pattern "list folders" apps/daemon/src/connections.test.cjs`
Expected: FAIL (`Cannot find module './remote-files.cjs'`).

- [ ] **Step 3: `remote-files.cjs`**

Create `apps/daemon/src/remote-files.cjs`:

```js
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_ENTRIES = 500;
const outside = () => Object.assign(new Error("Only folders in the home folder can be listed."), { code: "OUTSIDE_HOME" });
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

/** Whether a folder is a git checkout and the branch its HEAD names, read from its files: no git process per folder. */
async function checkoutOf(folder) {
  const marker = path.join(folder, ".git");
  const stat = await fs.stat(marker).catch(() => null);
  if (!stat) return { git: false, branch: null };
  try {
    let gitDir = marker;
    // A worktree or submodule has a .git file pointing at its git folder.
    if (stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(marker, "utf8"))?.[1]?.trim();
      if (!pointer) return { git: true, branch: null };
      gitDir = path.resolve(folder, pointer);
    }
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    return { git: true, branch: /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null };
  } catch {
    return { git: true, branch: null };
  }
}

/**
 * One folder's subfolders, for a paired desktop's remote folder picker (spec "Remote-only helpers"): each one's name, real
 * path, whether it is a git checkout and its branch, and whether it is already a Project. Starts at `home`; a path
 * outside it is refused, checked as written and again after realpath, so a symlink can't lead out. Hidden folders and
 * files are left out; at most MAX_ENTRIES. `projectPaths()` gives the real paths of the Projects this Mac knows.
 * @param {{ path?: unknown } | undefined} request
 * @param {{ home: string; projectPaths: () => Promise<string[]> }} options
 */
async function listDirs(request, { home, projectPaths }) {
  const realHome = await fs.realpath(home);
  const asked = request?.path;
  if (asked !== undefined && asked !== null && (typeof asked !== "string" || !path.isAbsolute(asked))) throw outside();
  const lexical = typeof asked === "string" ? path.resolve(asked) : realHome;
  if (!inside(realHome, lexical) && !inside(path.resolve(home), lexical)) throw outside();
  const folder = await fs.realpath(lexical).catch(() => {
    throw Object.assign(new Error("That folder is no longer there."), { code: "ENOENT" });
  });
  if (!inside(realHome, folder)) throw outside();
  const projects = new Set(await projectPaths().catch(() => []));
  const entries = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    let real = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) {
      real = await fs.realpath(real).catch(() => "");
      if (!real || !inside(realHome, real) || !(await fs.stat(real).catch(() => null))?.isDirectory()) continue;
    } else if (!entry.isDirectory()) continue;
    entries.push({ name: entry.name, path: real, ...(await checkoutOf(real)), project: projects.has(real) });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { path: folder, home: realHome, parent: folder === realHome ? null : path.dirname(folder), entries };
}

module.exports = { listDirs };
```

- [ ] **Step 4: The daemon serves it**

In `apps/daemon/src/server.cjs`:

1. Add `const os = require("node:os");` and `const { listDirs } = require("./remote-files.cjs");` beside the other requires.
2. After `const PEER_METHODS = …;`, add:

```js
// The remote folder picker and a remote chat's images (spec "Remote-only helpers"); paired desktops may call both.
const REMOTE_FILES = "remote-files-v1";
const FILE_METHODS = Object.freeze(["fs:list-dirs", "media:read"]);
```

3. Add `homeDir = os.homedir(),` to `startDaemon`'s options (after `pushOptions = {},`).
4. In `daemon:status`, add `REMOTE_FILES,` after `DESKTOP_PEER,` in `capabilities`, and `...FILE_METHODS` to the `methods` spread.
5. Before the `else if (request.method === "daemon:snapshot")` branch, add:

```js
        else if (request.method === "fs:list-dirs")
          result = await listDirs(request.args[0], {
            home: homeDir,
            // The Projects this Mac knows, by real path, so the picker can say "Added".
            projectPaths: async () => {
              const [registry, recent] = await Promise.all([runtime.invoke("project:registry", []), runtime.invoke("project:recent", [])]);
              const paths = [...(Array.isArray(registry) ? registry : []), ...(Array.isArray(recent) ? recent : [])].map((project) => project.path);
              return Promise.all(paths.map((folder) => fs.realpath(folder).catch(() => folder)));
            },
          });
```

(`fs` in `server.cjs` is `node:fs/promises`.)

- [ ] **Step 5: Run the daemon's tests**

Run: `node --test apps/daemon/src/remote-files.test.cjs && npm test -- --unit --workspace daemon`
Expected: PASS. `media:read` is advertised before it exists; Task 25 adds it, and nothing calls it yet.

- [ ] **Step 6: Commit**

```bash
npx oxfmt apps/daemon/src/remote-files.cjs apps/daemon/src/remote-files.test.cjs apps/daemon/src/server.cjs apps/daemon/src/connections.test.cjs
git add apps/daemon/src/remote-files.cjs apps/daemon/src/remote-files.test.cjs apps/daemon/src/server.cjs apps/daemon/src/connections.test.cjs
git commit -m "feat(daemon): fs:list-dirs, a home-folder folder listing for paired desktops"
```

---

### Task 25: `media:read` on the daemon, with the phone's image rules

The spec says `media:read` follows "`attachment-preview.cjs` rules", but those govern 256 KiB text previews. The image bytes the daemon serves the phone go through `serveMedia` (`mobile-bridge.cjs:537-593`). Its rules move into `media-access.cjs` unchanged and both serve from there, so the phone and a paired desktop can never be served different files. An image must be one of these:
- in one of the scope's Worktrees, its `.milagre/images`, the phone's uploads, or the generated-image folders;
- or an image an assistant reply shared (`project:chat-image`).

It is checked after realpath, by extension and by content, and must be at most 15 MiB. `media:read` needs the scope as well as the path to find those roots, so its argument is `{ scope, path }` (see the report).

**Files:**
- Create: `apps/daemon/src/media-access.cjs`, `apps/daemon/src/media-access.test.cjs`
- Modify: `apps/daemon/src/mobile-bridge.cjs:286-325` (constants and helpers move out), `:536-593` (`serveMedia`)
- Modify: `apps/daemon/src/server.cjs` (the `media:read` branch)
- Modify: `apps/daemon/src/connections.test.cjs`

**Interfaces:**
- Produces:
  - `openMedia({ scope, requested }, { dataDir, scopeRoots(scope), chatImage(scope, requested), check?(scope, requested) }): Promise<{ handle: FileHandle; type: string; size: number }>`. It throws errors with `status` (400, 403, 404, 413, 415) and `code` (`BAD_REQUEST`, `NOT_SERVED`, `NOT_FOUND`, `TOO_LARGE`, `NOT_AN_IMAGE`).
  - `scopeRootsVia({ dataDir, call })(scope): Promise<string[]>`
  - `readMedia(request: { scope, path }, options): Promise<{ type: string; size: number; base64: string }>`
  - `MEDIA_TYPES`, `MAX_MEDIA`
- Consumes: `isLinkScopeKey`, `scopeFromKey` (`@milagre/shared/chat-scopes`).

- [ ] **Step 1: Write the failing tests**

Create `apps/daemon/src/media-access.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readMedia, MAX_MEDIA } = require("./media-access.cjs");

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

async function scope(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "media-access-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const dataDir = path.join(root, "data");
  await fs.mkdir(path.join(project, ".milagre", "images"), { recursive: true });
  await fs.mkdir(path.join(root, "home", ".ssh"), { recursive: true });
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(project, ".milagre", "images", "shot.png"), PNG);
  await fs.writeFile(path.join(project, "fake.png"), "not an image at all");
  await fs.writeFile(path.join(root, "home", ".ssh", "id_rsa.png"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  await fs.writeFile(path.join(root, "shared.png"), PNG);
  await fs.symlink(path.join(root, "home", ".ssh", "id_rsa.png"), path.join(project, "link.png"));
  const big = await fs.open(path.join(project, "big.png"), "w");
  await big.write(PNG, 0, PNG.length, 0);
  await big.truncate(MAX_MEDIA + 1);
  await big.close();
  const options = {
    dataDir,
    scopeRoots: async () => [project],
    // As project:chat-image: an image a reply shared is copied into .milagre/images and that copy is served.
    chatImage: async (_scope, requested) => (requested === path.join(root, "shared.png") ? path.join(project, ".milagre", "images", "shot.png") : null),
  };
  return { root, project, options };
}

test("an image a scope's chat shows is read with its type, by the phone's rules", async (t) => {
  const { project, root, options } = await scope(t);
  const read = await readMedia({ scope: project, path: path.join(project, ".milagre", "images", "shot.png") }, options);
  assert.deepEqual({ type: read.type, size: read.size }, { type: "image/png", size: PNG.length });
  assert.deepEqual(Buffer.from(read.base64, "base64"), PNG);
  assert.equal((await readMedia({ scope: project, path: path.join(root, "shared.png") }, options)).type, "image/png", "an image a reply shared");
});

test("anything the phone can't get is refused, and no bytes leave", async (t) => {
  const { project, root, options } = await scope(t);
  const refused = async (request, code) => assert.rejects(readMedia(request, options), { code }, JSON.stringify(request));
  await refused({ scope: project, path: path.join(root, "home", ".ssh", "id_rsa.png") }, "NOT_SERVED");
  await refused({ scope: project, path: path.join(project, "link.png") }, "NOT_SERVED");
  await refused({ scope: project, path: path.join(project, "fake.png") }, "NOT_AN_IMAGE");
  await refused({ scope: project, path: path.join(project, "notes.txt") }, "NOT_AN_IMAGE");
  await refused({ scope: project, path: path.join(project, "big.png") }, "TOO_LARGE");
  await refused({ scope: project, path: path.join(project, ".milagre", "images", "gone.png") }, "NOT_FOUND");
  await refused({ scope: project, path: "shot.png" }, "BAD_REQUEST");
  await refused({ scope: "relative", path: path.join(project, "x.png") }, "BAD_REQUEST");
});
```

Append to `apps/daemon/src/connections.test.cjs`:

```js
test("a paired desktop may call media:read, which refuses a file outside the scope's roots", async (t) => {
  const daemon = await daemonFixture(t);
  const desktop = virtualClient(daemon, { policy: peerPolicy });
  assert.ok((await desktop.call("daemon:status")).result.methods.includes("media:read"));
  const reply = await desktop.call("media:read", [{ scope: "/nowhere", path: "/etc/hosts.png" }]);
  assert.equal(reply.error?.code, "NOT_SERVED");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test apps/daemon/src/media-access.test.cjs`
Expected: FAIL (`Cannot find module './media-access.cjs'`).

- [ ] **Step 3: `media-access.cjs`**

Create `apps/daemon/src/media-access.cjs`:

```js
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");

const MAX_MEDIA = 15 * 1024 * 1024;
const MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heic",
};
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const CODES = { 400: "BAD_REQUEST", 403: "NOT_SERVED", 404: "NOT_FOUND", 413: "TOO_LARGE", 415: "NOT_AN_IMAGE" };
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const failure = (status, message) => Object.assign(new Error(message), { status, code: CODES[status] });
const validScope = (owner) => typeof owner === "string" && (isLinkScopeKey(owner) || path.isAbsolute(owner));
const realOrNull = async (file) => {
  try {
    return await fs.realpath(file);
  } catch {
    return null;
  }
};
// Decide by content too, so a renamed non-image never leaves the Mac as an image.
function sniffsAs(type, head) {
  if (type === "image/png") return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return head[0] === 255 && head[1] === 216 && head[2] === 255;
  if (type === "image/gif") return /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"));
  if (type === "image/webp") return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
  return head.subarray(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.has(head.subarray(8, 12).toString("latin1"));
}

/** A scope's Worktree folders, through any daemon call (`call(method, args)`): a Project's, or a Link's members'. */
const scopeRootsVia =
  ({ dataDir, call }) =>
  async (scope) => {
    if (!isLinkScopeKey(scope)) return call("project:worktree-paths", [scope]);
    const link = await call("link:snapshot", [scopeFromKey(scope).linkId]);
    return [
      path.join(dataDir, "links", link.link.id, ".milagre", "images"),
      ...Object.values(link.state.sessions).flatMap((chat) => [chat.workspacePath, ...chat.worktrees.map((member) => member.worktreePath)]),
    ];
  };

/**
 * An image a scope's chat shows, opened for reading, under the rules the phone's /media always had (moved here from
 * mobile-bridge.cjs so the phone and a paired desktop are served the same files): the scope's Worktrees, its persisted
 * attachments (<Project>/.milagre/images), files uploaded from the phone, the folders agents save generated images in,
 * or an image an assistant reply shared (`chatImage`, project:chat-image). Checked after realpath, so a symlink can't
 * lead out, by extension and by content; at most MAX_MEDIA. `check(scope, requested)` runs first (the phone's
 * confinement). The caller closes the returned handle.
 */
async function openMedia({ scope, requested }, { dataDir, scopeRoots, chatImage, check }) {
  if (!validScope(scope) || typeof requested !== "string" || !path.isAbsolute(requested)) throw failure(400, "Choose a valid Project or Link and absolute image path");
  await check?.(scope, requested);
  const type = MEDIA_TYPES[path.extname(requested).toLowerCase()];
  if (!type) throw failure(415, "Only png, jpeg, gif, webp and heic images are served");
  // Only the worktree folders: a big Project's whole state would be read in pages for every image.
  const worktreePaths = await scopeRoots(scope).catch(() => []);
  const candidates = [
    ...(Array.isArray(worktreePaths) ? worktreePaths : []),
    ...(isLinkScopeKey(scope) ? [] : [path.join(scope, ".milagre", "images")]),
    path.join(dataDir, "mobile-attachments"),
    path.join(os.tmpdir(), "milagre-generated-images"),
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "generated_images"),
  ].filter((candidate) => typeof candidate === "string" && path.isAbsolute(candidate));
  const roots = (await Promise.all(candidates.map(realOrNull))).filter(Boolean);
  let real = await realOrNull(requested);
  if (!real || !roots.some((root) => inside(root, real))) {
    // A screenshot in /tmp must be explicitly shared in this scope's assistant reply.
    // The runtime validates that reference and returns a durable Project attachment, never arbitrary bytes.
    const stored = await Promise.resolve(chatImage(scope, requested)).catch(() => null);
    if (stored) real = await realOrNull(stored);
  }
  if (!real) {
    // Missing files are only reported as missing inside an allowed folder, so paths elsewhere are not probed.
    const lexical = path.resolve(requested);
    throw roots.some((root) => inside(root, lexical)) || candidates.some((root) => inside(path.resolve(root), lexical))
      ? failure(404, "Image not found")
      : failure(403, "This file is not available to the mobile app");
  }
  if (!roots.some((root) => inside(root, real))) throw failure(403, "This file is not available to the mobile app");
  if (MEDIA_TYPES[path.extname(real).toLowerCase()] !== type) throw failure(415, "Only png, jpeg, gif, webp and heic images are served");
  const handle = await fs.open(real, "r").catch((error) => {
    throw failure(error.code === "ENOENT" ? 404 : 403, error.code === "ENOENT" ? "Image not found" : "This file is not available to the mobile app");
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw failure(403, "This file is not available to the mobile app");
    if (info.size > MAX_MEDIA) throw failure(413, "Images must be 15 MiB or smaller");
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, 12, 0);
    if (!sniffsAs(type, head.subarray(0, bytesRead))) throw failure(415, "The file is not a supported image");
    return { handle, type, size: info.size };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** media:read for a paired desktop: the same image, whole, as base64 (a large one travels in result pages). */
async function readMedia(request, options) {
  const { handle, type, size } = await openMedia({ scope: request?.scope, requested: request?.path }, options);
  try {
    const bytes = Buffer.alloc(size);
    await handle.read(bytes, 0, size, 0);
    return { type, size, base64: bytes.toString("base64") };
  } finally {
    await handle.close().catch(() => {});
  }
}

module.exports = { MAX_MEDIA, MEDIA_TYPES, openMedia, readMedia, scopeRootsVia, sniffsAs };
```

The candidates list adds `<scope>/.milagre/images` only for a Project, which matches what `serveMedia` produced: for a Link it joined the `milagre-link:` key as if it were a path, which can never exist.

- [ ] **Step 4: The phone's `/media` serves through it**

In `apps/daemon/src/mobile-bridge.cjs`, delete `MAX_MEDIA`, `MEDIA_TYPES`, `HEIC_BRANDS` and `sniffsAs` (`:286-305`), add `const { MEDIA_TYPES, openMedia } = require("./media-access.cjs");`, and replace `serveMedia` with:

```js
  // Images the paired app may show: the rules live in media-access.cjs, shared with media:read for paired desktops.
  async function serveMedia(target, res) {
    const projectPath = target.searchParams.get("projectPath");
    const requested = target.searchParams.get("path");
    const { handle, type, size } = await openMedia(
      { scope: projectPath, requested },
      {
        dataDir,
        scopeRoots,
        chatImage: (scope, file) => client.call("project:chat-image", [scope, file]),
        check: confine
          ? async (scope, file) => {
              await confine.check(scope);
              await confine.check(file, { uploads: true });
            }
          : undefined,
      },
    );
    try {
      res.writeHead(200, { "content-type": type, "content-length": size, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
      // Bounded by the size checked above, so a file that grows afterwards cannot exceed Content-Length.
      await pipeline(handle.createReadStream({ start: 0, end: Math.max(size - 1, 0), autoClose: true }), res);
    } catch (error) {
      await handle.close().catch(() => {});
      if (res.headersSent) {
        res.destroy();
        return;
      }
      throw error;
    }
  }
```

If nothing else in the file uses `MEDIA_TYPES`, drop it from the import; if `inside` or `realOrNull` are still used elsewhere in the file, keep them.

In `apps/daemon/src/server.cjs`, add `const { readMedia, scopeRootsVia } = require("./media-access.cjs");` and, after the `fs:list-dirs` branch:

```js
        else if (request.method === "media:read")
          result = await readMedia(request.args[0], {
            dataDir,
            scopeRoots: scopeRootsVia({ dataDir, call: (method, args) => runtime.invoke(method, args) }),
            chatImage: (scope, file) => runtime.invoke("project:chat-image", [scope, file]),
          });
```

- [ ] **Step 5: Run the daemon's tests, the phone's media tests included**

Run: `node --test apps/daemon/src/media-access.test.cjs && node --test apps/daemon/src/mobile-bridge.test.cjs && npm test -- --unit --workspace daemon`
Expected: PASS. `mobile-bridge.test.cjs` pins that the phone is served exactly as before.

- [ ] **Step 6: Commit**

```bash
npx oxfmt apps/daemon/src/media-access.cjs apps/daemon/src/media-access.test.cjs apps/daemon/src/mobile-bridge.cjs apps/daemon/src/server.cjs apps/daemon/src/connections.test.cjs
git add apps/daemon/src/media-access.cjs apps/daemon/src/media-access.test.cjs apps/daemon/src/mobile-bridge.cjs apps/daemon/src/server.cjs apps/daemon/src/connections.test.cjs
git commit -m "feat(daemon): media:read serves a paired desktop the images the phone gets, by the same rules"
```

---

### Task 26: A remote chat's images and their menus

In a remote chat, `milagre-media://` would read this Mac's disk at the other Mac's path. Images and files there instead read through `media:read`, and show as data URLs once their bytes arrive. Copy Image, Save Image… and the right-click menu work on those bytes; this Mac's `image:*` handlers already take data URLs (`electron.d.ts` "its absolute path, or a pasted image's data URL"). Videos and other files on another Mac aren't served (`media:read` serves images only), so they show as file chips with no preview. This Mac's chats keep `milagre-media://`.

**Files:**
- Modify: `apps/desktop/electron/preload.cjs` (`readMedia`, `listDirs`, `openProjectAt` in `makeBridge`), `apps/desktop/electron/main.cjs` (`project:open-at`), `apps/desktop/app/src/electron.d.ts` (`MediaBytes`, `DirListing`, the three members)
- Modify: `apps/desktop/app/src/lib/computer-bridge.ts` (`ScopeContext`, `useScope`)
- Create: `apps/desktop/app/src/lib/remote-media.ts`, `apps/desktop/app/src/lib/remote-media.test.ts`
- Modify: `apps/desktop/app/src/components/Attachments.tsx`, `apps/desktop/app/src/components/agents/GeneratedImage.tsx`, `apps/desktop/app/src/App.tsx` and `apps/desktop/app/src/components/LinkWorkspace.tsx` (provide the scope)

**Interfaces:**
- Produces:
  - `MilagreBridge.readMedia(request: { scope: string; path: string }): Promise<MediaBytes>`, where `MediaBytes = { type: string; size: number; base64: string }`
  - `MilagreBridge.listDirs(request: { path?: string }): Promise<DirListing>`
  - `MilagreBridge.openProjectAt(folder: string): Promise<OpenProject>`
  - `ScopeContext`, `useScope(): string | null`
  - `remoteImageDataUrl(scope: string, path: string): Promise<string>`
  - `useRemoteMedia(scope: string | null, paths: string[]): Record<string, string>`, which maps each path to a data URL once read

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/app/src/lib/remote-media.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const reads: unknown[] = [];
(globalThis as any).window = {
  milagre: {
    on: () => ({
      readMedia: async (request: { scope: string; path: string }) => {
        reads.push(request);
        if (request.path.endsWith("gone.png")) throw new Error("Image not found");
        return { type: "image/png", size: 3, base64: "AAEC" };
      },
    }),
  },
};
const { remoteImageDataUrl } = await import("./remote-media.ts");

test("a remote image is read once from its computer, as a data URL; a failed read is tried again next time", async () => {
  const scope = `${ID}|/p`;
  assert.equal(await remoteImageDataUrl(scope, "/p/a.png"), "data:image/png;base64,AAEC");
  assert.equal(await remoteImageDataUrl(scope, "/p/a.png"), "data:image/png;base64,AAEC");
  assert.deepEqual(reads, [{ scope, path: "/p/a.png" }]);
  await assert.rejects(remoteImageDataUrl(scope, "/p/gone.png"));
  await assert.rejects(remoteImageDataUrl(scope, "/p/gone.png"));
  assert.equal(reads.length, 3, "a failure isn't kept");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/desktop/app/src/lib/remote-media.test.ts`
Expected: FAIL (`Cannot find module './remote-media.ts'`).

- [ ] **Step 3: The bridge's new calls**

In `apps/desktop/electron/preload.cjs`'s `makeBridge`, after `openProject: () => invoke("project:open"),`, add:

```js
    /** A folder on this computer, opened as a Project without the folder dialog (the remote folder picker). */
    openProjectAt: (folder) => invoke("project:open-at", folder, { takeNotice: true }),
    listDirs: (request) => invoke("fs:list-dirs", request),
    readMedia: (request) => invoke("media:read", request),
```

In `apps/desktop/electron/main.cjs`, after the `project:open` handler, add:

```js
  // This Mac's side of openProjectAt; a paired computer's goes through computers:invoke as project:open.
  ipcMain.handle("project:open-at", (_event, folder) => runtime.openProject(String(folder)));
```

In `apps/desktop/app/src/electron.d.ts`, add:

```ts
/** One folder of a computer's home folder, for the remote folder picker (fs:list-dirs). */
export type DirListing = {
  path: string;
  home: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; git: boolean; branch: string | null; project: boolean }>;
};
/** An image a chat shows, read from its computer (media:read). */
export type MediaBytes = { type: string; size: number; base64: string };
```

and in `MilagreBridge`, after `openProject`:

```ts
      /** Opens a folder of this computer as a Project, without the dialog. */
      openProjectAt: (folder: string) => Promise<OpenProject>;
      listDirs: (request: { path?: string }) => Promise<DirListing>;
      readMedia: (request: { scope: string; path: string }) => Promise<MediaBytes>;
```

- [ ] **Step 4: The scope on screen, and remote media**

In `apps/desktop/app/src/lib/computer-bridge.ts`, add:

```ts
/** The scope key of the Project or Link on screen, which App and LinkWorkspace provide. */
export const ScopeContext = createContext<string | null>(null);
export const useScope = () => useContext(ScopeContext);
```

Create `apps/desktop/app/src/lib/remote-media.ts`:

```ts
import { useEffect, useState } from "react";
import { bridgeForKey, isRemoteKey } from "./computer-bridge.ts";

// Images of a remote chat, read through media:read and kept as data URLs while recent: thumbnails, the lightbox and
// the image menus show the same bytes. A read that fails isn't kept, so the next look tries again.
const KEPT = 64;
const reads = new Map<string, Promise<string>>();

export function remoteImageDataUrl(scope: string, path: string): Promise<string> {
  const key = `${scope}\n${path}`;
  const known = reads.get(key);
  if (known) {
    reads.delete(key);
    reads.set(key, known);
    return known;
  }
  const read = bridgeForKey(scope)
    .readMedia({ scope, path })
    .then((media) => `data:${media.type};base64,${media.base64}`);
  reads.set(key, read);
  read.catch(() => {
    if (reads.get(key) === read) reads.delete(key);
  });
  while (reads.size > KEPT) reads.delete(reads.keys().next().value!);
  return read;
}

/** Each path's data URL once read, for a remote scope; nothing for this Mac's, whose chats use milagre-media://. */
export function useRemoteMedia(scope: string | null, paths: string[]): Record<string, string> {
  const [sources, setSources] = useState<Record<string, string>>({});
  const joined = paths.join("\n");
  useEffect(() => {
    if (!scope || !isRemoteKey(scope)) return;
    let live = true;
    for (const path of joined.split("\n").filter(Boolean))
      void remoteImageDataUrl(scope, path).then(
        (src) => {
          if (live) setSources((previous) => (previous[path] === src ? previous : { ...previous, [path]: src }));
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [scope, joined]);
  return sources;
}
```

In `App.tsx`, inside the `BridgeContext.Provider` from Task 16, add `<ScopeContext.Provider value={project.path}>` around the same children. In `LinkWorkspace.tsx`, add `<ScopeContext.Provider value={owner}>` inside its `BridgeContext.Provider`.

- [ ] **Step 5: Attachments and generated images**

In `apps/desktop/app/src/components/Attachments.tsx`, import `useScope`, `isRemoteKey` and `useRemoteMedia`, and before `const items = [`, add:

```tsx
  // A remote chat's images come from its computer; its other files have no preview here.
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const remoteSources = useRemoteMedia(remote ? scope : null, [
    ...images.flatMap((image) => (image.dataUrl || !image.path ? [] : [image.path])),
    ...files.filter((path) => mediaKind(path) === "image"),
  ]);
  const sourceOf = (path: string) => (remote ? (remoteSources[path] ?? "") : mediaUrl(path));
```

In the two item builders, replace `mediaUrl(image.path ?? "")` with `sourceOf(image.path ?? "")`. Replace `src: mediaUrl(path),` with `src: sourceOf(path),`, `kind: mediaKind(path),` with `kind: remote && mediaKind(path) !== "image" ? null : mediaKind(path),`, and `file: mediaKind(path) === "image" ? path : undefined,` with `file: mediaKind(path) !== "image" ? undefined : remote ? remoteSources[path] : path,`. For images, set `file: remote && image.path ? remoteSources[image.path] : (image.path ?? image.dataUrl),`. The menus and the lightbox then act on the data URL. Until it arrives, `file` is undefined and there is no menu.

In `apps/desktop/app/src/components/agents/GeneratedImage.tsx`, import `useScope`, `isRemoteKey` and `useRemoteMedia`, and replace `const src = step.file && !broken ? mediaUrl(step.file) : null;` with:

```tsx
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const remoteSources = useRemoteMedia(remote && step.file ? scope : null, step.file ? [step.file] : []);
  // On another Mac the image comes through media:read; copy, save and the menu then act on its bytes.
  const file = step.file ? (remote ? remoteSources[step.file] : step.file) : undefined;
  const src = file && !broken ? (remote ? file : mediaUrl(file)) : null;
```

and use `file` in place of `step.file` in its copy, save and `showImageMenu` calls, guarding each with `if (!file) return;`.

- [ ] **Step 6: Run the tests and the image checks**

Run: `node --test apps/desktop/app/src/lib/remote-media.test.ts && npm test -- --unit --workspace desktop && npm run typecheck`
Expected: PASS.

Run: `npm test -- --only test-chat-attachments && npm test -- --only test-image-generation && npm test -- --only test-artifacts`
Expected: PASS. This Mac's chats still use `milagre-media://`.

- [ ] **Step 7: Commit**

```bash
npx oxfmt apps/desktop/electron/preload.cjs apps/desktop/electron/main.cjs apps/desktop/app/src/electron.d.ts apps/desktop/app/src/lib/computer-bridge.ts apps/desktop/app/src/lib/remote-media.ts apps/desktop/app/src/lib/remote-media.test.ts apps/desktop/app/src/components/Attachments.tsx apps/desktop/app/src/components/agents/GeneratedImage.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/components/LinkWorkspace.tsx
git add apps/desktop/electron/preload.cjs apps/desktop/electron/main.cjs apps/desktop/app/src/electron.d.ts apps/desktop/app/src/lib/computer-bridge.ts apps/desktop/app/src/lib/remote-media.ts apps/desktop/app/src/lib/remote-media.test.ts apps/desktop/app/src/components/Attachments.tsx apps/desktop/app/src/components/agents/GeneratedImage.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/components/LinkWorkspace.tsx
git commit -m "feat(desktop): a remote chat's images read through media:read, with their menus"
```

---

### Task 27: Add project on another computer

Design `add-project-remote` v1. With at least one computer, Add project (the footer button, ⌘O, ⌘K "Add project…", the startup error's "Open another project") asks for the computer first. The choices are This Mac and each computer, with offline ones disabled. For This Mac, "Choose folder…" runs the native folder dialog as before. For another computer, a folder browser lists its home folder through `fs:list-dirs`, with a `~ / Code /` breadcrumb. Each folder is tagged "Added" or "git · main", and opening a folder goes into it. "Add billing-service" opens the selected checkout there with `openProjectAt`. With only this Mac, Add project is the folder dialog, as now.

**Files:**
- Create: `apps/desktop/app/src/components/AddProjectDialog.tsx`
- Modify: `apps/desktop/app/src/App.tsx` (`openProject`, the dialog beside `{linkDialog}`)
- Modify: `apps/desktop/app/src/lib/routed-bridge.test.ts` (allow `components/AddProjectDialog.tsx`: `openProject`)
- Create: `scripts/test-add-project-remote.cjs`

**Interfaces:**
- Consumes: `useComputers`, `routeLine`, `computerTone`, `DOT_COLOR` (Task 6); `bridgeFor` (Task 13); `MilagreBridge.listDirs`, `openProjectAt` (Task 26).
- Produces: `AddProjectDialog({ onClose: () => void; onOpened: (project: OpenProject) => void })`, with markers `dialog[data-add-project]`, `[data-add-project-on="this-mac"|<id>]`, `[data-folder-path]`, `[data-folder=<name>]` and `[data-folder-tag]`.

- [ ] **Step 1: Write the check**

Create `scripts/test-add-project-remote.cjs`. Take `main()`, the `browserChecks` scaffolding and the closing lines from `scripts/test-add-computer.cjs`, with the names `add-project-remote` and `.vite-add-project-remote`, and this fixture:

```js
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AddProjectDialog } from "/src/components/AddProjectDialog";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const HOME = "/Users/a";
const listings = {
  [HOME]: { path: HOME, home: HOME, parent: null, entries: [{ name: "Code", path: HOME + "/Code", git: false, branch: null, project: false }, { name: "notes", path: HOME + "/notes", git: false, branch: null, project: false }] },
  [HOME + "/Code"]: { path: HOME + "/Code", home: HOME, parent: HOME, entries: [
    { name: "atlas-web", path: HOME + "/Code/atlas-web", git: true, branch: "main", project: true },
    { name: "billing-service", path: HOME + "/Code/billing-service", git: true, branch: "main", project: false },
    { name: "scratch", path: HOME + "/Code/scratch", git: false, branch: null, project: false },
  ] },
};
window.listed = [];
window.opened = [];
window.localDialogs = 0;
const atlas = { listDirs: async ({ path } = {}) => (window.listed.push(path ?? null), listings[path ?? HOME]), openProjectAt: async (folder) => (window.opened.push(folder), { path: "c-atlas|" + folder, name: folder.split("/").pop(), state: {} }) };
window.milagre = {
  openProject: async () => (window.localDialogs++, null),
  on: (id) => (id === "c-atlas" ? atlas : {}),
  onComputersChanged: () => () => {},
  computers: { list: async () => ({ thisMac: "victor-mbp", computers: [
    { id: "c-atlas", name: "atlas", hostId: "a".repeat(22), relayHost: "relay.milagre.cloud", state: "online", route: "lan", lastSeen: Date.now(), addedAt: 1, message: null, lan: true, lanRoutes: [] },
    { id: "c-studio", name: "studio", hostId: "s".repeat(22), relayHost: "relay.milagre.cloud", state: "offline", route: null, lastSeen: Date.now() - 7200000, addedAt: 1, message: null, lan: false, lanRoutes: [] },
  ] }) },
};
updateSettings({ otherComputers: true });
function Fixture() {
  const [open, setOpen] = useState(true);
  return open ? <AddProjectDialog onClose={() => setOpen(false)} onOpened={(project) => { window.added = project.path; setOpen(false); }} /> : <output data-closed />;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;
```

Inside `browserChecks`'s `try`, after `await window.loadURL(process.argv[2]);`:

```js
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
    const on = (id) => `document.querySelector('[data-add-project-on="${id}"]')`;
    await waitFor(`document.querySelector('dialog[data-add-project]')?.open && !!${on("c-studio")}`);
    assert.equal(await evaluate(`${on("c-studio")}.disabled`), true, "an offline computer can't be chosen");
    assert.match(await text('[data-add-project-on="c-atlas"]'), /atlas\s*Same network/);
    assert.match(await text('[data-add-project-on="this-mac"]'), /victor-mbp\s*This Mac/);
    await evaluate(`${on("this-mac")}.click()`);
    await evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Choose folder…').click()`);
    await waitFor(`window.localDialogs === 1`);
    console.log("PASS: This Mac's choice runs the folder dialog, and an offline computer is disabled");

    await evaluate(`${on("c-atlas")}.click()`);
    await waitFor(`!!document.querySelector('[data-folder="Code"]')`);
    assert.equal(await text("[data-folder-path]"), "~ /");
    await evaluate(`document.querySelector('[data-folder="Code"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(`!!document.querySelector('[data-folder="billing-service"]')`);
    assert.equal(await text("[data-folder-path]"), "~ / Code /");
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll('[data-folder]')].map((row) => [row.dataset.folder, row.querySelector('[data-folder-tag]')?.textContent.trim() ?? ""])`),
      [["atlas-web", "Added"], ["billing-service", "git · main"], ["scratch", ""]],
    );
    assert.match(await text("dialog[data-add-project]"), /Opens on atlas\. Its daemon owns the Project; this window drives it\./);
    await evaluate(`document.querySelector('[data-folder="billing-service"]').click()`);
    await waitFor(`[...document.querySelectorAll('dialog button')].some((b) => b.textContent.trim() === 'Add billing-service' && !b.disabled)`);
    await screenshot("add-project-remote");
    await evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Add billing-service').click()`);
    await waitFor(`window.added === 'c-atlas|/Users/a/Code/billing-service' && !!document.querySelector('[data-closed]')`);
    assert.deepEqual(await evaluate(`window.opened`), ["/Users/a/Code/billing-service"]);
    assert.deepEqual(errors, []);
    console.log("PASS: another computer's folders are browsed there, tagged, and the chosen checkout opens on it");
    app.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only test-add-project-remote`
Expected: FAIL (`/src/components/AddProjectDialog` does not exist).

- [ ] **Step 3: The dialog**

Create `apps/desktop/app/src/components/AddProjectDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { DirListing } from "../electron";
import type { OpenProject } from "../model";
import { bridgeFor } from "../lib/computer-bridge";
import { DOT_COLOR, computerTone, routeLine, useComputers } from "../lib/computers";
import { ScrollArea } from "./primitives/ScrollArea";

const THIS_MAC = "this-mac";

/**
 * Add project with other computers (design add-project-remote v1): choose the computer (offline ones disabled), then a
 * folder on it. This Mac keeps its folder dialog; another computer's home folder is browsed through fs:list-dirs and the
 * checkout opens there, whose daemon owns it. Mounted only while open.
 */
export function AddProjectDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (project: OpenProject) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { thisMac, computers } = useComputers();
  const [on, setOn] = useState<string>(THIS_MAC);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [selected, setSelected] = useState<DirListing["entries"][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reads = useRef(0);
  const computer = computers.find((item) => item.id === on);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const browse = (path?: string) => {
    if (!computer) return;
    const read = ++reads.current;
    setSelected(null);
    setError(null);
    bridgeFor(computer.id)
      .listDirs(path ? { path } : {})
      .then(
        (next) => {
          if (read === reads.current) setListing(next);
        },
        (cause) => {
          if (read === reads.current) setError(ipcErrorMessage(cause));
        },
      );
  };
  useEffect(() => {
    setListing(null);
    if (on !== THIS_MAC) browse();
  }, [on]);

  async function chooseHere() {
    setError(null);
    try {
      const opened = await window.milagre.openProject();
      if (opened) onOpened(opened);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  }
  async function add() {
    if (!computer || !selected) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(await bridgeFor(computer.id).openProjectAt(selected.path));
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const crumbs = listing ? ["~", ...listing.path.slice(listing.home.length).split("/").filter(Boolean)] : [];
  const now = Date.now();

  return createPortal(
    <dialog
      ref={dialog}
      data-add-project
      aria-labelledby="add-project-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[520px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] bg-surface p-5 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <h2 id="add-project-title" className="text-[16px] font-semibold">
        Add project
      </h2>
      <p className="mt-3.5 text-[12px] text-ink-3">On</p>
      <div className="mt-1.5 flex gap-1.5">
        {[{ id: THIS_MAC, name: thisMac, line: "This Mac", tone: "online" as const, away: false }, ...computers.map((item) => ({ id: item.id, name: item.name, line: routeLine(item, now), tone: computerTone(item), away: item.state !== "online" }))].map(
          (choice) => (
            <button
              key={choice.id}
              type="button"
              data-add-project-on={choice.id}
              aria-pressed={on === choice.id}
              disabled={choice.away}
              onClick={() => setOn(choice.id)}
              className={`flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-3 text-left ring-1 disabled:opacity-45 ${on === choice.id ? "bg-accent/15 ring-[1.5px] ring-accent" : "ring-line-strong hover:bg-hover"}`}
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: DOT_COLOR[choice.tone] }} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{choice.name}</span>
                <span className="block truncate text-[11.5px] text-ink-3">{choice.line}</span>
              </span>
            </button>
          ),
        )}
      </div>
      {on === THIS_MAC ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[13px] text-ink-2">Choose a folder on this Mac.</p>
          <button type="button" onClick={() => void chooseHere()} className="rounded-control px-3 py-2 text-[13px] ring-1 ring-line-strong hover:bg-hover-2">
            Choose folder…
          </button>
        </div>
      ) : (
        <>
          <p className="mt-4 text-[12px] text-ink-3">Folder on {computer?.name}</p>
          <div data-folder-path className="mt-1.5 flex h-[34px] items-center gap-1 rounded-[9px] bg-field px-2.5 text-[12.5px] text-ink-2 ring-1 ring-line-strong">
            {crumbs.map((crumb, index) => (index === crumbs.length - 1 && index > 0 ? <b key={index} className="font-medium text-ink">{`${crumb} /`}</b> : <span key={index}>{`${crumb} /`}</span>))}
          </div>
          <ScrollArea className="mt-2 h-[250px] rounded-[10px] ring-1 ring-line">
            {listing?.parent && (
              <button type="button" onClick={() => browse(listing.parent!)} className="flex h-[34px] w-full items-center gap-2.5 border-b border-line px-3 text-left text-[13px] text-ink-2 hover:bg-hover">
                ..
              </button>
            )}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                data-folder={entry.name}
                aria-pressed={selected?.path === entry.path}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => browse(entry.path)}
                className={`flex h-[34px] w-full items-center gap-2.5 border-b border-line px-3 text-left text-[13px] last:border-b-0 ${selected?.path === entry.path ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover"}`}
              >
                <HugeiconsIcon icon={FolderOpenIcon} size={15} strokeWidth={1.8} color="currentColor" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {(entry.project || entry.git) && (
                  <span data-folder-tag className="shrink-0 text-[11px] text-ink-3">
                    {entry.project ? "Added" : `git · ${entry.branch ?? "detached"}`}
                  </span>
                )}
              </button>
            ))}
          </ScrollArea>
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red">
          {error}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[12px] text-ink-3">{computer ? `Opens on ${computer.name}. Its daemon owns the Project; this window drives it.` : ""}</span>
        <span className="flex shrink-0 gap-2">
          <button type="button" onClick={onClose} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
            Cancel
          </button>
          {computer && (
            <button
              type="button"
              disabled={!selected || !selected.git || selected.project || busy}
              onClick={() => void add()}
              className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40"
            >
              {selected ? `Add ${selected.name}` : "Add project"}
            </button>
          )}
        </span>
      </div>
    </dialog>,
    document.body,
  );
}
```

`bg-accent/15` and `ring-accent` are the accent tokens the composer already uses. If `bg-accent/15` doesn't resolve in this Tailwind setup, use `style={{ background: "var(--accent-tint)" }}` instead.

- [ ] **Step 4: App asks for the computer first when there is one**

In `apps/desktop/app/src/App.tsx`, import `AddProjectDialog`, add `const [addProjectOpen, setAddProjectOpen] = useState(false);` beside `addComputerOpen`, and replace:

```tsx
  const openProject = () => replaceProject(() => window.milagre.openProject());
```

with:

```tsx
  // With other computers, Add project asks which computer first (spec "Renderer"); with this Mac alone, the folder dialog.
  const openProject = () => (pairedComputers.length > 0 ? Promise.resolve(setAddProjectOpen(true)) : replaceProject(() => window.milagre.openProject()));
```

After `const addComputerDialog = …;`, add:

```tsx
  const addProjectDialog = addProjectOpen ? (
    <AddProjectDialog
      onClose={() => setAddProjectOpen(false)}
      onOpened={(opened) => {
        setAddProjectOpen(false);
        void replaceProject(async () => opened);
      }}
    />
  ) : null;
```

and add `{addProjectDialog}` after each `{addComputerDialog}`. In `lib/routed-bridge.test.ts`, add `"components/AddProjectDialog.tsx": ["openProject"],` to `ALLOWED`.

- [ ] **Step 5: Run the checks**

Run: `MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-finish" npm test -- --only test-add-project-remote && npm test -- --only test-sidebar-computers && npm test -- --only test-command-palette && npm test -- --unit --workspace desktop`
Expected: PASS; `add-project-remote.png` saved.

- [ ] **Step 6: Commit**

```bash
npx oxfmt apps/desktop/app/src/components/AddProjectDialog.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/lib/routed-bridge.test.ts scripts/test-add-project-remote.cjs
git add apps/desktop/app/src/components/AddProjectDialog.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/lib/routed-bridge.test.ts scripts/test-add-project-remote.cjs
git commit -m "feat(desktop): Add project on another computer, browsing its folders"
```

---

### Task 28: End to end: folders and images on a real Mac

This extends the routing end-to-end test from Task 22 with Phase C's two methods on a real daemon through a local relay. `fs:list-dirs` starts at the Mac's home folder. `media:read` returns an image in the opened Project's `.milagre/images`, and refuses one outside its roots. The test Mac's home is its own temporary folder, passed as `homeDir`.

**Files:**
- Modify: `apps/daemon/src/relay-test-kit.cjs` (`startTestMac` passes `homeDir`)
- Modify: `apps/desktop/electron/computers-e2e.test.cjs`

**Interfaces:**
- Consumes: `startDaemon({ homeDir })` (Task 24); the routed `computers:invoke` (Task 12).
- Produces: `startTestMac(t, …)` returns `home` (its home folder: the Mac's temporary directory).

- [ ] **Step 1: The test Mac gets a home of its own**

In `apps/daemon/src/relay-test-kit.cjs`'s `startTestMac`, pass `homeDir: directory,` to `startDaemon({ … })`, and add `home: directory,` to the object it returns.

- [ ] **Step 2: Write the test**

In `apps/desktop/electron/computers-e2e.test.cjs`, inside the test from Task 22, before `// Away: …`, add:

```js
  // Its folders, from its own home: the Project's folder is listed and already a Project.
  const listing = await within(call("computers:invoke", id, "fs:list-dirs", [{}]), "fs:list-dirs");
  assert.equal(listing.path, mac.home);
  assert.ok(listing.entries.some((entry) => entry.name === "project" && entry.project), "the opened Project reads as Added");
  await assert.rejects(call("computers:invoke", id, "fs:list-dirs", [{ path: "/etc" }]), /Only folders in the home folder/);

  // An image the chat shows, read through media:read; one outside the Project's roots is refused.
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  await fs.mkdir(path.join(mac.project, ".milagre", "images"), { recursive: true });
  await fs.writeFile(path.join(mac.project, ".milagre", "images", "shot.png"), png);
  const media = await within(call("computers:invoke", id, "media:read", [{ scope: projectKey, path: path.join(mac.project, ".milagre", "images", "shot.png") }]), "media:read");
  assert.equal(media.type, "image/png");
  assert.deepEqual(Buffer.from(media.base64, "base64"), png);
  await fs.writeFile(path.join(mac.home, "secret.png"), png);
  await assert.rejects(call("computers:invoke", id, "media:read", [{ scope: projectKey, path: path.join(mac.home, "secret.png") }]), /not available/);
```

- [ ] **Step 3: Run it**

Run: `node --test apps/desktop/electron/computers-e2e.test.cjs && node --test apps/daemon/src/peer-e2e.test.cjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx oxfmt apps/daemon/src/relay-test-kit.cjs apps/desktop/electron/computers-e2e.test.cjs
git add apps/daemon/src/relay-test-kit.cjs apps/desktop/electron/computers-e2e.test.cjs
git commit -m "test(desktop): a real Mac's folders and images through the window's routing, end to end"
```

---
## Phase D: checks, screenshots and the PR

### Task 29: Everything green, screenshots on their branch, the PR body

**Files:** none new in this branch. The screenshots go on the orphan `screenshots` branch.

- [ ] **Step 1: The repository's checks**

Run: `npm run typecheck && npm run lint && npm test -- --unit`
Expected: PASS for all three.

- [ ] **Step 2: Every Electron check**

Run: `npm test -- --electron`
Expected: PASS for every check. That includes the four new ones (`test-add-computer`, `test-computer-settings`, `test-sidebar-computers`, `test-add-project-remote`) and every check that selects a `dialog`: `test-allow-computer`, `test-chat-attachments`, `test-command-palette`, `test-find-in-chat`, `test-image-generation`, `test-handover`, `test-link-project-dialog`, `test-project-links`, `test-update-flow`, `test-subagents`, `test-task-track`.

- [ ] **Step 3: The end-to-end tests**

Run: `node --test apps/desktop/electron/computers-e2e.test.cjs apps/daemon/src/peer-e2e.test.cjs`
Expected: PASS.

- [ ] **Step 4: The phone: no visible change, same fingerprint**

Run: `npm run typecheck --workspace @milagre/mobile && npm run lint --workspace @milagre/mobile && npm test -- --unit --workspace mobile`
Expected: PASS. Then, as `apps/mobile/AGENTS.md` says:

```bash
cd apps/mobile
npx expo-updates fingerprint:generate --platform ios | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).hash))'
npx eas-cli@latest build:list --platform ios --status finished --limit 1 --json --non-interactive | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].runtimeVersion))'
cd ../..
```

Expected: the two values match. If they don't, stop and report; this PR adds no native code, so a mismatch means something else moved.

- [ ] **Step 5: Screenshots**

Run each new check with screenshots on:

```bash
export MILAGRE_SCREENSHOT_DIR="$TMPDIR/computers-finish"
npm test -- --only test-experimental-settings
npm test -- --only test-add-computer
npm test -- --only test-computer-settings
npm test -- --only test-sidebar-computers
npm test -- --only test-add-project-remote
unset MILAGRE_SCREENSHOT_DIR
ls "$TMPDIR/computers-finish"
```

Expected: `other-computers-on.png`, `add-computer-found.png`, `add-computer-waiting.png`, `add-computer-denied.png`, `computer-settings.png`, `computer-settings-remove.png`, `popover.png`, `popover-gear.png`, `merged-list.png`, `remote-chat.png`, `offline-chat.png`, `add-project-remote.png` (plus `off.png`, `on.png`, `murilo-on.png` from the Experimental check).

Put them on the orphan `screenshots` branch from a temporary worktree, never in this branch:

```bash
git fetch origin screenshots
git worktree add "$TMPDIR/milagre-screenshots" origin/screenshots
mkdir -p "$TMPDIR/milagre-screenshots/computers-finish"
cp "$TMPDIR/computers-finish/"*.png "$TMPDIR/milagre-screenshots/computers-finish/"
git -C "$TMPDIR/milagre-screenshots" add computers-finish
git -C "$TMPDIR/milagre-screenshots" commit -m "screenshots: computers on desktop (Add computer, popover, merged sidebar, offline, remote Add project)"
git -C "$TMPDIR/milagre-screenshots" push origin HEAD:screenshots
git -C "$TMPDIR/milagre-screenshots" rev-parse HEAD
git worktree remove "$TMPDIR/milagre-screenshots"
```

Link each image in the PR body as `https://raw.githubusercontent.com/the-ptf/milagre-ade/<that sha>/computers-finish/<name>.png`.

- [ ] **Step 6: By hand, on two Macs (or two user accounts), with the phone still paired to both**

1. Add the second Mac from the popover, then Allow it there.
2. Open one of its chats from the merged list and send a message. Approve a tool call, stop a turn, and commit and open a PR from its row menu.
3. Add a Project on it from Add project.
4. Open an image in one of its chats; copy it and save it.
5. Quit Milagre on the second Mac and wait for the banner. Read the cached chat, and check that the composer is off.
6. Reopen Milagre on the second Mac; its rows and the composer come back.
7. Remove the second Mac in Computer settings while one of its chats is open.

Expected: each step does what the spec says; the phone keeps working with both Macs throughout.

- [ ] **Step 7: The PR body**

Open the PR with `gh pr create` (no Claude or Anthropic footer, ever). Its body says:
- **What ships:** Settings › Experimental "Other computers" (default off), Add computer, the footer popover, Computer settings, the merged multi-computer sidebar, routing, remote limits, the offline cache, labeled notifications, the remote folder picker and remote images. These are the spec's steps 3b, 4 and 5 in one PR, as asked.
- **Decisions:** Link keys put the computer after `milagre-link:`; two or more computers show every Project; "Other computers" stays a default-off switch.
- **The phone:** no change on screen. `@milagre/shared/chat-scopes` and `agent-runs` changed with this Mac's keys untouched, and the fingerprint matches (Step 4). After merge, an OTA ships them from `main` with `npm run update:testflight -- --message "Shared key helpers name a paired computer (no change on the phone)"`.
- **Screenshots** from Step 5, and **the manual check** from Step 6 with its results.

No commit in this branch for this task.

---
## Self-Review

- **Spec coverage.**
  - **Step 3:** main wiring and IPC (Task 4), the Experimental switch (5), status words (6), Add computer (7), Computer settings (8), the popover (9). Add computer is offered only while the switch is on: the popover is its only door and is hidden while off (Task 9's check).
  - **Step 4:**
    - Identity: Task 11.
    - Routing: Tasks 12, 13 and 16, where the routing test forbids a regression.
    - State per computer and scope: Task 14. Runs and ports: Task 15.
    - The second line, dimming and "studio, offline": Task 17.
    - Remote limits: Task 18. The banner and disabled composer: Task 19.
    - The offline cache: Task 20. Notifications labeled with the computer: Task 21. End to end: Task 22.
  - **Step 5:** `fs:list-dirs` (Task 24) with the picker (27); `media:read` (25) for images and menus (26); end to end (28).
  - **"Errors":**
    - Reconnecting then Offline after 30 s were already in `computers.cjs`; Task 6 words them and Task 19 makes them read-only.
    - "studio is offline" for sends: Tasks 19 and 20.
    - The refusal words: Task 7's check.
  - **The carried edge cases:** calls in flight during the relay→LAN switch (Task 2); failures after a successful dial counting toward backoff (Task 1); the `finally` guard (Task 3); Add computer only while the switch is on (Task 9).
  - **Desktop and mobile sync:** the phone changes nothing on screen. Its shared key helpers are checked and shipped as an OTA (Tasks 11, 23, 29).
  - **Terms:** `GLOSSARY.md` already defines Computer and Device, so no task changes it.
- **Placeholder scan.** Every code step has its code. Three steps carry a bounded fallback, each naming exactly what to do:
  - Task 4 Step 10: JSDoc-only fixes if `tsc` flags the newly checked 3a modules.
  - Task 22: `project:open` in place of `project:read` if the latter needs an open Project.
  - Task 27: the accent tint as a style if the Tailwind class doesn't resolve.
- **Type consistency.**
  - `registerComputers({ ipcMain, computers, thisMac, send, cache?, onRemoteEvent? })` grows in Tasks 4, 12, 20 and 21, and every test passes the same names.
  - `ComputerView` gains `lanRoutes`/`addedAt` in Task 4, read in Task 8.
  - `ComputersApi.remember` (Task 20) matches the preload and `offline-cache.ts`.
  - `MilagreBridge.listDirs/readMedia/openProjectAt` (Task 26) are used by Task 27 and by the `ALIASES` from Task 12.
  - `replaceComputerEntries` (Task 15) is used by `ports.ts`.
  - `bridgeFor`, `bridgeForKey`, `isRemoteKey`, `forgetBridge`, `useBridge`, `onAnyAgentEvent` (Task 13), and `ScopeContext`/`useScope` (Task 26), are used under these names throughout.
  - `qualifyKey`, `computerOfKey`, `unqualifyKey`, `LOCAL_COMPUTER` (Task 11) are the same in shared, main and renderer.
- **Review Focus.** Each line has its test in the owning task:
  - two Macs with the same path: Tasks 11, 14, 15;
  - local-only actions on remote chats: Tasks 12, 18;
  - an uncached offline chat: Tasks 19, 20;
  - removing the open chat's computer: Tasks 15, 19;
  - folder and media escapes: Tasks 24, 25.
