# Chats without a Project

## Intent

Today every Chat starts inside a Project, so a quick question ("explain this error", "draft a reply", "what's the
flag for X") means first picking a repository that has nothing to do with it. T3 lets you just start a chat. Milagre
should too: a user picks **No project** and talks to the agent, with no repository chosen and no Git UI in the way.

## Victor's decisions (2026-10-28)

1. **Folder:** every project-less Chat gets its own new, empty folder. Archiving the Chat removes that folder.
2. **Sidebar:** project-less Chats get their own **Chats** group at the top of the sidebar, newest first (T3 style),
   styled like a Project group (chat-bubble mark, name, +). It shows in both the grouped and the flat (not grouped)
   layouts. The panel title that today reads "Chats" (flat desktop list, phone drawer) becomes **All chats**, so the
   word means one thing.
3. **Entry point:** the New chat Project picker gets a **No project** choice at the top (the picker says "No project",
   the sidebar group says "Chats"). The default stays the current Project, so existing habits don't change. With No
   project picked the heading reads "Just chat [No project ▾]" on desktop and "Just chat on <Computer> ▾" with
   "No project · its own empty folder" under it on the phone.
4. **Platforms:** desktop and phone in the same PR. The phone needs an OTA after merge.

5. **Window:** opening a project-less Chat switches the window to the Chats home, but the home is never remembered as
   the last Project; ⌘N and launch fall back to the last real Project.
6. **Archive with files:** Delete with the existing warning, no keep option.
7. **Account:** one shared selection for all project-less Chats, as a row in Settings › Accounts.
8. **Several computers:** one No project choice in the picker plus the existing #733 computer chip in the composer
   tray before the first send (this Mac on desktop, last-used computer on the phone). The Chats section is one merged list across computers.

## Designs

On this Chat's canvas: `desktop-new-chat-no-project` (picker + grouped sidebar), `desktop-flat-list-chats` (flat
sidebar), `phone-drawer-no-project`, `phone-new-chat-no-project`. `desktop-chat-quick-chats` is the rejected
"Quick chats" label variant; only its header (no Git icon) and composer still apply.

## Goals

- Start a Chat with **No project** from the centred New chat picker on desktop and on the phone.
- The agent runs in its own empty folder, so its files never mix with another Chat's or with a real Project.
- These Chats are listed in a **Chats** section at the top of the sidebar on desktop and phone, and work like any
  other Chat: send, resume, approvals, Terminals, Designs, artifacts, checkpoints, account selection, idle unloading
  (ADR-0009), and the Milagre MCP tools for the Chat itself.
- Archiving one removes its folder.

## Non-goals

- Moving a project-less Chat into a Project later, or "promoting" its folder to a Project.
- Making No project the default for New chat.
- Onboarding changes (a "just chat" path on first launch).
  A user with no real Project still sees onboarding on launch: `launchProject` returns null when only the Chats home
  exists, since the home is never a launch Project.
- Links, Delegations into project-less Chats, Routines and Heartbeats aimed at them. They may work by accident; nothing
  is built for them.

## Anti-goals (failures even if it technically works)

- A fake "Chats" Project showing up next to real Projects: in the Project groups of the sidebar, the canvas, Choose
  projects, the Filters › Projects submenu, the recent list, `project_list`, or the phone's Project lists.
- Git UI on a project-less Chat: branch pill, isolation picker, PR action and pills, "Commit and open PR…", diffstat,
  "Start from issue", Linear issue link.
- Archive silently throwing away files the agent wrote.
- Quick Chats disappearing because some list caps or filters them (the recent list holds 10 entries).

## How it works

### One Chats Project, one Worktree per Chat

Each computer has one internal Git repository, the **Chats home**, at `~/.milagre/chats` (next to the worktree root,
outside the data directory so the existing `assertRegistrableProject` guard doesn't refuse it). It is created on
first use: `git init -b main` and one empty commit, the way `createBotHome` does it (`packages/core/src/bots/home.cjs`).
It is opened as an ordinary Project by the runtime but is not added to the registry or the recent list (see Marking
it); `project:read`, `project:switch`, the phone's `project:open`, Routines and the MCP host's `validateProject` accept
it explicitly. Its empty commit has its own identity, "Milagre".

Each project-less Chat is a Chat in the Chats home on a new Milagre-made Worktree (isolation forced to `worktree`),
so its folder is `~/.milagre/worktrees/chats/<slug>`, empty except for the empty commit. This reuses Worktree
creation, setup, Terminals' cwd and the archive flow with no new folder lifecycle.

Considered and rejected: a hidden Project per Chat in the data directory, like bot homes (ADR-0010). The registry,
the recent list, `project:read`, `project:switch`, the daemon snapshot and the phone's Project list all skip hidden
homes, so the phone would never see these Chats and every one of those paths would need an exception. A plain-folder
(`git:false`) Project can't hold more than one Worktree, so it can't be the shared home.

### Marking it

Planning changed this (2026-10-28, two deviations). The daemon decides what the Chats home is (a path check, like
`bots.isHome`) and leaves it out of the lists instead of flagging list entries for clients to filter. A phone on the
previous OTA would show a Project named "chats" if the entries were only flagged.

- `project:recent`, `project:registry`, the Milagre MCP `project_list` and the onboarding lists never carry it. Nothing
  shows it as a recent Project, and it doesn't count toward the 10-entry cap.
- It is not added to the registry. The gates that need it (`project:read`, `project:switch`, the MCP host, Routines)
  accept it explicitly: MCP and Routines get an explicit home entry.
- The daemon snapshot keeps it, marked `kind: "chats"`. Windows restore their Chats from the snapshot; phones don't
  read it.
- `projectName` returns "No project" for it, so the inbox and notices say "No project".
- `project:forget`, Hide project and Choose projects never offer it, since it is in none of those lists.

### Archive

Archiving a project-less Chat removes its Worktree folder through the existing `archiveChat` flow and
`archiveChoices` (`packages/shared/src/archive.mjs:53-76`), unchanged (Victor, 2026-10-28):

- Folder clean (nothing the agent wrote): the menu offers `remove`, and Archive removes the folder.
- Folder holds files: the menu offers only `delete`, with the existing loss warning. There is no keep option.

Removing a Worktree drops its Chats from the Project's state, so an archived project-less Chat doesn't come back from
Archived. That matches "archiving removes the folder".

### Window's current Project (Victor, 2026-10-28)

Opening or starting a project-less Chat switches the window to the Chats home, as picking any Project does today
(`moveNewChat` / `switchProject`, `openCanvasChat`), so the existing draft, send and open flows are reused. But the
home is never remembered as a real Project:

- It is never saved as the window's last Project or added to the recent list as a Project, so the next launch opens
  the last real Project.
- ⌘N, the sidebar + on a Project, the palette and Triage (`startNewChatOnThisMac`, `newChatProject`) default to the
  last real Project when the current one is the Chats home. Only the picker's No project and the Chats section's +
  start a project-less Chat.
- Every surface that shows the current Project (title bar, Project settings, canvas, Git dialogs) checks
  `kind: "chats"`: it shows "No project" or nothing instead of the home's name, and offers no Project settings, canvas
  or Git actions.

### Account (Victor, 2026-10-28)

All project-less Chats on a computer share the Chats home's account selection (`accounts.selected(provider,
projectPath)` keyed on the home). Settings › Accounts shows it as a **Chats without a Project** row next to the
Project rows, desktop and phone. A usage-limit switch from one project-less Chat moves all of them.

### Desktop

- **Picker:** `NewChatHeading` / `ProjectPicker` (`useProjectChoices`) gets one **No project** choice, first, above
  the current Project, however many computers are paired. Picking it moves the draft to the Chats home of the chosen
  computer (created if missing) with isolation `worktree`.
- **Computer chip (Victor, 2026-10-28):** reuse the computer chip in the composer tray that #733 added (cec2613f).
  For a No project draft the tray shows only that chip (no isolation or branch chips). It defaults to this Mac;
  picking another computer moves the draft to that computer's Chats home. After the first send the Chat stays on its
  computer. No new chip is built.
- **Composer:** for a `kind: "chats"` Project the isolation and branch pickers, the "has no Git" note, "Start from
  issue" and the Linear link are hidden. The PR action, PR pills, diffstat and "Commit and open PR…" don't render.
- **Sidebar:** a **Chats** group sits above the Project groups and below Pinned, in both list layouts. In the flat
  layout it sits under the renamed **All chats** title, followed by a divider and the flat list of Project Chats. It lists every paired computer's project-less Chats in one newest-first list, each row with the computer
  chip rows already show (Victor, 2026-10-28: one merged list, not grouped by computer). It always
  shows, even with none yet and before any computer has a Chats home (Victor, 2026-10-28: a quick chat is one click
  away): its header with no rows. Its header has a + that opens New chat with No project picked, on this computer. The Chats home never appears as a
  Project group, in Filters › Projects, on the canvas or in the Projects | Bots switch's Projects list.
- **Chat header / title bar:** where a Chat shows its Project name, a project-less Chat shows "No project" (or
  nothing). It never shows "chats" or the folder path.
- **Notifications and inbox:** unchanged. Project-less Chats notify like any Chat.

### Phone

- **Picker:** the centred "Start building in" choice sheet (`app/chat.tsx` `chooseProject`) and `newChatProjects`
  (`new-chat-project.ts`) get **No project** first. It calls `chats:ensure` on the chosen computer, then `project:open`
  on the path it returns.
- **Computer chip:** same as desktop, defaulting to the computer the phone last used for a Chat.
- **Sidebar / Chat list:** a **Chats** section on top, same rules as desktop, one merged list across computers. The Chats home is left out of Choose
  projects and the Project lists.
- **Chat screen:** the same Git UI is hidden as on desktop.

### Daemon commands

- `chats:home` returns `{ path, exists }` for this computer's Chats home and has no side effects.
- `chats:ensure` creates the home if it is missing and opens it, without remembering it in recent, without registering
  it and without changing the shown Project. Desktop and phone call it when No project is picked. Everything after that
  is the normal New chat flow (`chat:send` with `projectPath` = the home and a new Worktree).

### Fix in the same PR: heading over the slash menu (Victor, 2026-10-28)

On the New chat screen the "Start building in" heading draws over the composer's `/` and `@` menu (seen with
"victor / milagre-ade" showing through the Milagre skills list). Cause: the heading's wrapper is `z-30`
(`ChatComposer.tsx:1409`) so its Project picker can cover the composer, while the menu is `z-20`
(`PromptComposer.tsx:643`). Fix: the heading wrapper takes the raised layer only while its own picker is open;
otherwise the composer's menus draw above it. Check the phone's New chat screen for the same overlap with its
skill and file menus, and fix it there if it shows.

## Constraints

- One writer per Project: the daemon (ADR-0001, ADR-0003). The Chats home is created and owned by the daemon only.
- Glossary: a **Project** is still a Git repository opened in Milagre. Add to `GLOSSARY.md` a **Chats home** entry:
  "the internal Project that holds a computer's Chats without a Project, one Worktree per Chat; never shown as a
  Project." Add an ADR (`0011-project-less-chats-share-a-chats-home.md`) for the shared-home choice and the rejected
  hidden-Project alternative.
- Phone parity: same behavior on the phone, shipped by OTA after merge.
- PR screenshots come from the real app (dev or packaged), stored on the orphan `screenshots` branch.

## Left to the builder

- Where exactly `kind` is attached (registry entry, recent entry, `project:read`, snapshot) and the shared type.
- Worktree slug naming for project-less Chats (the existing generator is fine).
- Icon for the Chats section header and for No project in the picker (pick from the existing icon set).
- Tests: daemon tests for `chats:home` and `chats:ensure` creation and idempotence, the lists leaving the home out,
  `project_list` filtering, and archive in `remove` mode; desktop and phone component tests for the picker choice and the section.
