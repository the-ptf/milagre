# Run Chats live in their Routine

Issue #532. Follows the Routines spec (`2026-10-16-routines-design.md`, PR #479).

## Why

Every **Run** of a **Trigger** opens a new **Chat**, and today each one lands in the sidebar named after the
**Routine**. A Routine that fires every hour fills the list with identical rows, and Victor can no longer see his own
work without scrolling past them. He also can't tell runs apart without opening each one.

What he wants: the sidebar holds his work only. A Routine's Chats live inside the Routine, where he can go to see what
ran, what was quiet and what was skipped, and open any of them. Each run Chat is named after what it did.

Prior art (researched 2026-10-18): Paseo, Devin, Warp, Superset, Orca and Claude routines all keep a run list per
routine that links to each session. Codex gathers results in a "Scheduled" inbox. Products that mix runs into the main
list got flooding complaints (openai/codex#23246, anthropics/claude-code#78229), and T3 Code has an open "Hidden" shelf
PR (#21105) for the same reason. No product names runs after what they did; Milagre will.

## Victor's calls (2026-10-18)

- **Run Chats live only in the Routine.** They leave the sidebar on desktop and phone. They open from the Routine's
  Runs list. One that needs an approval or an answer still notifies and shows in the attention pill. Once Victor sends
  it a message it becomes a normal Chat and joins the sidebar.
- **Titles come from what the run did.** When a Run that acted ends, a short title is generated from its final reply.
  Linear Runs keep the issue key and title. A quiet Run takes its `(pass)` summary. The Routine's name shows as a label
  (Runs list, Chat header), not in the title.
- **The Runs list shows every Run, quiet ones folded.** Acted and failed Runs are full rows. Quiet, skipped and missed
  Runs fold into one line per stretch ("5 quiet · last 10:30") that expands.

## Goals

- The sidebar, the Canvas and the phone's Chat list show no **Run Chat** Victor hasn't written in.
- Every Run Chat stays reachable: from its Routine's Runs list, a notification, or the attention pill.
- A Run's title says what it did, so the Runs list reads as a log.

## Non-goals

- Cleaning up the Worktrees that Runs create. They pile up (Orca has the same issue); that is its own change.
- A cross-Routine inbox like Codex's Scheduled view. The unread dot on the Routines button covers it for now.
- A per-Routine "show runs in the sidebar" switch.
- Changing Heartbeats. A Heartbeat sends into a Chat Victor or an agent chose; that Chat is his and stays in the
  sidebar. Linear comment deliveries into an existing Chat are the same.

## Anti-goals

- A Run Chat that is hidden and can't be reached from anywhere.
- A Run Chat waiting on an approval or a question that Victor can't find.
- Run Chats Victor already wrote in vanishing from his sidebar after the upgrade.
- A sidebar row that flickers in and out for a Run that is merely working.

## Terms

- **Run Chat:** a Chat a Run opened, marked `session.routine = { routineId, runId }` (`chat-host.cjs:289`). Schedule
  Routines with a new-Chat target, Linear events other than comments, and webhooks make them. Add it to `GLOSSARY.md`
  under Routines: "A **Chat** a **Run** opened. It lives in its **Routine**'s Runs list, out of the sidebar, until you
  send it a message."
- **Kept:** a Run Chat Victor has taken over (see "Keeping a Run Chat"). It is a normal Chat from then on.

## Behaviour

### Which Chats are hidden

A Run Chat is hidden until it is kept. Hidden means it is left out of every list of Chats:

- the desktop sidebar (`App.tsx:827-833`, `lib/sidebar-scopes.ts:98`)
- the phone's Chat list (`apps/mobile/src/project-navigation.tsx:296-320`)
- the Canvas (`packages/shared/src/canvas.ts:54`): a Worktree whose only Chats are hidden stays off it
- the Heartbeat target picker (`routines:targets`, `runtime.cjs:1178-1192`)

Most of these go through `isListedChat` (`packages/shared/src/chats.mjs:33`), so the rule belongs in a shared helper
beside it, not in each surface. Two places skip it: the phone list shows any Chat with a live run before checking
`isListedChat` (`project-navigation.tsx:317`), and so does the phone's Link picker (`:542`). The hidden rule must apply
there too, or a running Run Chat still shows on the phone.

Search follows the sidebar on both clients (phone search uses the shown rows, `project-navigation.tsx:320-324`; the
desktop palette uses the sidebar's Chats, `App.tsx:2246,2661`), so hidden Run Chats are out of Search too. *My call:*
a second search source on both clients isn't worth it; the Runs list is where to find them.

It still appears in:

- **the sidebar and the phone list, while it waits on Victor.** A hidden Run Chat with a pending approval or question
  shows like any Chat until it is answered, then hides again. Victor's call (2026-10-18): this covers the Project he
  is in, which the desktop attention pill skips (`App.tsx:749`, `attention.mjs:79`). Answering doesn't keep it.
- the attention pill and approval notices for other Projects, unchanged (`attention.mjs:72-82`)
- the floating inbox (`inboxSnapshot`, `attention.mjs:101`), but only while its status is `approval`, `question` or
  `failed`. A working or completed Run Chat stays out, or an hourly Routine would fill the inbox.
- desktop and phone notifications and push, unchanged. Tapping one opens the Chat.

### Keeping a Run Chat

A Run Chat becomes kept (`session.routine.kept`, a flag or a timestamp) when Victor:

- sends it a message from the composer, on desktop or phone
- pins it or renames it
- sets a Heartbeat on it, or an agent does (a Heartbeat Chat is ongoing work and its pulse belongs in the sidebar)

Messages that arrive any other way don't keep it: the Run's first message, a Linear comment delivered into the Chat, a
Delegation report, or a message an agent sends through `chat_start` or `delegate`. *My call:* only Victor's own hand
keeps a Chat.

A kept Chat shows in every list like any other Chat and stays in its Routine's Runs list.

On upgrade, a Run Chat counts as kept if it is pinned, renamed, a Heartbeat target, or has any user-role message after
the Run's first message. Old messages can't tell Victor from an agent, so this errs toward keeping; nothing he worked
in leaves his sidebar.

### Titles

- **Schedule and webhook Runs:** the Chat starts with the Routine's name as a placeholder, saved as `generatedTitle`
  so the first-message auto-title (`chat-host.cjs:815`) doesn't run on a prompt that is the same every time. Today it
  is saved as `title` (`runtime-adapter.cjs:201`).
- **When an acted Run ends** (`scheduler.cjs:486-492`), Milagre generates a 3 to 7 word title from the Run's final
  reply, the same way `generateChatTitle` (`chat-title.cjs:13`) does from a first message, with a prompt that names
  what the run did. It saves it as the Run's title (a new field on `RoutineRun`) and, for a Run Chat, as the Chat's
  `generatedTitle`. A name Victor gave the Chat (`title`) always wins.
- **Heartbeat Runs** get the same Run title, used only in the Runs list; their Chat's title is left alone.
- **Linear Runs** keep `MIL-12 Issue title`. The issue already says what was worked on.
- **Quiet Runs** take the first line of their `(pass)` summary, cut to 60 characters.
- **Failed Runs** and a title that fails to generate keep the Routine's name.

### The Routine page

Clicking a Routine's row on the Routines page opens its page in the main area. The row's ⋯ menu stays as it is. A
back button returns to the Routines page.

- **Header:** the row's icon tile, name and meta line, the enable switch, Run now, Edit (opens the existing form) and a
  ⋯ menu with Delete.
- **Runs:** newest first.
  - A running Run: spinner, "Running", start time.
  - An acted Run: its title, its time ("Today 10:15", "Oct 16 09:00"), an unread dot if its Chat is unread. Clicking
    opens its Chat.
  - A failed Run: "Failed", the first line of its error, its time. Clicking opens its Chat if it has one.
  - Quiet, skipped-busy and missed Runs next to each other, and webhook events refused for a bad signature
    (`rejected`), fold into one line: counts by kind and the latest time ("5 quiet · 2 skipped · last 10:30"). It
    expands in place. A quiet line shows its summary; a skipped line says its Chat was busy; a missed line says this
    Mac missed its time; a refused line says why it was refused.
  - A quiet Run that made its own Worktree has that Worktree removed with its Chat when it is clean
    (`scheduler.cjs:504`, `runtime.cjs:612,638`), which keeps quiet Runs from piling up Worktrees. Its line shows the
    summary and opens nothing. A quiet line opens its Chat only when one is left (Project-folder Runs, or a Worktree
    that wasn't clean).
  - Empty: "No runs yet" and, when it has one, the next run time.
- A Heartbeat's page lists its beats the same way; an acted beat opens its Chat.

**Unread:** the Routines button in the sidebar tools row shows a dot while any hidden Run Chat is unread, and so does
that Routine's row on the Routines page.

**Chat header:** a Run Chat shows a chip with its Routine's name that opens the Routine page. The desktop Chat header has
no routine button today (a Heartbeat Chat only shows "Next check", `ChatComposer.tsx:1147`), so a Heartbeat Chat gets
the same chip. On the phone, the existing routine button (`apps/mobile/src/app/chat.tsx:1074-1077`) opens the Routine
page instead of the form, and Run Chats get it too.

### Phone

The same page, pushed from the Routines screen when a row is tapped, built from the app's existing list components
(as `routines.tsx` and `routine-rows.ts` are). Edit sits in the header and opens `routine-form`. Folded lines expand in
place. The Routines button in the bottom dock shows the same unread dot. The Chat header chip or button opens the page.

### Deleting a Routine, and old Runs

- Deleting a Routine archives its hidden Run Chats; kept ones stay. The delete confirmation says so ("Its Runs stop,
  and its Run Chats you haven't kept are archived."). *My call:* no count, since a client can't see Chats in Projects
  it hasn't loaded and a wrong number is worse than none. A completed Routine purged after 30 days (`store.cjs:306-320`) does the same.
- The store trims Runs in three buckets today (`trimRuns`, `store.cjs:208-224`): skipped and missed share 50, refused
  share 50, and acted, quiet and failed share 50. A mostly quiet hourly Routine would push an acted Run out in about
  two days. *My call:* split that last bucket, so acted Runs keep their own 50 and quiet and failed Runs share another
  50.
- When an acted or failed Run is trimmed, its Chat is archived if it is hidden, so no Run Chat outlives its place in
  the Runs list. Archiving keeps the Worktree (`runtime.cjs:1384`).
- `archiveChat` does nothing for a Project that isn't open (`runtime.cjs:1385`). Archiving on delete, purge and trim
  must still reach Run Chats in closed Projects, by loading that Project's state or holding the archive until it opens.

## Constraints

- No mockups first (Victor, 2026-10-18): build from the existing Routines page and phone list components, and show the
  result with real-app screenshots in the PR.
- Copy follows `GLOSSARY.md`: Run, Run Chat, Routine, Chat, Worktree.
- Phone UI uses the app's real components, not new lookalikes.
- `linkedChat` (`runtime-adapter.cjs:228-252`) must keep finding hidden Run Chats so Linear comments still reach them.
  It skips archived Chats, so a trimmed Run's archived Chat stops getting comments, the same as today.
- Desktop ships in a beta; the phone part ships as an OTA after merge, if the native fingerprint still matches the
  current TestFlight build.

## Tests to update

`runtime-adapter.test.cjs` (titles at :336-357 and :410-445), `runtime-routines.test.cjs` (:346-377),
`scheduler.test.cjs` (quiet archive at :740, :784), `sidebar-scopes.test.ts`, `chat-list.test.ts`, `chats.test.ts`,
`canvas` tests if any, `lib/routines.test.ts`. New: hidden and kept rules, title at Run end, trim archives, delete
archives, the fold grouping.

## Left to the builder

- Whether "kept" is a flag or a timestamp, and where the upgrade check runs.
- The title prompt's wording and which text counts as the final reply (`chats.replyText`).
- How `routines:list` sends Run titles and unread state to both clients.
- Icons for the run states, from Hugeicons.
