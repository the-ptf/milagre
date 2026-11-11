# GPUI port map of the Milagre desktop UI

What has to be ported from the Electron + React renderer to GPUI, how hard each piece is, what the UI needs from the host,
and how to split the work into packages that separate agents can take without colliding. Written 2026-11-11 on branch
`milagre/chat-tie0`: the renderer as read at `d42bdad0`, the GPUI crate as of `6b521fb6`. While this map was being
written the crate moved from `gpui` 0.2.2 to `gpui-pre` 0.3.12 with `gpui-component` 0.9.1 (README "GPUI version
decision"); the GPUI facts below follow that move. Read-only analysis: nothing outside this file was changed.

**Scope decisions (Victor, 2026-11-11):** macOS only for now; Linux and Windows code paths (named pipes, Windows
paths in markdown and file links, window-control modes, `daemon:authenticate`) are not ported or tested. The Canvas
view (V-01, WP-47), the Browser panel (WP-35), Dictation (WP-53) and the floating inbox (WP-54) are not
migrated. The web content host (WP-34) stays for Artifacts and HTML replies only.

How to use it: section 1 is the summary. Section 2 lists every user-visible surface with an ID (`S-06`, `T-19`, …).
Section 6 hands those IDs out to work packages. An agent given one package should read its package block, the surface
rows it names, the matching part of section 4 (host calls) and section 5 (logic to port).

Path shorthand used in every table:

| Prefix      | Means                                                            |
| ----------- | ---------------------------------------------------------------- |
| `c/`        | `apps/desktop/app/src/components/`                               |
| `lib/`      | `apps/desktop/app/src/lib/`                                      |
| `app/`      | `apps/desktop/app/src/` (`App.tsx`, `main.tsx`, `styles.css`, …) |
| `shared/`   | `packages/shared/src/`                                           |
| `electron/` | `apps/desktop/electron/`                                         |
| `core/`     | `packages/core/src/`                                             |
| `daemon/`   | `apps/daemon/src/`                                               |
| `gpui/`     | `experiments/rust-gpui/` (this crate)                            |

## 1. Summary

### Counts

| What                        | Count                                                                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer source             | 415 TS/TSX files, about 81,000 lines without tests (237 `.tsx`). `App.tsx` is 4,523 lines, `styles.css` 2,372                                                                                                                                                                                                   |
| Screens and views           | 13: Chat, Chat grid and split, Canvas, Routines (4 pages), Settings (in-window dialog: 18 sections plus a page per computer and per Project), Link workspace, Diff view, Design page editor, Onboarding, Dawn intro, Project chooser, Startup error, Floating inbox (4 OS windows)                              |
| Side panels                 | 7: Changes (Files and Commits), PR (a tab in Changes), Terminal (bottom drawer), Browser, Designs, Artifacts, Simulator                                                                                                                                                                                         |
| Dialogs and sheets          | About 20 (Settings, command palette, Git actions, Worktree cleanup, Add computer, Add Project, Link Projects, Remove Project, Delete Link, computer allow prompt, release notes, handoff brief, quit error, attachment preview, MCP server sheet, design export, design share, media lightbox, discard prompts) |
| Surface inventory rows      | 165 (section 2)                                                                                                                                                                                                                                                                                                 |
| Components                  | About 364 exported React components and about 660 component functions                                                                                                                                                                                                                                           |
| Primitives                  | 29 in `c/primitives/` plus `roving.ts`; DESIGN.md names 32 desktop primitives                                                                                                                                                                                                                                   |
| Transcript item kinds       | 11 message-level kinds (dividers, notes, cards), 9 step kinds, about 30 inventory rows (2.3)                                                                                                                                                                                                                    |
| Host functions the UI calls | 403 renderer-facing functions: 348 calls and 55 event listeners                                                                                                                                                                                                                                                 |
| IPC channels                | 350 call channels and 55 event channels. About 80 are served by Electron main; the rest pass straight to the daemon, where the channel name is the daemon method                                                                                                                                                |
| Icons                       | About 200 distinct Hugeicons, imported in 139 files                                                                                                                                                                                                                                                             |
| Text entry                  | 1 `contentEditable` editor (the composer), `<textarea>` in 13 files, `<input>` in 30 files                                                                                                                                                                                                                      |
| Web content                 | `<iframe>` in 5 files, Electron `<webview>` for the Browser panel, `<canvas>` in 6 files                                                                                                                                                                                                                        |

### Biggest risks

1. **Markdown and selection.** GPUI itself cannot select static text; `gpui-component`'s markdown `TextView` has
   window-wide selection, but the transcript needs Milagre's own rules (file-link chips, fence routing to Mermaid and
   generative UI, the exact streaming split, quote and find across messages), so `TextView` must be proven against
   them first or a transcript-wide selection model is built from scratch.
2. **The composer.** It is a `contentEditable` editor with atomic chips, its own undo, paste and drop, IME and a
   dictation tint; `gpui-component`'s `Textarea` covers the 36 other files with plain fields, but the chips go beyond
   it unless its `input/token.rs` turns out to fit.
3. **Web content.** HTML replies, Artifact pages, live design frames, the simulator receiver and the Browser panel all
   run inside a browser engine today; they need a webview composited into GPUI (`gpui-webview` on `lb-wry`, or CEF) or
   a native rewrite, and WKWebView has no CDP for the Browser panel's phone mirroring and agent driving.
4. **Visual parity.** `gpui-component` widgets draw with their own theme, so every adopted widget must be re-skinned
   from DESIGN.md tokens; element backdrop blur and letter-spacing are still missing (only `gpui-ce` has them), and
   the springs and morphs of `motion` have to be rebuilt.
5. **A young dependency.** `gpui-pre` is ten weeks old with one publisher, and each `gpui-component` release pins one
   snapshot exactly, so upgrades move in lockstep; the fallback is a pinned Zed git rev (a 1.2 GB fetch).
6. **Size and a moving target.** About 81,000 lines and 400 host functions, plus the AGENTS.md rule that desktop and
   phone change together, make a third UI that chases every feature landing in the React desktop while it is built.

Also hard but well understood: the terminal (xterm.js to `alacritty_terminal`), the Canvas graph (React Flow), the
floating inbox windows, and accessibility (AccessKit is in `gpui-pre`, but every custom element needs its role by
hand to replace today's ARIA roles and live regions).

### Recommended order

First a fit check of `gpui-component` against Milagre's surfaces (WP-01), then foundations (theme and its bridge to
`gpui-component`, daemon transport and state store, UI kit, text input, markdown, selection), then the Chat column
(transcript and composer) and the sidebar, then panels, then Settings, Routines, Canvas and the remaining dialogs.
D5 (GPUI version) is decided; D1 to D4, D6 and D7 (section 6) must be made before wave 3.

## 2. Surface inventory

Size is the effort for a GPUI rewrite: S under a day, M one session, L one long session, XL more than one session.
"GPUI difficulty" names the blocker. Accessibility is a gap everywhere (risk 4) and is only named where it is central.

### 2.1 Window chrome and top bar

| ID   | Surface                                       | Source                                                                                                                                          | What it does                                                                                                                                                                                               | Data                                                                                                           | Size | GPUI difficulty                                                             |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- |
| C-01 | Window and drag strips                        | `electron/main.cjs:700-725`, `electron/window-chrome.cjs`, `lib/window-chrome.ts`, `app/App.tsx:3879`, `app/styles.css:562-571`                 | Frameless window, traffic lights at (16,16), 44px drag strip that stops dragging while a popover is open, minimum 980×680, window background follows the theme                                             | `milagreWindowChrome.controls`, `settings:window-background`                                                   | M    | solved in the spike: `start_window_move` from the 44px headers (`6b521fb6`) |
| C-02 | Startup splash and entrance                   | `app/main.tsx`, `c/StartupSplash.tsx`, `lib/startup-splash.ts`, `app/styles.css:1721-1790`                                                      | Logo assembles on the page colour, then fades over the app while the sidebar and main pane slide in                                                                                                        | splash store                                                                                                   | S    | animation of SVG paths                                                      |
| C-03 | Workspace frame                               | `c/DotBackground.tsx`, `app/App.tsx:3831-4463`, `app/styles.css:596-601`                                                                        | Dot grid with vignette, diagonal stripes, dock layer and sky layer, z-order of every region                                                                                                                | none                                                                                                           | M    | drawing (gradient dot grid, radial mask)                                    |
| C-04 | Sidebar bar controls                          | `c/SidebarNav.tsx:1505-1563`                                                                                                                    | Sidebar toggle, Canvas, Routines with unread dot, Link Projects, Search (opens ⌘K)                                                                                                                         | props, keybindings                                                                                             | S    | tooltips                                                                    |
| C-05 | Right corner controls                         | `c/agents/PanelToggles.tsx`, `c/changes/ChangesChrome.tsx:97-218`                                                                               | Panel toggles (Terminal, Artifacts, Designs, Browser, Simulators, PR #N, Changes) with shortcuts, grid toggle, Subchats button, "N waiting" chip and menu                                                  | `useSidePanel` registry, attention titles                                                                      | M    | menus                                                                       |
| C-06 | Chat identity, Subchat bookmark, Routine chip | `c/agents/ChatIdentity.tsx`, `c/agents/SubchatBookmark.tsx`, `c/agents/FamilyMenu.tsx`, `c/routines/RoutineChip.tsx`, `lib/bookmark-reserve.ts` | Title and Project; a parent bookmark with a family menu (⌘[); a Routine pill centred and kept clear of the corner buttons                                                                                  | state, `routines:list`                                                                                         | M    | layout measurement, menus                                                   |
| C-07 | Diff bar                                      | `c/changes/ChangesChrome.tsx:22-94`                                                                                                             | Back to the Chat, Send N comments, diff toolbar                                                                                                                                                            | `useChanges`, diff comments                                                                                    | S    | animation                                                                   |
| C-08 | Host and save notices                         | `app/App.tsx:3839-3863`, `c/PersistenceNotice.tsx`, `c/ProviderUpdateNotice.tsx`                                                                | Reconnecting, host outdated with Restart host, unsaved changes with Retry, provider CLI update card                                                                                                        | `runtime:connection`, `runtime:restart-host`, `scope:retry-save`, `agent:provider-updates`, `agent:update-cli` | S    |                                                                             |
| C-09 | View routing and Escape cascade               | `app/App.tsx:440`, `app/App.tsx:2774-2816`, `app/App.tsx:4482-4511`                                                                             | Chat, Canvas and Routines views; Settings over them; Project and Link workspaces kept alive; Escape order (Settings, Link, Find, Run pane, Routine page, view, deny approval, dismiss question, interrupt) | app state                                                                                                      | M    |                                                                             |

### 2.2 Sidebar

All modes are in one component tree. There are no native menus and no virtualization in the sidebar today; every menu,
popover and hover card is a DOM portal, and drag and drop is hand-rolled with pointer events.

| ID   | Surface                       | Source                                                                                                                                      | What it does                                                                                                                                                                                                                                                                          | Data                                                                                                                   | Size | GPUI difficulty                                             |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| S-01 | Sidebar shell                 | `c/SidebarNav.tsx:488-507`, `:612-631`, `:1216-1260`, `:1503-1807`; `c/primitives/ResizeHandle.tsx`; `app/styles.css:1140-1240`             | Card 224 to 420px wide, drag to resize, 44px rail (⌘B, automatic at 1024px and below), scroll position kept per mode                                                                                                                                                                  | `milagre.sidebarWidth`, `milagre.sidebarClosedScopes`, `milagre.sidebarScopeOrder`, settings                           | L    | animation (width, labels), virtualization                   |
| S-02 | All Chats (One list)          | `c/SidebarNav.tsx:1349-1397`, `:2136-2229`; `lib/sidebar-scopes.ts:146-221`                                                                 | Every scope's Chats merged by time as two-line rows with the Project icon; per-scope retry                                                                                                                                                                                            | `project:read`, `link:snapshot`, `project:state`, `link:state`                                                         | L    | virtualization                                              |
| S-03 | Project and Link groups       | `c/SidebarNav.tsx:286-448`, `:904-947`, `:1185-1214`; `c/primitives/ProjectAvatar.tsx`; `c/ProjectAvatarStack.tsx`; `c/WorkspaceIcon.tsx`   | Header with avatar that turns into a chevron, computer chip, attention dot, fold, + and ⋯ menu (Reveal, Copy path and name, Project settings, Remove)                                                                                                                                 | `project:image`, `project:reveal`                                                                                      | M    | animation (fold), menus                                     |
| S-04 | Every-Project merged headings | `c/SidebarNav.tsx:992-993`, `:1402-1486`; `lib/computer-scopes.ts`; `shared/project-origin.mjs`                                             | One heading per Git origin across computers; rows name their computer                                                                                                                                                                                                                 | `computers:list`, remote `project:recent`, `link:list`                                                                 | L    |                                                             |
| S-05 | Chats group (No project)      | `c/SidebarNav.tsx:1313-1348`; `shared/chats-home.mjs`                                                                                       | Project-less Chats, shown only while some exist                                                                                                                                                                                                                                       | `chats:home`                                                                                                           | S    |                                                             |
| S-06 | Chat row                      | `c/sidebar/ChatRow.tsx:135-601`, `:624-1187`; `c/sidebar/ChatTitle.tsx`; `c/primitives/SpinnerRing.tsx`                                     | 32, 48 or 50px rows. Marks: running ring, question, approval shield, Delegation, background count, unread dot, failed. Second line: computer, N waiting, branch, diff, time, Linear chip, PR chip. Hover Done and ⋯, ⌘1-9 hints, Subchat indent, Deleting overlay, collapsed initials | rows from `lib/chat-list.ts`, outbox, display clock                                                                    | XL   | text measurement (ellipsis trim), animation, virtualization |
| S-07 | Row context menu              | `c/sidebar/ChatRow.tsx:1525-1849`; `c/primitives/GlideMenu.tsx`                                                                             | 17 actions: copy path and branch, rename, reload, report bug, link or unlink issue, read or unread, Finder, editor, commit and PR, pin, Link with, remove Link, detach, Done or Reopen, Delete                                                                                        | `chat:patch`, `chat:reload`, `worktree:status`, `worktree:link-issue`, `editor:open`                                   | M    | menus (GPUI has no native context-menu API)                 |
| S-08 | Row hover card                | `c/sidebar/ChatRow.tsx:1284-1492`                                                                                                           | After 500ms: state, Heartbeat, PRs, ports, diff, branch, Linear issue, folder, Links                                                                                                                                                                                                  | row details                                                                                                            | M    | hover timing, positioning                                   |
| S-09 | Inline rename                 | `c/sidebar/ChatRow.tsx:1241-1275`                                                                                                           | Text field in the row; Enter, Escape, blur                                                                                                                                                                                                                                            | `chat:patch`                                                                                                           | S    | text editing                                                |
| S-10 | Done, Delete, Pin and undo    | `c/sidebar/ChatRow.tsx:1581-1619`; `c/SidebarNav.tsx:1941-2030`; `lib/done-pending.ts`; `lib/undo-history.ts`; `c/sidebar/SidebarToast.tsx` | Optimistic Done (held 60s), Delete with a 6s undo, ⌘Z and ⇧⌘Z over 50 steps, toast                                                                                                                                                                                                    | `chat:patch`, `chat:delete`, `worktree:status`, `worktree:remove`                                                      | M    | global keys                                                 |
| S-11 | Pinned section                | `c/SidebarNav.tsx:1594-1607`, `:2727-2755`; `lib/chat-pins.ts`; `shared/chat-pins.ts`                                                       | Per-device pins above everything, reordered by drag                                                                                                                                                                                                                                   | `milagre.chatPins`                                                                                                     | M    | drag and drop                                               |
| S-12 | Subchat nesting               | `lib/subchat-rows.ts`; `shared/subchats.ts`; `c/sidebar/ChatRow.tsx:1003-1028`                                                              | Children under the parent, at most 2 deep, folded by default, count badge                                                                                                                                                                                                             | `milagre.subchatsOpen`                                                                                                 | M    |                                                             |
| S-13 | Scope rail                    | `c/sidebar/ScopeRail.tsx`                                                                                                                   | Collapsed sidebar: one icon per scope with a badge; hover lists live Chats                                                                                                                                                                                                            | scope states                                                                                                           | M    | hover popover                                               |
| S-14 | Drag and drop                 | `c/SidebarNav.tsx:1830-1927`, `:2072-2119`, `:2369-2619`; `lib/grid-drop.ts`; `lib/chat-list.ts:463`                                        | Reorder Projects; pin, reorder and unpin rows; drop a row on a row to make a Link; drag to the Chat view to split or add a grid tile; keyboard drag with live announcements                                                                                                           | `canvas:link-add`, preferences                                                                                         | XL   | drag and drop, accessibility                                |
| S-15 | Link popovers                 | `c/sidebar/SidebarLinks.tsx`                                                                                                                | Create Link dialog (what it joins, Always allow, Ask textarea), Link-with picker with search, remove with undo                                                                                                                                                                        | `canvas:links`, `canvas:link-add`, `canvas:link-remove`, `canvas:link-restore`, `linked:grant`, `canvas:links-changed` | L    | text editing                                                |
| S-16 | Done section                  | `c/sidebar/DoneSection.tsx`; `shared/done.mjs`                                                                                              | Fold of Done Chats with an archive countdown and Reopen                                                                                                                                                                                                                               | `done:settings:read`, `done:settings`                                                                                  | S    |                                                             |
| S-17 | Plan usage block and card     | `c/usage/SidebarUsage.tsx`; `c/usage/UsageCard.tsx`; `c/usage/UsageBar.tsx`; `c/usage/useUsage.ts`                                          | Meters per provider, compact rail, hover card with an account picker                                                                                                                                                                                                                  | `usage:read`, `usage:cached`, `usage:changed`, `accounts:scope`, `accounts:assign`                                     | M    | hover timing, animation                                     |
| S-18 | Footer and Filters menu       | `c/SidebarNav.tsx:1761-1788`; `c/sidebar/FiltersMenu.tsx`; `c/sidebar/ComputersMenu.tsx`; `lib/hidden-projects.ts`                          | Add Project, Filters (Computers, Projects and Show submenus), Settings with an update badge                                                                                                                                                                                           | `project:set-hidden`, `link:update`, `computers:list`                                                                  | L    | nested menus                                                |
| S-19 | Empty and loading states      | `c/SidebarNav.tsx`                                                                                                                          | "Loading Chats…", "No Chats yet", "Couldn't load Chats" with Retry                                                                                                                                                                                                                    |                                                                                                                        | S    |                                                             |

### 2.3 Chat transcript

Dispatch lives in `c/ChatComposer.tsx` (`ReplyContent` at 285, `MessageSection` at 356, `MessageTranscript` at 624),
not in `App.tsx`. A reply is laid out as: setup steps, activity fold, viewed images, generated images, computer use
card, artifact cards, Heartbeat cards, the answer, a second activity fold, then the copy footer.

| ID   | Surface                           | Source                                                                                                                                                                                                                                                                                            | What it does                                                                                                                                                                                                                                        | Data                                                                                                  | Size | GPUI difficulty                                   |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------- |
| T-01 | Transcript scroller               | `c/agents/message-scroller.tsx`; `c/ChatComposer.tsx:356-921`, `:1690-1862`, `:2119-2355`; `lib/transcript-slots.ts`; `lib/chat-messages.ts`                                                                                                                                                      | Follows the bottom while streaming; keeps position when earlier messages load (6 first, 40 per page, trims back); parks the last 4 transcripts                                                                                                      | `chat:messages`, `MessageChanges`                                                                     | XL   | virtualization (variable heights), text selection |
| T-02 | Preview rail                      | `c/motion/PreviewRail.tsx`                                                                                                                                                                                                                                                                        | Tick minimap at the left edge, magnified ticks, preview card                                                                                                                                                                                        | text scraped from the DOM today                                                                       | M    | animation                                         |
| T-03 | User message                      | `c/ChatComposer.tsx:195-283`; `c/PromptText.tsx`; `c/QuoteChips.tsx`; `c/Attachments.tsx`                                                                                                                                                                                                         | Bubble with chips (skill, file, image), sent quotes, fenced code, attachments; Copy and Undo on hover                                                                                                                                               | message body, files, images                                                                           | M    | text selection (chips copy as their tokens)       |
| T-04 | Assistant answer                  | `c/markdown/Markdown.tsx`; `lib/file-links.ts`; `c/editor-links.tsx`                                                                                                                                                                                                                              | GFM markdown; inline code that opens files; links to the Browser panel or the browser; images; tables; task lists                                                                                                                                   | `editor:open`                                                                                         | XL   | text selection, rich text layout                  |
| T-05 | Streaming answer                  | `c/markdown/Markdown.tsx:345-395`; `shared/streaming-blocks.ts`; `shared/streaming-markdown.ts`                                                                                                                                                                                                   | Splits the live answer into blocks, re-parses only the last one, 50ms throttle                                                                                                                                                                      | `agent:event` text-delta                                                                              | L    |                                                   |
| T-06 | Thinking                          | `c/agents/StepRow.tsx` (thinking kind); `c/ChatComposer.tsx:285-347`                                                                                                                                                                                                                              | "Thought for Ns" row with markdown detail; the last unspoken thought dimmed                                                                                                                                                                         | steps                                                                                                 | S    |                                                   |
| T-07 | Activity fold                     | `c/agents/ActivityBlock.tsx`; `c/agents/ActivitySource.tsx`; `lib/activity-window.ts`; `shared/tool-activity.mjs`                                                                                                                                                                                 | One summary line with at most 4 stacked marks and the running step's title; opens to rows (last 150 when over 200)                                                                                                                                  | steps                                                                                                 | L    | animation (shimmer text, fold)                    |
| T-08 | Tool rows                         | `c/agents/StepRow.tsx`; `c/agents/StepOutput.tsx`; `c/agents/step-details.tsx`; `lib/step-sweep.ts`                                                                                                                                                                                               | 9 step kinds: shell and setup (command plus console output), read (file link), edit (diff), search, thinking, other and MCP (Linear verbs, JSON input), image and artifact (split out). Running, waiting and failed states; output loaded on demand | `chat:message`                                                                                        | L    | animation (gradient sweep over text)              |
| T-09 | Inline diff                       | `c/agents/StepDiff.tsx`; `c/changes/diff-lines.tsx`                                                                                                                                                                                                                                               | Tinted rows, word marks, gutters, 14-row clamp, Copy                                                                                                                                                                                                | patch text                                                                                            | M    | syntax runs                                       |
| T-10 | Approval                          | `c/agents/step-approval.tsx`; `c/agents/tool-approval.tsx`; `c/agents/PermissionCard.tsx`                                                                                                                                                                                                         | Inline on its tool row (Deny, Always allow, Allow once, details); a fallback card above the composer when no row claims it                                                                                                                          | `agent:respond-permission`                                                                            | M    |                                                   |
| T-11 | Question card                     | `c/agents/QuestionCard.tsx`; `lib/question-answers.ts`                                                                                                                                                                                                                                            | Options as radio or checkbox rows, "Other…" with mic and image buttons, tabs for several questions, timer                                                                                                                                           | `agent:answer-question`, dictation                                                                    | L    | text editing, audio                               |
| T-12 | Secret and bug report cards       | `c/agents/SecretCard.tsx`; `c/agents/BugReportCard.tsx`; `shared/bug-report.mjs`                                                                                                                                                                                                                  | Masked field with countdown; editable bug report with highlighted placeholders                                                                                                                                                                      | `agent:answer-question`                                                                               | M    | text editing                                      |
| T-13 | Answer card                       | `c/agents/AnswerCard.tsx`                                                                                                                                                                                                                                                                         | The user's answered questions                                                                                                                                                                                                                       | `message.answered`                                                                                    | S    |                                                   |
| T-14 | Subagents and Subchats            | `c/agents/SubagentTrack.tsx`; `c/agents/SubchatTrack.tsx`; `c/agents/SubchatMessages.tsx`; `lib/subchat-track.ts`; `shared/subchat-states.ts`; `shared/subagent-glance.mjs`                                                                                                                       | Pills that grow into lists and detail views (QA persona avatars, plan, steps, Result markdown, full log); Subchat notes and the suggestion card                                                                                                     | `chat:subagent`, `agent:dismiss-suggestion`, `advisor:stop`, `advisor:retry`, `chat:archive-subagent` | L    | animation (pill morph), blur                      |
| T-15 | Delegation report, linked message | `c/DelegationReportLine.tsx`; `c/LinkedMessage.tsx`                                                                                                                                                                                                                                               | "↳" line that expands a markdown report; sender line on Delegated messages                                                                                                                                                                          | message context                                                                                       | S    |                                                   |
| T-16 | Dividers                          | `c/Handover.tsx`; `c/WorktreeLinkDivider.tsx`; `c/CompactionDivider.tsx`; `c/AccountSwitchDivider.tsx`; `c/ChatReloadDivider.tsx`; `c/BabysitStoppedDivider.tsx`; `c/RoutineRunDivider.tsx`; `c/CheckpointRestoreDivider.tsx`; `c/ChatComposer.tsx:423-430`; `c/primitives/TranscriptDivider.tsx` | Handoff (opens the brief), Worktree link, compaction, account switch, limit reset, reload, babysit stopped, Routine Run (quiet Runs fold), checkpoint restore                                                                                       | message context                                                                                       | S    |                                                   |
| T-17 | Images                            | `c/agents/GeneratedImage.tsx`; `c/agents/ImageGeneration.tsx`; `c/agents/ViewedImages.tsx`; `lib/media.ts`; `lib/remote-media.ts`                                                                                                                                                                 | Generating dither field, blur-in reveal, Copy and Download, thumbnail strip                                                                                                                                                                         | `milagre-media://` protocol, `media:read`, `image:copy`, `image:save`, `image:menu`                   | M    | drawing (canvas loop), animation, native menu     |
| T-18 | Media lightbox                    | `c/motion/MediaLightbox.tsx`; `lib/lightbox.ts`                                                                                                                                                                                                                                                   | Morph from the thumbnail, zoom 1-4×, pan, swipe between items, video                                                                                                                                                                                | image bytes                                                                                           | L    | animation, video, blur                            |
| T-19 | HTML reply                        | `c/agents/HtmlReply.tsx`; `shared/html-render.mjs`; `shared/artifact-document.mjs`; `electron/artifact-preview.cjs`                                                                                                                                                                               | Agent-written HTML page inline in the reply, height 24 to 2000px reported by the page, chat theme injected                                                                                                                                          | `artifact:get`, `artifact-preview:register`, `artifact-preview:release`                               | XL   | webview                                           |
| T-20 | Artifact and design cards         | `c/agents/ArtifactCard.tsx:202-540`                                                                                                                                                                                                                                                               | Live scaled preview, strip of several designs, Open; design feedback card with a live thumbnail per comment                                                                                                                                         | `artifact:list`, `artifact:get`, `artifact:comments`                                                  | L    | webview (live iframes today)                      |
| T-21 | Computer use card                 | `c/agents/ComputerUseCard.tsx`; `shared/computer-use.ts`                                                                                                                                                                                                                                          | Numbered steps and the app's live screenshot                                                                                                                                                                                                        | `computer-use:frame` (long poll)                                                                      | M    |                                                   |
| T-22 | Usage limit card                  | `c/agents/UsageLimitCard.tsx`; `shared/usage-limit.mjs`                                                                                                                                                                                                                                           | Reset time, Continue at reset, switch-account rows                                                                                                                                                                                                  | `chat:limit-switch`, `chat:limit-resume`, `accounts:scope`                                            | M    |                                                   |
| T-23 | Small cards                       | `c/agents/LinearIssueCard.tsx`; `c/agents/PullRequestActionCard.tsx`; `c/agents/AdvisorResultCard.tsx`; `c/agents/recommendation-card.tsx`; `c/routines/HeartbeatCard.tsx`; `c/routines/NextCheck.tsx`                                                                                            | Linear issue, PR action, advisor result (markdown), recommended option, Heartbeat set with Stop, next check                                                                                                                                         | message context, `routines:list`, `routines:delete`                                                   | S    |                                                   |
| T-24 | Remote delegation card            | `c/agents/RemoteDelegationCard.tsx`                                                                                                                                                                                                                                                               | Work running on another computer: Open, Stop, nested approval                                                                                                                                                                                       | runs, `agent:interrupt`, `agent:respond-permission`                                                   | S    |                                                   |
| T-25 | Running and background indicators | `c/ThinkingIndicator.tsx`; `c/agents/BackgroundWork.tsx`                                                                                                                                                                                                                                          | Animated Milagre logo with the turn timer; background tasks with command output                                                                                                                                                                     | `chat:task-output`                                                                                    | M    | animation                                         |
| T-26 | Code block                        | `c/markdown/CodeBlock.tsx`; `c/markdown/highlighter.ts`; `lib/code-languages.ts`                                                                                                                                                                                                                  | Header, Copy, Shiki colours (40 languages, 40,000-char cap), diff mode                                                                                                                                                                              | none                                                                                                  | L    | syntax highlighting                               |
| T-27 | Mermaid diagram                   | `c/markdown/MermaidBlock.tsx`; `shared/diagram.ts`                                                                                                                                                                                                                                                | Diagram or Source, Copy, expand into the lightbox                                                                                                                                                                                                   | `pele` 1.6.0 (JS) renders SVG                                                                         | XL   | drawing (SVG produced by JS)                      |
| T-28 | Generative UI                     | `c/genui/*`; `shared/genui.ts`; `shared/genui-renderer.tsx`                                                                                                                                                                                                                                       | `openui` blocks: stack, table, callout, progress, button, bar and line charts                                                                                                                                                                       | `@openuidev/lang-core` 0.3.2 parser                                                                   | L    | drawing (charts), JS parser                       |
| T-29 | Find in chat                      | `c/FindBar.tsx`; `lib/find-in-chat.ts`                                                                                                                                                                                                                                                            | ⌘F bar, match count, highlights across messages                                                                                                                                                                                                     | DOM text walk, `chat:messages` (loads all)                                                            | L    | text selection                                    |
| T-30 | Quote selection                   | `c/MessageSelection.tsx`; `lib/quote-inbox.ts`                                                                                                                                                                                                                                                    | Floating Quote button over a selection inside one message                                                                                                                                                                                           | text selection                                                                                        | L    | text selection                                    |
| T-31 | Undo panel                        | `c/checkpoints/UndoPanel.tsx`; `shared/use-checkpoints.ts`                                                                                                                                                                                                                                        | Replaces the composer: tasks that changed files, preview, conflicts with Keep or Undo                                                                                                                                                               | `checkpoint:list`, `checkpoint:preview`, `checkpoint:restore`                                         | M    |                                                   |
| T-32 | Transcript notices                | `c/ChatComposer.tsx` (resume bar, Show earlier, Turn stopped); `c/Notice.tsx`; `c/primitives/InlineError.tsx`                                                                                                                                                                                     | Resume after quit, errors, load earlier messages                                                                                                                                                                                                    | `chat:resume`                                                                                         | S    |                                                   |

### 2.4 Composer

| ID   | Surface               | Source                                                                                                                                                                                                        | What it does                                                                                                                                                                                                                               | Data                                                                                     | Size | GPUI difficulty                        |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---- | -------------------------------------- |
| K-01 | Prompt editor         | `c/PromptEditor.tsx`; `lib/editor-model.ts`; `c/PromptChip.tsx`; `shared/prompt-parts.mjs`; `shared/prompt-skills.mjs`                                                                                        | `contentEditable` over a plain-string model; atomic chips for `/skill`, `@file`, `@chat:N`, `@computer:Name`, `[Image #N]`; own undo (500ms coalescing, 200 steps); paste as plain text; drop; IME; spellcheck; provisional dictation tint | `project:files` (a file chip only if the file exists)                                    | XL   | text editing                           |
| K-02 | @ and / menu          | `c/PromptComposer.tsx:277-390`, `:720-892`; `lib/file-mentions.ts`; `shared/skill-catalog.ts`; `shared/prompt-mentions.mjs`                                                                                   | Files, Chats, computers; skills plus `/undo`, `/storage`, `/summarize`, `/blockers`, `/plan`, `/review`                                                                                                                                    | `project:files`, `skills:list`                                                           | M    |                                        |
| K-03 | Composer bar and send | `c/PromptComposer.tsx`; `c/DraftChatComposer.tsx`; `lib/draft-store.ts`; `app/styles.css:798-848`                                                                                                             | Glass bar, footer grid, send, stop, queue and steer logic, ↑↓ history, Tab suggestion, Esc Esc opens Undo, Ultracode glow                                                                                                                  | `chat:send`, `agent:interrupt`                                                           | L    | blur, animation                        |
| K-04 | Attachments           | `c/Attachments.tsx`; `c/AttachmentPreview.tsx`; `c/usePastedImages.ts`; `lib/attachment-uploads.ts`                                                                                                           | Paste, drop, file picker; 80px tiles; upload progress; offline placeholder; text and markdown preview with download                                                                                                                        | `attachment:upload`, `attachment:preview`, `attachment:read`, `media:read`, `image:menu` | L    | drag and drop (files), video thumbnail |
| K-05 | Quote chips           | `c/QuoteChips.tsx`                                                                                                                                                                                            | Quoted passages above the prompt                                                                                                                                                                                                           | draft store                                                                              | S    |                                        |
| K-06 | Dictation             | `c/useDictation.ts`; `c/useDictationModels.ts`; `c/DictationNotice.tsx`; `c/DownloadRing.tsx`; `lib/dictation-shortcut.ts`; `lib/dictation-worklet.js`; `shared/voice-dictation.ts`; `shared/voice-stream.ts` | Mic, speech model download ring, live provisional words, fix-up by a model, hold or toggle shortcut (Alt+Space)                                                                                                                            | `app:dictation-*`, `dictation:context`, `dictation:polish`                               | XL   | audio                                  |
| K-07 | Model picker          | `c/ModelPicker.tsx`; `c/ProviderLogo.tsx`; `c/primitives/RangeSlider.tsx`; `lib/models.ts`; `shared/model-options.ts`; `shared/model-copy.ts`                                                                 | Provider rail, account select, search, models, effort slider, Fast and Ultracode tiles, permission select, CLI update notice                                                                                                               | `agent:models`, `agent:cli-status`, `accounts:assign`, `agent:update-cli`                | L    | animation (springs), SVG logos         |
| K-08 | Context ring and card | `c/ContextRing.tsx`; `c/ContextBar.tsx`                                                                                                                                                                       | Percent used, Compact, a card with thresholds                                                                                                                                                                                              | run `contextUsage`                                                                       | M    |                                        |
| K-09 | Queued messages       | `c/QueuedMessages.tsx`; `shared/queued-messages.mjs`                                                                                                                                                          | Queue card with Send now and remove                                                                                                                                                                                                        | `chat:queue-send`, `chat:queue-remove`                                                   | S    |                                        |
| K-10 | New Chat tray         | `c/ChatComposer.tsx:1084-1355`, `:1953-2003`                                                                                                                                                                  | Run on, Isolation, branch and Linear chips with pickers                                                                                                                                                                                    | `project:branches`, computers                                                            | M    |                                        |
| K-11 | New Chat heading      | `c/NewChatHeading.tsx`; `lib/new-chat-look.ts`                                                                                                                                                                | "Start building in [Project ▾]" with a Project and Link picker                                                                                                                                                                             | recent Projects, `link:list`                                                             | M    |                                        |
| K-12 | Linear issue picker   | `c/LinearIssuePicker.tsx`; `c/useLinear.ts`                                                                                                                                                                   | Search issues per workspace and start a Chat from one                                                                                                                                                                                      | `linear:issues`, `linear:status`                                                         | M    |                                        |
| K-13 | New Chat glance       | `c/NewChatGlance.tsx`; `shared/new-chat-glance.ts`                                                                                                                                                            | Open PRs, plan usage, today's spend with 24 hourly bars                                                                                                                                                                                    | `pull-requests:open`, `token-usage:read`, `usage:read`                                   | M    |                                        |
| K-14 | Pill row              | `c/motion/PillMorph.tsx`; `c/motion/morph.ts`; `c/primitives/StatusPill.tsx`; `c/agents/TaskTrack.tsx`; `c/agents/PhaseGraph.tsx`; `c/agents/PortTrack.tsx`                                                   | Glass pills that morph into panels: tasks and phase graph, ports, Subchats, subagents, simulators, jump to bottom                                                                                                                          | plan, ports                                                                              | L    | animation, blur, drawing (phase graph) |
| K-15 | Offline tray          | `c/OfflineTray.tsx`; `c/OfflineEmpty.tsx`; `lib/outbox.ts`; `shared/outbox.mjs`                                                                                                                               | Messages waiting for an offline computer                                                                                                                                                                                                   | IndexedDB outbox, `chat:send-status`                                                     | M    |                                        |
| K-16 | Ultracode Fatality    | `c/UltracodeFatality.tsx`                                                                                                                                                                                     | Full-window overlay with sparks and an audio clip                                                                                                                                                                                          | none                                                                                     | M    | animation, audio (optional feature)    |

### 2.5 Side panels

| ID   | Surface               | Source                                                                                                                                                                                                                                                        | What it does                                                                                                                                                                    | Data                                                                                   | Size | GPUI difficulty                                       |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------- |
| P-01 | Dock                  | `c/agents/DockSlide.tsx`; `c/agents/dock-area.ts`; `c/agents/panel-width.ts`; `c/agents/PanelToggles.tsx`; `c/changes/ChangesPanelSlot.tsx`; `c/primitives/ResizeHandle.tsx`                                                                                  | Panels spring open; widths per panel (Changes 280-640, Simulator 320-800, Browser 360-1400, Designs and Artifacts 440-1400); at most two open; the Chat keeps 420px             | `milagre.panelWidth.*`                                                                 | L    | animation                                             |
| P-02 | Changes tabs          | `c/changes/ChangesPanel.tsx:52-122`, `:325-436`                                                                                                                                                                                                               | "Changes N" plus one tab per PR, refresh spin                                                                                                                                   | `useChanges`                                                                           | M    |                                                       |
| P-03 | Changes Files         | `c/changes/ChangesPanel.tsx:136-207`, `:438-500`; `c/changes/DiffTree.tsx`; `c/changes/useDiffFiles.ts`; `c/changes/useComparison.ts`                                                                                                                         | Compare-with picker, Not committed and On this branch, flat list or folder tree                                                                                                 | `git:diff-files`, `git:history`                                                        | L    | text measurement (folder path fitting)                |
| P-04 | Changes Commits       | `c/changes/ChangesPanel.tsx:209-295`; `c/changes/CommitFiles.tsx`                                                                                                                                                                                             | Commits since the base, expand, files of a commit and their diff                                                                                                                | `git:history`, `git:diff-files`, `git:diff-file`                                       | M    |                                                       |
| P-05 | Link changes          | `c/changes/LinkChangesPanel.tsx`; `c/changes/useLinkDiffLists.ts`                                                                                                                                                                                             | One section per member Worktree of a Link Chat                                                                                                                                  | `git:diff-files`, `worktree:pull-request`                                              | M    |                                                       |
| P-06 | Diff view             | `c/changes/DiffView.tsx`; `c/changes/DiffFile.tsx`; `c/changes/diff-lines.tsx`; `c/changes/DiffPrefs.tsx`                                                                                                                                                     | Full-height diff over the Chat; sticky file headers; unified, split and wrap; word marks; the picked file stays pinned; patches load near the viewport; large and binary states | `git:diff-file`, `pr:diff-file`                                                        | XL   | virtualization, text selection, syntax                |
| P-07 | Diff line comments    | `c/changes/DiffComments.tsx`; `c/changes/useDiffComments.ts`; `lib/diff-comments.ts`                                                                                                                                                                          | Drag-select lines, comment card, outdated and stale comments, Send N to the Chat                                                                                                | localStorage `milagre:diff-comments:*`                                                 | L    | text editing, drag selection                          |
| P-08 | PR review in the diff | `c/changes/PullRequestReview.tsx`; `c/changes/usePrReviewActions.ts`; `lib/pull-request-view.ts`                                                                                                                                                              | Review threads under their lines, reply, resolve, Fix in Chat, review bar                                                                                                       | `pr:comment`, `pr:reply`, `pr:resolve-thread`, `pr:submit-review`                      | M    |                                                       |
| P-09 | PR panel              | `c/changes/PullRequestPanel.tsx`; `c/changes/pr/Properties.tsx`; `c/changes/pr/Popover.tsx`; `c/changes/usePullRequest.ts`; `c/useWorktreePullRequests.ts`                                                                                                    | Header and merge actions, checks bar, reviewer and label pickers, description and comments (GitHub HTML), files tab                                                             | `pr:detail`, `pr:merge`, `pr:ready`, `pr:labels`, `pr:image`, `pull-requests:snapshot` | L    | rich text (XL if PR HTML is rendered), network images |
| P-10 | Git actions dialog    | `c/GitActionsDialog.tsx`; `lib/git-dialog.ts`                                                                                                                                                                                                                 | Commit message, PR title and body, commit, push and open PR with progress and hook output                                                                                       | `git:changes`, `git:generate`, `git:commit`, `git:push`, `git:open-pr`                 | M    | text editing                                          |
| P-11 | Terminal              | `c/terminal/TerminalPanel.tsx`; `c/terminal/TerminalMenu.tsx`; `c/terminal/TerminalSlide.tsx`; `lib/terminal-sessions.ts`; `lib/terminal-store.ts`; `lib/terminal-actions.ts`; `lib/terminal-keys.ts`; `shared/terminal-client.mjs`                           | Bottom drawer, a tab per Terminal, shell select, xterm.js 6 (fit and WebGL addons), Copy and Paste menu                                                                         | `terminal:*` (output is a long poll, not a stream)                                     | XL   | terminal emulation                                    |
| P-12 | Browser chrome        | `c/agents/BrowserPanel.tsx`; `c/agents/BrowserViewer.tsx`; `lib/browser-panel.ts`                                                                                                                                                                             | Tabs, address bar, back, forward, reload, start page with the Chat's ports and other browsers                                                                                   | `browser:list`, `browser:attach`, `browser:detach`                                     | M    | text editing                                          |
| P-13 | Browser pages         | `lib/browser-webviews.ts`; `electron/browser-guests.cjs`; `electron/browser-panel-pages.cjs`; `electron/browser-remote-sessions.cjs`                                                                                                                          | One Electron `<webview>` per tab laid over the panel; session partitions; SOCKS proxy for remote Chats; pages published over CDP to the phone and agents                        | `browser-panel:*`                                                                      | XL   | webview                                               |
| P-14 | Browser page comments | `c/agents/BrowserComments.tsx`; `c/agents/CommentPin.tsx`; `c/agents/CommentOptions.tsx`; `lib/page-comments.ts`; `shared/page-picker.mjs`                                                                                                                    | Element picker injected into the page, numbered pins, comment bubble, element screenshots, Send                                                                                 | `browser-comments:add`, `browser-comments:list`, `browser-panel:capture`               | L    | webview                                               |
| P-15 | Designs canvas        | `c/agents/ArtifactCanvas.tsx`; `c/agents/LiveDesignFrame.tsx`; `c/agents/design-live.ts`; `c/agents/design-preview-cache.ts`; `c/agents/design-visibility.ts`; `c/agents/AgentCursor.tsx`                                                                     | Pan and zoom board of designs, versions, Choose, Delete, comment pins, live agent drafts and replays with named cursors                                                         | `artifact:*`, `agent:event` step-draft                                                 | XL   | drawing, webview (iframes today), animation           |
| P-16 | Design page editor    | `c/agents/DesignPageEditor.tsx`; `c/agents/DesignEditor.tsx`; `c/agents/DesignTools.tsx`; `c/agents/design-rebase.ts`; `c/agents/design-draft-cache.ts`; `c/agents/design-export.ts`; `c/agents/DesignExportDialog.tsx`; `c/agents/DesignPageShareDialog.tsx` | Full-window editor: tool rail, layers, an inspector of about 40 fields, select, move, resize, snap, undo, version merge, export JSON, SVG and PNG, share                        | `artifact:apply`, `artifact:get`, `artifact:share-page`                                | XL   | drawing, drag                                         |
| P-17 | Artifact page         | `c/agents/ArtifactPage.tsx`; `c/agents/ArtifactCard.tsx:865-1278`; `electron/artifact-preview.cjs`; `shared/artifact-document.mjs`                                                                                                                            | Agent-written HTML page with tabs, zoom and comment pins                                                                                                                        | `artifact:get`, `artifact:asset`, `artifact:comments`, `artifact-preview:register`     | XL   | webview                                               |
| P-18 | Simulator viewer      | `c/agents/SimulatorTrack.tsx`; `shared/simulator-receiver.mjs`; `shared/simulator-avc.mjs`                                                                                                                                                                    | Device list and attach; live stream over WebRTC, a frame relay or H.264; touch, button and key input                                                                            | `simulator:*`, `simlock:*`                                                             | XL   | video, webview (iframe today)                         |

### 2.6 Canvas, Chat grid and Link workspace

| ID   | Surface                     | Source                                                                                                          | What it does                                                                                                                                            | Data                                                                                                                                  | Size | GPUI difficulty                   |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------- |
| V-01 | Canvas (not migrated)       | `c/CanvasView.tsx`; `shared/canvas.ts`                                                                          | Project sections with Worktree cards and Chat rows; Link edges (smooth step, animated while Delegating); draw a Link between handles; zoom bar; filters | `canvas:snapshot`, `canvas:link-add`, `canvas:link-remove`, `project:position`, `canvas:worktree-position`, `linked:stop-negotiation` | XL   | drawing, drag and drop, animation |
| V-02 | Chat grid and split         | `c/ChatGrid.tsx`; `lib/chat-grid.ts`; `lib/grid-drop.ts`; `lib/subchat-split.ts`; `c/agents/TileFamilyMenu.tsx` | Tiles of active Chats; the focused tile owns the composer; drop overlay; split beside the parent                                                        | `chat:messages` per tile                                                                                                              | L    | drag and drop                     |
| V-03 | Link workspace              | `c/LinkWorkspace.tsx`                                                                                           | A shared Chat across Projects with member-aware Changes, its own palette and corner controls                                                            | `link:open`, `link:send`, `link:state`                                                                                                | L    |                                   |
| V-04 | Run Chat beside its Routine | `app/App.tsx:4040-4082`; `c/routines/RunChatHeader.tsx`                                                         | Routine page on the left (420px), Run Chat on the right                                                                                                 | routines                                                                                                                              | S    |                                   |

### 2.7 Routines

No canvas, React Flow, chart library, motion library or drag and drop in Routines: the Flow page is a vertical list
joined by 1px rails, and every menu is a DOM popover.

| ID   | Surface              | Source                                                                                                                                     | What it does                                                                                                            | Data                                                                                                                                            | Size | GPUI difficulty                           |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------- |
| R-01 | Routines list        | `c/routines/RoutinesPage.tsx`; `c/routines/RoutineRow.tsx`; `lib/routines.ts`                                                              | Title and New Routine, Show and Computer filters, Heartbeats and Triggers groups, rows with a ⋯ menu                    | `routines:list`, `routines:update`, `routines:run-now`, `routines:delete`, `routines:changed`                                                   | M    |                                           |
| R-02 | Routine page         | `c/routines/RoutinePage.tsx`; `c/routines/RoutineChips.tsx`                                                                                | Header, toolbar, chips, webhook URL shown once, Runs filter                                                             | `routines:update`, `routines:run-now`                                                                                                           | M    |                                           |
| R-03 | Run list             | `c/routines/RunList.tsx`                                                                                                                   | Runs by day, quiet Runs folded, retry attempts                                                                          | `routine.runs`                                                                                                                                  | M    |                                           |
| R-04 | Routine editor       | `c/routines/RoutineEditor.tsx`; `c/routines/use-routine-form.tsx`; `shared/routine-form.mjs`                                               | Name, trigger (every, at a time, cron, Linear event, webhook), where, model, fallback, mode, prompt, stop after, delete | `routines:create`, `routines:update`, `routines:delete`, `routines:targets`, `routines:linear-options`, `routines:hook`, `routines:rotate-hook` | L    | text editing, time and date pickers       |
| R-05 | Placeholder textarea | `c/routines/PlaceholderTextarea.tsx`; `shared/routine-prompt.mjs`                                                                          | Typing `{{` opens a field list under the caret                                                                          |                                                                                                                                                 | M    | text editing (caret position for a popup) |
| R-06 | Flow page            | `c/routines/FlowPage.tsx`; `c/routines/FlowSteps.tsx`; `c/routines/FlowPopover.tsx`; `c/routines/flow-look.ts`; `shared/routine-flows.mjs` | Steps with rails, add, move, delete, If paths, draft autosave, publish revisions, Steps, Runs and Settings tabs         | `routines:update`, `routines:flow-test`, `routines:flow-act`                                                                                    | XL   |                                           |
| R-07 | Flow inspector       | `c/routines/FlowInspector.tsx`                                                                                                             | A form per step type (agent, If, ask, wait, PR, Linear comment)                                                         |                                                                                                                                                 | L    | text editing                              |
| R-08 | Flow run view        | `c/routines/FlowRun.tsx`                                                                                                                   | Run bar, step states, approval card, receipt, failure and retry                                                         | `routines:flow-act`                                                                                                                             | L    |                                           |

### 2.8 Settings

Settings is an in-window `<dialog>` (`c/settings/SettingsModal.tsx`) with search, a nav and one page at a time.
Settings search jumps to a row by matching rendered text (`lib/settings-find.ts:38-48`); a port needs explicit row ids.

| ID   | Surface                   | Source                                                                                                                        | What it does                                                                                                                                                                     | Data                                                                                             | Size | GPUI difficulty            |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- | -------------------------- |
| G-01 | Settings dialog and nav   | `c/settings/SettingsModal.tsx`; `c/Settings.tsx:153-395`                                                                      | Up to 1120×800 over the app; nav groups (ungrouped, Agents, Code, Computers and devices, Projects, footer); a page per computer and per Project                                  | `project:recent`, computers                                                                      | L    | blur (scrim), focus trap   |
| G-02 | Settings search           | `c/settings/SettingsSearch.tsx`; `lib/settings-find.ts`; `lib/settings-index.ts`; `shared/settings-search.ts`                 | ⌘F over about 132 index rows; opens the page and flashes the row                                                                                                                 | index                                                                                            | M    | needs row ids              |
| G-03 | General                   | `c/Settings.tsx:1090-1166`                                                                                                    | Editor, Chat order, Chat list choice cards, Done retention, plan usage display, keep the Mac awake                                                                               | settings, `done:settings:save`, `editor:list`                                                    | S    |                            |
| G-04 | Appearance                | `c/Settings.tsx:1370-1566`; `c/settings/ThemePicker.tsx`; `c/settings/CustomThemeEditor.tsx`                                  | Mode, 12 themes, custom theme (colour pickers, hex, contrast, JSON copy and paste), installed fonts only, sizes, chat width, provider icons, sidebar usage, diff colours, motion | settings                                                                                         | XL   | colour picker, font list   |
| G-05 | Appearance window preview | `c/settings/AppearanceWindowPreview.tsx`                                                                                      | A 1440×900 miniature of the app, scaled down, that highlights what a row changes                                                                                                 | settings                                                                                         | L    | scaling a subtree          |
| G-06 | Chat                      | `c/Settings.tsx:808-821`; `c/settings/ChatDisplayChoices.tsx`                                                                 | While the agent works; reasoning and tool-call choice cards                                                                                                                      | `context:settings:save`                                                                          | S    |                            |
| G-07 | Voice                     | `c/Settings.tsx:824-901`; `c/settings/SpeechModelChoice.tsx`                                                                  | Shortcut, hold or toggle, paste or send, fix-up, 4 Whisper models with download and delete, language                                                                             | `app:dictation-status`, `app:dictation-download`, `app:dictation-cancel`, `app:dictation-remove` | L    | downloads                  |
| G-08 | Notifications             | `c/Settings.tsx:1240-1291`; `c/NotificationScheduleSetting.tsx`                                                               | Alerts, schedule (days, hours, time zone), chime with Play, unread Runs dot                                                                                                      | settings, `settings:notification-chime`, `settings:notification-schedule`                        | M    | audio                      |
| G-09 | Keybindings               | `c/settings/KeybindingsSettings.tsx`                                                                                          | Scope per computer, search, add, key capture with conflicts, when-conditions, reset                                                                                              | `keybindings:*`, remote bridges                                                                  | XL   | raw key capture            |
| G-10 | Models and context        | `c/Settings.tsx:1169-1238`; `c/ContextSettings.tsx`                                                                           | Default model and permission, context thresholds slider over a gradient bar, TLDR, Claude replies                                                                                | `context:settings:*`                                                                             | M    |                            |
| G-11 | Accounts                  | `c/AccountsSettings.tsx`; `c/ProjectAccountsSettings.tsx`; `c/Settings.tsx:2550-2635`                                         | Provider cards with accounts (add, sign in, remove), Antigravity install, usage-limit auto switch, per-Project accounts                                                          | `accounts:*`, `agent:cli-status`, `agent:update-cli`, `limits:*`                                 | L    |                            |
| G-12 | Usage                     | `c/token-usage/TokenUsagePage.tsx`; `c/usage/AccountUsageSection.tsx`; `shared/token-usage.ts`; `shared/use-account-usage.ts` | Plan usage cards; analytics with totals, a 90-day calendar heatmap with drag-select, where it went, models, token mix (all plain boxes, no chart library)                        | `token-usage:read`, `usage:accounts:read`                                                        | L    | drag selection             |
| G-13 | Skills                    | `c/SkillsSettings.tsx`                                                                                                        | Skill list with filters; detail with SKILL.md                                                                                                                                    | `skills:list`, `skills:read`, `skills:open`, `skills:reveal`                                     | L    | markdown                   |
| G-14 | MCP servers               | `c/McpSettings.tsx`; `c/McpServerRow.tsx`; `c/McpServerSheet.tsx`; `shared/mcp.ts`                                            | Checks per account, sign-in, toggles; add and edit sheet (catalog, token, custom URL or command, headers and env with masked secrets)                                            | `mcp:*`                                                                                          | XL   | text editing               |
| G-15 | Milagre MCP               | `c/LocalMcpSettings.tsx`; `shared/use-local-mcp.ts`                                                                           | Local clients, scoped connections, credentials shown once                                                                                                                        | `local-mcp:*`                                                                                    | M    |                            |
| G-16 | Browser                   | `c/Settings.tsx:903-971`                                                                                                      | Open links in; sign out per computer                                                                                                                                             | `browser-panel:clear-sign-ins`                                                                   | S    |                            |
| G-17 | Worktrees and cleanup     | `c/Settings.tsx:1071-1088`; `c/settings/WorktreeCleanup.tsx`                                                                  | Main branch sync default; cleanup dialog with groups, progress and Stop                                                                                                          | `main-sync:default:*`, `storage:worktrees`, `storage:remove-worktree`, `computer:resources:read` | M    |                            |
| G-18 | Integrations              | `c/Settings.tsx:1021-1036`, `:2638-2779`; `c/settings/BabysitPrsSettings.tsx`                                                 | Linear connect and disconnect; Babysit PRs page with an autosaving form                                                                                                          | `linear:*`, `babysit:settings:*`                                                                 | L    | text editing               |
| G-19 | Phone and sharing         | `c/Settings.tsx:1039-1052`, `:1638-2054`; `c/settings/SimlockSettings.tsx`                                                    | Phone access, pairing QR, devices, reset access, Simlock, published pages                                                                                                        | `phone:*`, `devices:*`, `simlock:*`                                                              | L    | QR image                   |
| G-20 | This Mac                  | `c/Settings.tsx:1055-1068`, `:1584-1629`; `c/settings/ComputerResources.tsx`; `c/settings/ComputerUseSettings.tsx`            | Memory and disk gauges with a breakdown, drive other computers, computer use page with permissions                                                                               | `computer:resources:read`, `computer-use:*`                                                      | L    |                            |
| G-21 | Computer page             | `c/Settings.tsx:427-612`; `c/settings/HostUpdateRow.tsx`                                                                      | Name, show in sidebar, connection routes, host update, auto update, the computer's MCP, remove                                                                                   | `computers:*`, `app-update:*`                                                                    | L    |                            |
| G-22 | Project pages             | `c/Settings.tsx:2405-2862`; `c/ProjectGitSettings.tsx`                                                                        | Icon upload, show in sidebar, accounts, main sync, branch policy with token chips, files to copy, setup command, remove                                                          | `project:set-icon`, `project-git:*`, `files-to-copy:*`, `worktree-setup:*`, `main-sync:*`        | L    | text editing, image resize |
| G-23 | Church (Experimental)     | `c/Settings.tsx:973-1018`                                                                                                     | Floating inbox, Ultracode Fatality, New Chat stats, Delegate to other computers, Device notes                                                                                    | settings, `linked:remote-enabled:*`, `device-notes:*`                                            | S    |                            |
| G-24 | About                     | `c/Settings.tsx:2094-2160`                                                                                                    | Version, release channel, updates, auto update, links                                                                                                                            | `app:version`, `update:*`                                                                        | S    |                            |

### 2.9 Overlays, dialogs, onboarding and notices

| ID   | Surface                   | Source                                                                                                                                              | What it does                                                                                                                                     | Data                                                                                           | Size | GPUI difficulty                  |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---- | -------------------------------- |
| O-01 | Command palette           | `c/CommandPalette.tsx`; `lib/commands.ts`; `lib/recent-commands.ts`; `lib/settings-commands.ts`; `lib/message-commands.ts`; `app/App.tsx:3551-3825` | ⌘K: Recent, Current Chat, Actions, Chats, Projects, quick settings (`App.tsx:3694`), Settings rows, message matches, Start a Chat with the query | app state, `chat:search`                                                                       | L    | text editing, blur               |
| O-02 | Onboarding                | `c/Onboarding.tsx`                                                                                                                                  | Agent step (install and sign in per provider), Project step (open, clone, create, recent agent folders, set up Git), first-Chat starters         | `agent:cli-status`, `accounts:*`, `onboarding:*`, `project:open`                               | L    | text editing                     |
| O-03 | Dawn intro                | `c/OnboardingIntro.tsx`; `app/styles.css:2034-2206`                                                                                                 | First-launch scene: clouds, falling star, dawn, Begin                                                                                            | none                                                                                           | XL   | drawing (SVG filters), animation |
| O-04 | Welcome sky               | `c/WelcomeSky.tsx`; `lib/sky-layer.ts`                                                                                                              | Wash, grain and glints behind a new Chat                                                                                                         | none                                                                                           | M    | drawing, animation               |
| O-05 | Project chooser and error | `app/App.tsx:3233`, `:3499-3545`                                                                                                                    | No Project open; open failed with Retry                                                                                                          |                                                                                                | S    |                                  |
| O-06 | Add computer              | `c/AddComputerDialog.tsx`                                                                                                                           | Pairing link preview, LAN-only, name, wait for the other computer to allow                                                                       | `computers:preview`, `computers:add`, `computers:cancel-add`, `computers:pending`              | M    |                                  |
| O-07 | Add Project               | `c/AddProjectDialog.tsx`                                                                                                                            | This Mac or a paired computer; open a folder or clone; remote folder browser                                                                     | `project:open`, `project:choose-folder`, `fs:list-dirs`, `project:open-at`, `onboarding:clone` | L    |                                  |
| O-08 | Link Projects             | `c/LinkProjectDialog.tsx`                                                                                                                           | Name and Project checklist; edit; delete                                                                                                         | `project:registry`, `link:create`, `link:update`                                               | M    |                                  |
| O-09 | Remove Project            | `c/RemoveProjectDialog.tsx`                                                                                                                         | Confirm forgetting a Project                                                                                                                     | `project:forget`                                                                               | S    |                                  |
| O-10 | Delete Link               | `c/DeleteLinkDialog.tsx`                                                                                                                            | Confirm; blocked while its Chats run; rechecks every 2s                                                                                          | `link:delete-check`, `link:delete`, `link:state`                                               | M    |                                  |
| O-11 | Computer allow prompt     | `c/ComputerAllowPrompt.tsx`                                                                                                                         | Must-answer prompt, buttons armed after 500ms                                                                                                    | `devices:pending`, `devices:allow`, `devices:deny`                                             | S    |                                  |
| O-12 | Release notes             | `c/UpdateReleaseNotes.tsx`                                                                                                                          | Markdown notes for a version                                                                                                                     | `update:release-notes`                                                                         | S    |                                  |
| O-13 | Handoff brief             | `c/Handover.tsx`                                                                                                                                    | The brief sent to the new provider                                                                                                               | message context                                                                                | S    |                                  |
| O-14 | Quit error                | `app/App.tsx:4446`                                                                                                                                  | "Chats could not be saved", retry quit                                                                                                           | `app:retry-quit`, `app:quit-failed`                                                            | S    |                                  |
| O-15 | Toast                     | `lib/toast.ts`                                                                                                                                      | Ink capsule at the bottom for 2.6s, above dialogs                                                                                                |                                                                                                | S    | top-most layer                   |
| O-16 | Update pill and card      | `c/UpdateNotice.tsx`; `c/motion/morph.ts`                                                                                                           | A pill above the composer that morphs into a card with progress, What's new, Install and restart                                                 | `update:*`                                                                                     | L    | animation                        |
| O-17 | Floating inbox            | `c/FloatingInbox.tsx`; `electron/floating-inbox.cjs`; `lib/inbox.ts`                                                                                | Edge dock with status dots, hover preview, inbox pager that answers questions and approvals, drag to dock on any display                         | `floating-inbox:*`, `agent:answer-question`, `agent:respond-permission`                        | XL   | multi-window                     |
| O-18 | System notifications      | `electron/notifications.cjs`                                                                                                                        | Approvals, questions, completion, pairing; Dock badge; chimes                                                                                    | agent events, settings                                                                         | M    | host side (OS APIs)              |
| O-19 | Editor-links toast        | `c/editor-links.tsx:41`                                                                                                                             | "Opened in X" toast                                                                                                                              |                                                                                                | S    |                                  |

### 2.10 Primitives

`docs/agents/ui.md` makes `ScrollArea`, `Select`, `RangeSlider`, `useDismiss` and the three blur tokens mandatory, and
bans switches. All are custom DOM today (the `Checkbox` and `RadioGroup` API names come from a former Radix base).

| ID   | Primitive                     | Source                                                                                                                                                         | Behaviour to keep                                                                                                        | Size   | GPUI difficulty |
| ---- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ | --------------- |
| U-01 | Button, IconButton            | `c/primitives/Button.tsx`                                                                                                                                      | 7 variants, 24/28/32 sizes, press scale 0.97, tooltip, 24px hit floor                                                    | S      |                 |
| U-02 | Checkbox, RadioGroup          | `c/primitives/Checkbox.tsx`; `c/primitives/RadioGroup.tsx`                                                                                                     | Checked, indeterminate, disabled; arrow keys in groups                                                                   | S      |                 |
| U-03 | Chip                          | `c/primitives/Chip.tsx`                                                                                                                                        | Trigger, field, filter and static chips                                                                                  | S      |                 |
| U-04 | Field, Input, FieldGroup      | `c/primitives/Field.tsx`                                                                                                                                       | 28/32/36 inputs with leading and trailing adornments, invalid state, no focus edge                                       | M      | text editing    |
| U-05 | Segmented, Tabs, roving focus | `c/primitives/Segmented.tsx`; `c/primitives/Tabs.tsx`; `c/primitives/roving.ts`                                                                                | One tab stop, arrows move and select                                                                                     | S      |                 |
| U-06 | Select                        | `c/primitives/Select.tsx`                                                                                                                                      | Listbox popover with search and groups, flips above or below                                                             | M      |                 |
| U-07 | Popover and menus             | `c/primitives/Popover.tsx`; `c/primitives/GlideMenu.tsx`; `lib/use-dismiss.ts`                                                                                 | Anchored to a trigger or a point, flip and clamp, roving menu, dismissal rules, gliding highlight                        | L      | layering        |
| U-08 | Picker                        | `c/primitives/Picker.tsx`                                                                                                                                      | Search field plus rows with keyboard                                                                                     | M      |                 |
| U-09 | Tooltip and shortcut hints    | `c/primitives/Tooltip.tsx`; `lib/shortcut-hints.ts`                                                                                                            | 400ms delay, shown on focus, keycap badges while ⌘ is held                                                               | M      |                 |
| U-10 | Dialog and modal layer        | `c/primitives/Dialog.tsx`; `lib/modal.ts`                                                                                                                      | Scrim with blur, focus trap and restore, Escape routing, must-answer dialogs                                             | L      | focus, blur     |
| U-11 | ScrollArea                    | `c/primitives/ScrollArea.tsx`; `lib/use-scroll-fade.ts`                                                                                                        | Overlay thumb shown while scrolling, edge fades, scroll chaining                                                         | M      |                 |
| U-12 | RangeSlider                   | `c/primitives/RangeSlider.tsx`; `lib/use-slider.ts`; `lib/slider-value.ts`                                                                                     | Ticks, bar handle with a spring, drag and keys, 3 variants                                                               | M      | animation       |
| U-13 | ResizeHandle                  | `c/primitives/ResizeHandle.tsx`; `lib/panel-resizing.ts`                                                                                                       | Pointer capture, keys, double-click reset                                                                                | S      |                 |
| U-14 | StatusPill                    | `c/primitives/StatusPill.tsx`                                                                                                                                  | Glass pill, rolling digits, letter rise                                                                                  | L      | blur, animation |
| U-15 | Display primitives            | `c/primitives/{EmptyState,InlineError,ProgressBar,ProjectAvatar,SectionLabel,Skeleton,SpinnerRing,TranscriptDivider,ZoomBar,CopyButton,ShortcutKeys,Icon}.tsx` | Static or lightly animated                                                                                               | S each |                 |
| U-16 | Motion                        | `lib/ease.ts`; `c/motion/morph.ts`; `c/motion/AppMotionConfig.tsx`                                                                                             | Springs (layout 360/32/0.6, swap 460/30/0.55, glide 400/28/0.5), 120/180/280ms, motion scale 1, 0.6 or 0, reduced motion | M      | animation       |

### 2.11 Where the code and DESIGN.md disagree

- **Sidebar surface.** DESIGN.md's surface table says `page` is the sidebar's colour; the code draws the sidebar as a
  `bg-surface shadow-card rounded-window` card (`c/SidebarNav.tsx:1567`).
- **Toast radius.** DESIGN.md says a toast is `rounded-card`; `lib/toast.ts:8-9` uses `rounded-full`.
- **Loops.** DESIGN.md (Motion) says the only loops are running marks: the running logo, a spinner ring and
  Ultracode's breathing composer. The code also loops the welcome-sky glints (`c/WelcomeSky.tsx`), the image
  generation dither field (`c/agents/ImageGeneration.tsx`, a canvas animation frame loop), the running step-title
  shimmer (`app/styles.css:1265-1314`), the Canvas Link dash flow (`app/styles.css:1907-1910`) and the PR checks
  running segment (`animate-pulse`).
- **Top edge blur.** DESIGN.md's `backdrop-blur-edge` is "content scrolling under a window edge, as a progressive
  blur"; at the Chat's top edge the code hides every blur layer and draws only the tint (`app/styles.css:984-998`).
  Good news for the port: no blur is needed there.
- **Experimental is called Church.** GLOSSARY.md and DESIGN.md say "Settings › Experimental"; the section is titled
  "Church" in the code (`lib/settings-index.ts:40`, `c/Settings.tsx:198`).
- **Decided, not built.** DESIGN.md has decided a two-row composer that is not built. The port should target the
  current composer unless the owner says otherwise.
- **The GPUI spike** README gives 960px as the minimum width while `electron/main.cjs:711` sets 980. (Its earlier
  Lucide-style icons were replaced by Hugeicons in `6b6ca9e8`.)

## 3. Things GPUI cannot draw natively

Checked in the `gpui-pre` 0.3.12 source (`~/.cargo/registry/src/*/gpui-pre-0.3.12/src`): `ImageFormat::Svg` exists, so
full-colour SVG can be shown as an image; `WindowKind` has `PopUp`, `AnchoredPopup` and `Floating`;
`WindowBackgroundAppearance` has `Transparent`, `Blurred` and the Windows Mica materials, for whole windows only;
`start_window_move` exists; elements take an AccessKit `role`; `on_drag`, `on_drop` and `ExternalPaths` cover in-app
and file drag and drop; `anchored` and `deferred` cover popovers; `EntityInputHandler` covers IME;
`prompt_for_paths`, `prompt_for_new_path`, `reveal_path`, `open_with_system` and the clipboard cover the simple native
services. There is no element backdrop blur and no letter-spacing (the spike README found both only in `gpui-ce`).

### 3.1 Candidates in `gpui-component` 0.9.1

`gpui-component` (Apache-2.0) is now a dependency of the crate but not yet used by its views. The modules below exist
in `~/.cargo/registry/src/*/gpui-component-0.9.1/src`; the "What it offers" column comes from the spike README where it
says so, otherwise only from module names. None was tested against Milagre's needs; WP-01 does that.

| Module                                                                                            | What it offers                                                                                      | Could serve                              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `text` (`window_selection.rs`)                                                                    | Markdown and HTML `TextView` with window-wide selection, inline code chips, streaming fade (README) | T-04, T-05, P-09 bodies, G-13, O-12      |
| `input` (`input.rs`, `textarea.rs`, `token.rs`, `editor.rs`)                                      | `Input`, `Textarea` (auto-grow, undo and redo, IME), a code `Editor` (README); `token.rs` unread    | U-04, every text field, maybe K-01       |
| `highlighter` (`syntect_backend.rs`, `languages/`)                                                | Syntax highlighting with a syntect backend or tree-sitter languages                                 | T-26, T-09, P-06                         |
| `diff`                                                                                            | A diff view with selection, review and conflict files                                               | P-06, P-07, T-09                         |
| `dock`, `resizable`                                                                               | `DockArea` with a persisted layout; `h_resizable` and `v_resizable` (README)                        | P-01, S-01                               |
| `scroll`, `virtual_list`, `list`                                                                  | Scrollbars, overlay scrollbars, variable-height virtual lists (README for scroll)                   | U-11, T-01, S-02                         |
| `menu`, `native_menu`, `popover`, `select`, `tooltip`, `dialog`, `sheet`, `hover_card`            | Popups, context and dropdown menus, native menus on macOS, dialogs, tooltips                        | U-06 to U-10, S-07, S-08                 |
| `command`                                                                                         | A command list                                                                                      | O-01                                     |
| `speech`                                                                                          | Microphone, level, recognizer                                                                       | K-06                                     |
| `color_picker`, `chart`, `plot`, `table`, `tree`, `slider`, `skeleton`, `spinner`, `notification` | As named                                                                                            | G-04, T-28, G-12, P-03, U-12, U-15, O-15 |
| `gpui-webview` (separate crate, on `lb-wry`)                                                      | A webview element (README)                                                                          | N-01, N-02, N-05                         |

### 3.2 What needs a webview, a crate or a rewrite

| #    | Thing                                  | Surfaces                     | Today                                                                                                                                               | Options                                                                                                                                                                                                                    | Recommendation                                                                                                                                                         |
| ---- | -------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-01 | HTML replies                           | T-19                         | Sandboxed iframe on `milagre-artifact://preview/…`, a second iframe inside, CSP, height and theme by `postMessage`                                  | (a) a wry child webview per reply (`gpui-webview`); (b) render offscreen once and show a snapshot until clicked; (c) a card that opens the page in the Artifacts dock                                                      | v1 (c). v2 (a) only for replies in view, with a cap on live webviews                                                                                                   |
| N-02 | Artifact pages and HTML artifact cards | P-17, T-20                   | Sandboxed iframe, custom protocol with ranged asset streaming, page helper script for pins and zoom                                                 | `gpui-webview` (on `lb-wry`) with a custom protocol handler and the same helper script; CEF; leave out                                                                                                                     | wry. Reuse `shared/artifact-document.mjs` output generated at build time, as `experiments/rust-desktop/build-content.mjs` already does                                 |
| N-03 | Designs canvas and design cards        | P-15, T-20                   | One iframe per design plus SVG to canvas PNG previews                                                                                               | Paint the design scene natively from layout boxes; show SVG from `shared/design-svg.mjs` as a raster (GPUI `ImageFormat::Svg` or resvg); keep iframes in a webview                                                         | Ask the host for layout boxes or SVG (the daemon already validates and rasterises designs with resvg); draw rasters for previews and native boxes for the active frame |
| N-04 | Design page editor                     | P-16                         | One iframe per artboard and an 11 KB controller script for select, move, resize and snap                                                            | Native rewrite over the scene; host the existing editor in a webview; leave out                                                                                                                                            | Leave out of v1 (review only); native rewrite later                                                                                                                    |
| N-05 | Browser panel                          | P-12, P-13, P-14             | Electron `<webview>` with partitions, a SOCKS proxy for remote Chats and CDP published to the phone                                                 | `gpui-webview` (WKWebView has no CDP, so no phone mirroring or agent driving); CEF (Chromium, heavy); the streamed viewer over the host's existing `browser:open/frame/input` API (the phone uses it); the default browser | Streamed viewer for agent and attached pages; user-opened tabs go to the default browser in v1                                                                         |
| N-06 | Simulator stream                       | P-18                         | Iframe with three decoders: WebRTC, a JPEG/PNG frame relay, H.264 via WebCodecs                                                                     | Frame relay as GPUI images; H.264 through VideoToolbox; WebRTC through webrtc-rs                                                                                                                                           | Frame relay first, VideoToolbox H.264 second, drop WebRTC                                                                                                              |
| N-07 | Mermaid diagrams                       | T-27                         | `pele` 1.6.0, a JS library that returns SVG                                                                                                         | A new daemon method that renders with pele; an embedded JS engine; an immature Rust Mermaid crate; show the source                                                                                                         | Host renders SVG, GPUI shows it as an image; source view as the fallback                                                                                               |
| N-08 | Terminal                               | P-11                         | xterm.js 6 with fit and WebGL addons                                                                                                                | `alacritty_terminal` (Apache-2.0) with an own grid painter; the `vt100` crate. Zed's `terminal_view` is GPL and cannot be copied into this MIT repo                                                                        | `alacritty_terminal`                                                                                                                                                   |
| N-09 | Syntax highlighting                    | T-26, T-09, P-06             | Shiki (TextMate grammars, JS regex engine, 40 languages, a CSS-variable theme of about 10 colours); the file viewer uses refractor/Prism (11 kinds) | `gpui-component`'s `highlighter` (syntect or tree-sitter backends); syntect alone (plus `two-face`); tree-sitter-highlight                                                                                                 | syntect mapped onto Shiki's colour buckets, through `gpui-component` if WP-01 finds it fits; one engine for code blocks, diffs and the file viewer                     |
| N-10 | Markdown with HTML                     | T-04, P-09                   | react-markdown and remark-gfm; rehype-raw with rehype-sanitize only for PR bodies and comments                                                      | `gpui-component`'s `TextView` (markdown and HTML); pulldown-cmark (in the spike) or comrak; HTML through ammonia and html5ever; convert GitHub HTML to markdown as the phone does (`shared/github-markdown.ts`)            | `TextView` if WP-01 finds it meets the rules in 5.4, else pulldown-cmark with GFM options; port `github-markdown.ts`; no raw HTML in replies                           |
| N-11 | Video                                  | T-18, K-04                   | `<video controls>` in the lightbox and attachment tiles                                                                                             | AVFoundation layer; decode with ffmpeg to frames; the system player                                                                                                                                                        | Images native; video opens with the system player (`open_with_system`) in v1                                                                                           |
| N-12 | Generative UI                          | T-28                         | `@openuidev/lang-core` parser plus hand-drawn SVG charts                                                                                            | Port the parser; the host parses to a JSON tree; fall back to the code block                                                                                                                                               | v1 shows the code block; later a host-side parse with native charts (`gpui-component` `chart` or `PathBuilder`)                                                        |
| N-13 | Canvas graph                           | V-01                         | React Flow: DOM nodes and an SVG edge layer                                                                                                         | Native: one transform, nodes as elements, edges with `PathBuilder`, own hit testing                                                                                                                                        | Native rewrite                                                                                                                                                         |
| N-14 | Backdrop blur                          | K-03, K-14, U-10, U-14, T-18 | CSS `backdrop-filter` tokens 3, 8 and 4px                                                                                                           | GPUI blurs only shadows and whole-window backgrounds; `gpui-ce` has element blur but diverges from upstream; a shader needs a fork                                                                                         | Translucent fills without blur; record it as a DESIGN.md exception                                                                                                     |
| N-15 | SVG filters and decorative animation   | O-03, O-04, T-17, K-07       | `feTurbulence`, `feDisplacementMap`, `feGaussianBlur`; a canvas loop for the dither field                                                           | Pre-render; paint natively; simplify                                                                                                                                                                                       | Pre-render the intro clouds and the grain; paint the dither natively; ship the Antigravity logo as a raster                                                            |
| N-16 | Floating inbox windows                 | O-17                         | Transparent always-on-top `BrowserWindow`s, macOS vibrancy, drag across displays driven by the cursor                                               | `WindowKind::PopUp` or `Floating` with a transparent background; `start_window_move` exists in `gpui-pre`; drop targets across displays need platform code                                                                 | Native windows with a small macOS shim                                                                                                                                 |
| N-17 | DOM measurement tricks                 | S-06, P-03, T-29, T-30, G-04 | Canvas `measureText`, DOM `Range` rects, the CSS Custom Highlight API, a font probe                                                                 | GPUI text shaping gives widths and glyph positions                                                                                                                                                                         | Native, as part of the text and selection packages                                                                                                                     |
| N-18 | Audio                                  | K-06, G-08, K-16             | `getUserMedia` with an AudioWorklet; HTML `Audio` for chimes                                                                                        | cpal for capture; rodio for playback                                                                                                                                                                                       | cpal and rodio                                                                                                                                                         |

## 4. Host boundary

### 4.1 How the renderer reaches the host today

Three layers. A GPUI app replaces the first two.

1. **Renderer.** It talks only to `window.milagre` (the `MilagreBridge`), `window.milagreBrowserPanel`,
   `window.milagrePreferences`, `window.milagreWindowChrome` and `window.milagreLaunch`, all exposed by
   `electron/preload.cjs:584-648`. Types: `app/electron.d.ts` (944 lines).
2. **Electron main** (`electron/main.cjs`).
   - **Passthrough** (`main.cjs:593-634`): for every method in the daemon's `daemon:status.methods`, main registers
     `ipcMain.handle(method)` and forwards `(method, args)` unchanged. **The IPC channel is the daemon method.** Only
     `computers:invoke` uses a second daemon connection (`electron/computers-lane.cjs:8`). `linear:connect` and
     `computers:add` get small side effects (`main.cjs:602-630`).
   - **Main-local handlers** (`main.cjs:165-702`, `:842`, `electron/floating-inbox.cjs`, `electron/app-shortcuts.cjs`,
     `electron/browser-guests.cjs`): dialogs, editors, images, notifications, floating inbox, app updates, dictation
     (Whisper), preferences and the Browser panel. About 80 channels. **These are what a GPUI host must reimplement.**
3. **Daemon** (`daemon/server.cjs`, `dispatch` at 656-969). It answers `daemon:*`, `desktop:*`, `phone:*`, `devices:*`,
   `state:read`, `fs:list-dirs`, `media:read`, `app-update:*`, browser sign-ins and a few overrides itself; sends
   `computers:*` to `daemon/computer-service.cjs` and `daemon/computers-ipc.cjs`; everything else goes to core
   (`core/command-dispatcher.cjs:53-75`; handlers in `core/runtime.cjs`, `core/git-ipc.cjs`, `core/link-runtime.cjs`,
   `core/checkpoint-runtime.cjs`).

Events: main forwards every daemon event channel to every window unchanged (`main.cjs:525-574`) except
`desktop:request` and `linear:sign-in-window`, which it consumes; main also sends its own channels.

Remote computers: `window.milagre.on(computerId)` (`preload.cjs:562-576`) returns the same bridge whose `invoke` is
`computers:invoke(id, channel, args)`. Local-only channels are refused (`preload.cjs:30-72`, mirrored in
`daemon/computer-routing.cjs:6-48`). Keys are qualified as computer id, a pipe, then the path on results and events
(`computer-routing.cjs:115-195`) and stripped from arguments. The renderer picks a bridge with `bridgeFor`,
`bridgeForKey` and `useBridge` (`lib/computer-bridge.ts:10-35`).

Reverse calls: main registers its local handlers with `desktop:register` (`electron/desktop-commands.cjs:11`); the
daemon sends `desktop:request {id, method, args}` events and main answers with `desktop:respond`
(`desktop-commands.cjs:49`). Callers: host updates (`update:state`, `app:version`, `update:check`, `update:install`),
browser sign-in clearing and the CLI. **A GPUI host must answer these too.**

### 4.2 What the GPUI `DataSource` should be

- Talk to the daemon socket directly; there is no Electron main. `experiments/rust-desktop/src/transport.rs` (1,742
  lines, the Tauri shell) already implements a persistent multiplexed Rust client of this socket with paging, method
  deadlines and the 32-request cap; extract it from its `tauri::Emitter` dependency instead of writing a new one.
  `experiments/rust-owner-wire/src/state_patch.rs` is a tested Rust port of the patch format.
- Split the trait in two: daemon methods (one generic call plus typed facades per domain) and a `NativeHost` for the
  about 80 main-local functions.
- Generate the method table (channel name, arity, whether it mutates) from `electron/preload.cjs` and
  `app/electron.d.ts` with a script, so the Rust side cannot drift.
- Type the hot payloads (state, sessions, messages, steps, agent events, runs, approvals, questions, subagents, PRs,
  usage, Routines) as serde structs that tolerate unknown fields; keep rarely used payloads as `serde_json::Value`.

```rust
/// One computer's daemon. `computer: None` is this Mac; `Some(id)` goes through computers:invoke and key qualification.
pub trait DataSource: 'static {
    fn call(&self, computer: Option<ComputerId>, method: Method, args: Vec<Value>) -> Task<Result<Value, HostError>>;
    fn events(&self) -> EventStream;             // HostEvent { computer, channel, payload, seq }
    fn connection(&self) -> Subscription<RuntimeConnection>;
}
/// What Electron main does today; the GPUI host implements it natively (section 4.4, "main" rows).
pub trait NativeHost: 'static { /* dialogs, editors, images, notifications, preferences, dictation, updates,
                                   artifact previews, browser panel, floating inbox, desktop:request answers */ }
```

### 4.3 Wire and state protocol

Wire (`daemon/protocol.cjs`, `daemon/client.cjs`, `daemon/server.cjs`):

- Socket `/tmp/milagre-<uid>/<sha256(realpath(dataDir))[0:24]>.sock`, or a named pipe on Windows (`daemon/paths.cjs:5-12`).
- Newline-delimited UTF-8 JSON frames, `v:1`, at most 16 MiB. Request `{v, id, method, args:[], pages:true}`; reply
  `{v, id, result}`, `{v, id, error:{code, message}}` or `{v, id, pages:{pageId, pageCount}}`.
- Results over a quarter frame are paged (`server.cjs:729-737`); the client reads `daemon:result-page [pageId, i]` in
  order and joins the text (`client.cjs:102-112`). Pages are at most 1 Mi characters and expire 30s after the last read.
- Events `{v, event:{channel, payload, seq}}`; `seq` is the daemon-wide event counter (`server.cjs:468`).
- At most 32 requests in flight per connection; the client queues the rest (`client.cjs:149`). Default deadline 30s;
  slow methods get more (`client.cjs:11-46`). A timeout means "may still be running, don't retry a mutation".

Handshake (`daemon/runtime-client.cjs:44-55`, `:79-100`): `daemon:status [{computerManagement:true}]` returns
capabilities and methods. With `chat-pages-v1` the client sends `daemon:state-patches [{messages:false,
transcripts:false?, archivedSubagents:false?}]` and gets an `epoch`; with only `state-patches-v1` it sends no options.
A host without `result-pages-v1` is flagged outdated.

What the host sends (`server.cjs:155-214`, `:255-280`, `:341-349`, `:456-560`):

- **Lean state.** `messages: []` and `messagesInChats: true`; subagents carry only a transcript tail; archived
  subagents arrive as summaries.
- **State events.** `project:state {path, state}`, `link:state {linkId, state}` and `agent:event {chatId, event,
  state?, seq?}`. Per scope the daemon keeps the last sent state and a `version` (+1 each send); `epoch` is one UUID per
  host run. A patch client gets `{patch, base, version, epoch}` instead of `state`, plus `messages: {changed:[{message,
  after}], removed:[id]}`. The first state of a scope, or a patch over 4 MiB, becomes `{resync:true, version, epoch}`.
- **Patch format** (`shared/state-patch.mjs`): `{v}` a whole value, `{o:{key: patch}, d:[deleted keys]}` an object,
  `{a: length, s:{index: patch}}` an array. Depth limit 4; untouched subtrees keep their identity.
- **Replies that carry a state** (`server.cjs:303`): `project:open`, `project:current`, `project:switch`,
  `canvas:open-project`, `onboarding:*`, `chats:ensure`, `project:read`, `project:snapshot`, `link:open`,
  `link:snapshot`. They get `{version, epoch}` when the state matches the last sent one. `project:read(path,
  {state:false})` returns the stamp without the state; `state:read(scope)` returns `{state, version, epoch}`.

Renderer state cache (`lib/state-events.ts`), which `src/data/store` must reproduce:

- `held: Map<scope, {epoch, version, state}>`. A numbered event applies its patch when `base` equals the held version
  and the epoch matches; otherwise the scope is re-read.
- Re-read (`readAgain`, lines 65-109): up to 3 tries of `state:read` with a 3s timeout each; queued patches newer than
  the read are applied in order; on success announce `{scope, reset:true}` to message listeners, release held agent
  events with the new state, then announce the state; on failure mark the scope behind and release events stateless.
- Ordering: while a scope is re-read, its `agent:event`s wait behind the read so a turn's end and the state holding its
  reply arrive together (lines 209-227).
- `runtime:snapshot` drops in-flight reads and resets message windows but keeps held numbers.

Chat messages (`lib/chat-messages.ts`): `chat:messages(scope, chatId, {turns:20})` returns `{messages, hasMore,
total}`; earlier pages with `{before, turns}`; windows cached for 8 Chats and 8 MiB; `MessageChanges` applied in place;
a `reset` re-reads every window of the scope; remote Chats paint first from `computers:recall`.

Runs (`c/useAgentRuns.ts`, `shared/agent-runs.mjs`): `chat:runs` returns `{runs, seq}`; `agent:event.seq` is the runs
sequence and events at or below the taken `seq` are skipped; `runtime:snapshot.runs` replaces a computer's runs.

Reconnect (`daemon/runtime-client.cjs:219-350`): emit `runtime:connection {connected:false}`; reconnect with backoff
(restart a crashed host up to 3 times); reopen every opened Project and Link, `chat:set-open`, `daemon:focus`; read
`daemon:snapshot {paged:true}` and its pages as a `RuntimeSnapshot`; deliver buffered events newer than its `eventSeq`
(cap 1024 events or 16 MiB); emit `runtime:connection {connected:true}`. Calls made while disconnected reject at once
and are never retried.

### 4.4 Calls and events by domain

Codes. Dir: Q request and reply, E host-to-renderer event, F fire and forget, S synchronous, L preload-local (no IPC).
R/W: R read-only, W mutating. "Defined" gives the preload line (P = `electron/preload.cjs`) and the handler: M =
`electron/main.cjs`, RT = `core/runtime.cjs`, GI = `core/git-ipc.cjs`, LR = `core/link-runtime.cjs`, CK =
`core/checkpoint-runtime.cjs`, SV = `daemon/server.cjs`, CI = `daemon/computers-ipc.cjs`, CS =
`daemon/computer-service.cjs`, FI = `electron/floating-inbox.cjs`. A handler in RT, GI, LR, CK, SV or CI is reached
through the passthrough; a handler in M or FI is main-local and becomes a `NativeHost` function. Renderer names are on
`window.milagre` unless shown otherwise. Find callers with a grep for the renderer name.

#### Projects and Worktrees

| Call                                                       | Channel                                        | Dir | Args → result                                                        | R/W | Defined                   |
| ---------------------------------------------------------- | ---------------------------------------------- | --- | -------------------------------------------------------------------- | --- | ------------------------- |
| `getCurrentProject`                                        | `project:current`                              | Q   | () → OpenProject with stamp, or null                                 | R   | P313 · SV923 / RT3225     |
| `openProject`                                              | dialog in main, then `project:open`            | Q   | () → OpenProject with stamp, or null                                 | W   | P314 · M693 · SV922       |
| `chooseFolder`                                             | `project:choose-folder`                        | Q   | () → path or null                                                    | R   | P316 · M697 (main)        |
| `openProjectAt`                                            | `project:open-at`                              | Q   | (folder) → OpenProject                                               | W   | P318 · M702 · SV922       |
| `listDirs`                                                 | `fs:list-dirs`                                 | Q   | ({path?}) → DirListing                                               | R   | P319 · SV875              |
| `listRecentProjects`                                       | `project:recent`                               | Q   | () → RecentProject[]                                                 | R   | P321 · RT3486             |
| `listKnownProjects`                                        | `project:known`                                | Q   | () → RecentProject[]                                                 | R   | P323 · RT3489             |
| `listAgentFolders`                                         | `onboarding:agent-folders`                     | Q   | () → AgentFolder[]                                                   | R   | P324 · RT3496             |
| `createProject`, `cloneProject`, `setUpGit`                | `onboarding:create`, `:clone`, `:init-git`     | Q   | (name) / (url, parent?) / (folder) → OpenProject                     | W   | P325-327 · RT3499-3501    |
| `setProjectHidden`                                         | `project:set-hidden`                           | Q   | (path, hidden) → RecentProject[]                                     | W   | P328 · RT3502             |
| `retrySave`                                                | `scope:retry-save`                             | Q   | (scope) → void                                                       | W   | P329 · RT3519             |
| `readProject`                                              | `project:read`                                 | Q   | (path, {state?}) → OpenProject with stamp, or ProjectRead            | R   | P336 · SV926 / RT3510     |
| `switchProject`                                            | `project:switch`                               | Q   | (path) → OpenProject with stamp                                      | W   | P369 · RT3593             |
| `forgetProject`                                            | `project:forget`                               | Q   | (path) → RecentProject[]                                             | W   | P370 · RT3609             |
| `chatsHome`, `ensureChatsHome`                             | `chats:home`, `chats:ensure`                   | Q   | () → ChatsHome / OpenProject with kind "chats"                       | R/W | P337-338 · RT3601-3602    |
| `listBranches`                                             | `project:branches`                             | Q   | (path) → string[]                                                    | R   | P177 · RT874              |
| `getProjectImage`, `setProjectIcon`                        | `project:image`, `project:set-icon`            | Q   | (path) → dataUrl or null / (path, dataUrl or null)                   | R/W | P178-179 · RT886, RT888   |
| `searchProjectFiles`                                       | `project:files`                                | Q   | (root, query) → string[]                                             | R   | P169 · RT816              |
| `revealInFolder`                                           | `project:reveal`                               | Q   | (folder) → void                                                      | –   | P280 · M316 (main)        |
| `listProjects`, `setProjectPosition`                       | `project:registry`, `project:position`         | Q   | () → registry entries / (id, {x,y})                                  | R/W | P348-349 · RT3394-3395    |
| `readFilesToCopy`, `previewFilesToCopy`, `saveFilesToCopy` | `files-to-copy:read`, `:preview`, `:save`      | Q   | (path[, patterns]) → FilesToCopy                                     | R/W | P188-190 · RT1007-1018    |
| `readWorktreeSetup`, `saveWorktreeSetup`                   | `worktree-setup:read`, `:save`                 | Q   | (path[, command]) → WorktreeSetupSettings                            | R/W | P191-192 · RT1045-1049    |
| `readProjectGit`, `saveProjectGit`                         | `project-git:read`, `:save`                    | Q   | (path[, Partial BranchPolicy]) → BranchPolicySettings                | R/W | P193-194 · RT1030-1034    |
| `readMainSync`, `saveMainSync`                             | `main-sync:read`, `:save`                      | Q   | (path[, bool or null]) → MainSyncSettings                            | R/W | P195-196 · RT1085-1090    |
| `readMainSyncDefault`, `saveMainSyncDefault`               | `main-sync:default:read`, `:save`              | Q   | ([bool]) → {syncMain}                                                | R/W | P197-198 · RT1096-1097    |
| `onMainSyncStatus`                                         | `main-sync:status`                             | E   | MainSyncStatus                                                       | –   | P199 · RT1073             |
| `createWorktree`                                           | `worktree:create`                              | Q   | (WorktreeRequest) → {project, worktreeId, setupNote?}                | W   | P182 · RT1129             |
| `linkWorktreeIssue`, `unlinkWorktreeIssue`                 | `worktree:link-issue`, `:unlink-issue`         | Q   | ({projectPath, worktreeId, key?, workspace?}) → result               | W   | P183-184 · RT1209, RT1260 |
| `getWorktreeRoots`, `getWorktreeStatus`                    | `worktree:roots`, `worktree:status`            | Q   | () → string[] / (path, base) → WorktreeStatus                        | R   | P185-186 · RT908, RT913   |
| `removeWorktree`                                           | `worktree:remove`                              | Q   | (path, {force, base, projectPath, chatId, seen}) → {removed, branch} | W   | P187 · RT923              |
| `onWorktreeRenamed`                                        | `worktree:renamed`                             | E   | WorktreeRename                                                       | –   | P273 · RT1126, RT1244     |
| `refreshDiffs`                                             | `worktree:refresh-diffs`                       | Q   | (path, ids[]) → void                                                 | W   | P274 · RT1278             |
| `readIdleWorktrees`, `removeIdleWorktree`                  | `storage:worktrees`, `storage:remove-worktree` | Q   | () → IdleWorktrees / (request) → {removed}                           | R/W | P217-218 · RT1830, RT1851 |

#### Chats

| Call                                          | Channel                                                    | Dir | Args → result                                                           | R/W | Defined                                |
| --------------------------------------------- | ---------------------------------------------------------- | --- | ----------------------------------------------------------------------- | --- | -------------------------------------- |
| `onProjectState`                              | `project:state`                                            | E   | {path, state?} plus numbering                                           | –   | P373 · RT668-676                       |
| `onLinkState`                                 | `link:state`                                               | E   | {linkId, state?} plus numbering                                         | –   | P347 · RT672                           |
| `onRuntimeSnapshot`                           | `runtime:snapshot`                                         | E   | RuntimeSnapshot                                                         | –   | P165 · `daemon/runtime-client.cjs:324` |
| `readState`                                   | `state:read`                                               | Q   | (scope) → {state, version, epoch}                                       | R   | P397 · SV905                           |
| `readChatMessages`                            | `chat:messages`                                            | Q   | (scope, chatId, {before?, turns?, limit?}) → {messages, hasMore, total} | R   | P398 · RT3559                          |
| `searchChats`                                 | `chat:search`                                              | Q   | (scope, query, {limit?}) → ChatSearchMatch[]                            | R   | P399 · RT3573                          |
| `getMessage`                                  | `chat:message`                                             | Q   | (scope, id) → ChatMessage with step details                             | R   | P396 · RT3529                          |
| `readSubagent`                                | `chat:subagent`                                            | Q   | (scope, chatId, agentId) → Subagent                                     | R   | P400 · RT3582                          |
| `readTaskOutput`                              | `chat:task-output`                                         | Q   | (chatKey, taskId) → BackgroundTaskOutput                                | R   | P401 · RT2563                          |
| `getRuns`                                     | `chat:runs`                                                | Q   | () → {runs, seq}                                                        | R   | P395 · RT2461                          |
| `setOpenChat`                                 | `chat:set-open`                                            | Q   | (chatKey or null) → void                                                | W   | P394 · SV913 → RT2456                  |
| `patchChat`, `deleteChat`, `detachChat`       | `chat:patch`, `chat:delete`, `chat:detach`                 | Q   | (path, sessionId[, SessionPatch]) → void or string                      | W   | P388-390 · RT2416, 2421, 3183          |
| `archiveSubagent`, `archiveFinishedSubagents` | `chat:archive-subagent`, `chat:archive-finished-subagents` | Q   | (path, sessionId[, id, archived])                                       | W   | P391-392 · RT2433, RT2438              |
| `addGitNote`                                  | `chat:git-note`                                            | Q   | (chatKey, body)                                                         | W   | P393 · RT2442                          |
| `getAgentPorts`, `onAgentPorts`               | `agent:ports`                                              | Q/E | () → AgentPorts                                                         | R   | P419, P421 · RT1457, RT1454            |
| `stopAgentPort`                               | `agent:stop-port`                                          | Q   | (chatKey, pid) → boolean                                                | W   | P420 · RT1464                          |

#### Messages, runs and sending

| Call                            | Channel                                | Dir | Args → result                                            | R/W | Defined                   |
| ------------------------------- | -------------------------------------- | --- | -------------------------------------------------------- | --- | ------------------------- |
| `sendMessage`                   | `chat:send`                            | Q   | (ChatSendRequest) → {sessionId}                          | W   | P379 · RT2217             |
| `sendStatus`                    | `chat:send-status`                     | Q   | (owner, id) → {sessionId} or null                        | R   | P380 · RT776              |
| `sendLinkMessage`               | `link:send`                            | Q   | (LinkSendRequest) → {sessionId}                          | W   | P346 · LR180              |
| `resumeChat`, `reloadChat`      | `chat:resume`, `chat:reload`           | Q   | (path, sessionId) / (chatKey)                            | W   | P381-382 · RT2276, RT2536 |
| `sendQueuedNow`, `removeQueued` | `chat:queue-send`, `chat:queue-remove` | Q   | (chatKey, id)                                            | W   | P383-384 · RT2522, RT2528 |
| `interruptAgent`                | `agent:interrupt`                      | Q   | (chatKey)                                                | W   | P412 · RT2515             |
| `setAgentPermissionMode`        | `agent:set-permission-mode`            | Q   | ({chatId, mode})                                         | W   | P417 · RT2673             |
| `stopAdvisor`, `retryAdvisor`   | `advisor:stop`, `advisor:retry`        | Q   | (chatKey, id) → Subagent                                 | W   | P409-410 · RT3108         |
| `onAgentEvent`                  | `agent:event`                          | E   | {chatId, event: AgentEvent, state?, seq?} plus numbering | –   | P418 · RT1376, RT1414     |
| `prepareTriage`                 | `triage:prepare`                       | Q   | (client) → {prompt}                                      | W   | P181 · RT896              |

#### Approvals, questions and secrets

Secret requests and bug-report approvals are `QuestionRequest` variants (`secretRequest`, `bugReport`) that arrive in
`agent:event` `question-request` and are answered with `agent:answer-question`.

| Call                  | Channel                    | Dir | Args → result                                                                      | R/W | Defined       |
| --------------------- | -------------------------- | --- | ---------------------------------------------------------------------------------- | --- | ------------- |
| `respondToPermission` | `agent:respond-permission` | Q   | ({chatId, requestId, decision: allow, allow-for-chat or deny}) → boolean           | W   | P413 · RT2589 |
| `answerQuestion`      | `agent:answer-question`    | Q   | ({chatId, requestId, answers or null, summary?, images?, suggestionId?}) → boolean | W   | P414 · RT2606 |
| `dismissSuggestion`   | `agent:dismiss-suggestion` | Q   | ({chatId, id}) → boolean                                                           | W   | P416 · RT2658 |

#### Git and changes (`git.*`, every call takes `{cwd, …}`)

| Call            | Channel          | Args → result                                                                       | R/W              | Defined      |
| --------------- | ---------------- | ----------------------------------------------------------------------------------- | ---------------- | ------------ |
| `git.changes`   | `git:changes`    | {cwd, base?} → GitChanges                                                           | R                | P285 · GI83  |
| `git.history`   | `git:history`    | {cwd, base?, recordedBase?, branchesVersion?, limit?} → GitHistory                  | R                | P286 · GI84  |
| `git.diffFiles` | `git:diff-files` | {cwd, base?, commit?, mode} → DiffFilesResult                                       | R                | P287 · GI87  |
| `git.diffFile`  | `git:diff-file`  | {cwd, base?, commit?, mode, path, oldPath?, untracked?} → {patch, binary, tooLarge} | R                | P288 · GI88  |
| `git.generate`  | `git:generate`   | {cwd, base?, provider?, chat} → {commitMessage, prTitle, prBody}                    | R (runs a model) | P289 · GI122 |
| `git.commit`    | `git:commit`     | {cwd, message} → GitCommitResult                                                    | W                | P290 · GI134 |
| `git.push`      | `git:push`       | {cwd} → GitPushResult                                                               | W                | P291 · GI135 |
| `git.openPr`    | `git:open-pr`    | {cwd, base?, title, body} → GitPrResult                                             | W                | P292 · GI139 |

All `git:*` calls are Q with 120 to 330s deadlines (`client.cjs:22-25`). Diffs are computed by the host with the git CLI
(`core/git-diff.cjs`; patches over 1 MB come back as `tooLarge`); the renderer only parses and lays them out.

#### PRs and GitHub

| Call                                           | Channel                                           | Dir | Args → result                                                              | R/W | Defined                   |
| ---------------------------------------------- | ------------------------------------------------- | --- | -------------------------------------------------------------------------- | --- | ------------------------- |
| `readPullRequest`, `readPullRequests`          | `worktree:pull-request`, `worktree:pull-requests` | Q   | (path) / (path, refs[]) → PullRequest or null                              | R   | P275-276 · RT1299, RT1303 |
| `readPullRequestSnapshot`                      | `pull-requests:snapshot`                          | Q   | (projectPath) → PullRequestSnapshot                                        | R   | P277 · RT1321             |
| `listOpenPullRequests`                         | `pull-requests:open`                              | Q   | (projectPath) → PullRequest[]                                              | R   | P278 · RT1342             |
| `onPullRequestsChanged`                        | `pull-requests:changed`                           | E   | {projectPath}                                                              | –   | P279 · RT1296             |
| `pr.detail`                                    | `pr:detail`                                       | Q   | {cwd, number} → PullRequestDetailResult                                    | R   | P295 · GI92               |
| `pr.diffFiles`, `pr.diffFile`                  | `pr:diff-files`, `pr:diff-file`                   | Q   | {cwd, base, head[, path, oldPath?]}                                        | R   | P296-297 · GI93-94        |
| `pr.comment`, `pr.reply`, `pr.deleteComment`   | `pr:comment`, `pr:reply`, `pr:delete-comment`     | Q   | … → PullRequestWriteResult                                                 | W   | P298-300 · GI97-101       |
| `pr.submitReview`, `pr.resolveThread`          | `pr:submit-review`, `pr:resolve-thread`           | Q   | … → PullRequestWriteResult                                                 | W   | P301-302 · GI102, GI106   |
| `pr.merge`, `pr.ready`                         | `pr:merge`, `pr:ready`                            | Q   | {cwd, number, method, auto?, admin?, disableAuto?} / {cwd, number, draft?} | W   | P303-304 · GI107, GI111   |
| `pr.image`                                     | `pr:image`                                        | Q   | {cwd, url} → {ok, dataUrl}                                                 | R   | P305 · GI115              |
| `pr.labels`, `pr.setLabels`                    | `pr:labels`, `pr:set-labels`                      | Q   | …                                                                          | R/W | P306-307 · GI116-117      |
| `pr.reviewerCandidates`, `pr.requestReviewers` | `pr:reviewer-candidates`, `pr:request-reviewers`  | Q   | …                                                                          | R/W | P308-309 · GI118-119      |

#### Terminals (`terminals.*`, `TerminalApi` in `shared/terminal.ts:22`)

| Call                                       | Channel                                  | Dir     | Args → result                                                              | R/W | Defined                                       |
| ------------------------------------------ | ---------------------------------------- | ------- | -------------------------------------------------------------------------- | --- | --------------------------------------------- |
| `terminals.profiles`, `terminals.setShell` | `terminal:profiles`, `terminal:setShell` | Q       | () / {shell or null} → TerminalProfiles                                    | R/W | P130-131 · RT487                              |
| `terminals.list`                           | `terminal:list`                          | Q       | {chatId} → TerminalList                                                    | R   | P132 · RT485                                  |
| `terminals.open`                           | `terminal:open`                          | Q       | {chatId, cwd?, cols?, rows?} → TerminalInfo                                | W   | P133 · RT487                                  |
| `terminals.read`                           | `terminal:read`                          | Q, poll | {terminalId, after, limit?} → {offset, data, reset, ended}; waits up to 8s | R   | P134 · RT487                                  |
| `terminals.input`, `terminals.resize`      | `terminal:input`, `terminal:resize`      | Q       | {terminalId, data} / {terminalId, cols, rows}                              | W   | P135-136 · RT487                              |
| `terminals.close`                          | `terminal:close`                         | Q       | {terminalId}                                                               | W   | P137 · RT487                                  |
| `onTerminalsChanged`                       | `terminal:changed`                       | E       | {chatId}                                                                   | –   | P139 · RT481                                  |
| `setTerminalFocused`                       | `app:terminal-focused`                   | F       | (bool)                                                                     | –   | P141 · `electron/app-shortcuts.cjs:57` (main) |
| `onCloseFocusedTerminal`                   | `app:close-focused-terminal`             | E       | ()                                                                         | –   | P142 · `electron/app-shortcuts.cjs:75` (main) |

Output and input are UTF-16 strings, not bytes. The host keeps 1 MiB and 10,000 lines per Terminal (`core/terminals.cjs`).

#### Browser

| Call                                                                 | Channel                                                  | Dir | Args → result                                                          | R/W   | Defined                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------- | --- | ---------------------------------------------------------------------- | ----- | ------------------------------------------------------- |
| `browsers.list`, `browsers.attach`, `browsers.detach`                | `browser:list`, `browser:attach`, `browser:detach`       | Q   | {chatId[, browserId]} → BrowserList                                    | R/W   | P119-121 · RT429-431                                    |
| `browsers.open`, `.frame`, `.status`, `.control`, `.input`, `.close` | `browser:*`                                              | Q   | `BrowserApi` in `shared/browser.ts:45` (streamed viewer)               | mixed | P122-127 · RT452 (unused on desktop; the phone uses it) |
| `pageComments.add`, `pageComments.list`                              | `browser-comments:add`, `:list`                          | Q   | {chatId, comments} / {chatId} → SavedPageComment[]                     | W/R   | P114-115 · RT300-301                                    |
| `pageComments.sendFromPage`                                          | `browser-comments:send-from-page`                        | Q   | … → {id}                                                               | W     | P116 · RT305 (unused on desktop)                        |
| `milagreBrowserPanel.partition`                                      | none                                                     | L   | "persist:milagre-browser"                                              | –     | P626                                                    |
| `milagreBrowserPanel.setPages`                                       | `browser-panel:pages`                                    | Q   | ({contentsId, chatKey}[]) → void                                       | W     | P632 · M281 (main)                                      |
| `milagreBrowserPanel.capture`                                        | `browser-panel:capture`                                  | Q   | (contentsId, rect) → PNG data URL or null                              | R     | P634 · M165 (main)                                      |
| `milagreBrowserPanel.remotePartition`                                | `browser-panel:remote-partition`                         | Q   | (chatKey) → partition                                                  | W     | P636 · M291 (main)                                      |
| `milagreBrowserPanel.clearSignIns`                                   | `browser-panel:clear-sign-ins`                           | Q   | (computerId) → {cleared}                                               | W     | P638 · M293 (main)                                      |
| `milagreBrowserPanel.onOpenTab`, `onKey`, `onViewed`, `onOpenUrl`    | `browser-panel:open-tab`, `:key`, `:viewed`, `:open-url` | E   | {from, url} / {from, key} / {from, viewed, viewport?} / {chatKey, url} | –     | P627-630 · main and `electron/browser-guests.cjs`       |

#### Designs and Artifacts

| Call                                                               | Channel                                                                 | Dir | Args → result                                                           | R/W | Defined                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- | --- | ----------------------------------------------------------------------- | --- | -------------------------------------------- |
| `readDesignsEnabled`                                               | `designs:enabled:read`                                                  | Q   | () → {enabled: true} (constant)                                         | R   | P143 · RT285                                 |
| `onDesignsEnabledChanged`                                          | `designs:enabled-changed`                                               | E   | {enabled}; no current emitter                                           | –   | P144                                         |
| `createArtifactPreview`, `releaseArtifactPreview`                  | `artifact-preview:register`, `:release`                                 | Q   | (html, {chatId?, assets?, inline?}) → `milagre-artifact://` URL / (url) | W   | P145-146 · M202, M217 (main)                 |
| `artifacts.get`                                                    | `artifact:get`                                                          | Q   | {chatId, id, version?, fonts?} → Artifact                               | R   | P154 · RT287                                 |
| `artifacts.list`                                                   | `artifact:list`                                                         | Q   | {chatId, format?} → ArtifactSummary[]                                   | R   | P156 · RT289                                 |
| `artifacts.apply`                                                  | `artifact:apply`                                                        | Q   | {chatId, id, expectedVersion, operations, intent?} → DesignArtifact     | W   | P157 · RT290                                 |
| `artifacts.delete`                                                 | `artifact:delete`                                                       | Q   | {chatId, id}                                                            | W   | P158 · RT291                                 |
| `artifacts.addComments`, `artifacts.comments`                      | `artifact:add-comments`, `artifact:comments`                            | Q   | … → ArtifactComment[]                                                   | W/R | P159-160 · RT292-293                         |
| `artifacts.asset`                                                  | `artifact:asset`                                                        | Q   | {chatId, name, offset?, length?} → chunk                                | R   | P155 · RT288 (main uses it for the protocol) |
| `artifacts.sharingStatus`, `.allPageShares`, `.pageShares`         | `artifact:sharing-status`, `:all-page-shares`, `:page-shares`           | Q   | …                                                                       | R   | P148, P149, P151 · RT278-280                 |
| `artifacts.sharePage`, `.revokePageShare`, `.revokeSavedPageShare` | `artifact:share-page`, `:revoke-page-share`, `:revoke-saved-page-share` | Q   | … → DesignPageShare or void                                             | W   | P150, P152, P153 · RT281-283                 |

Live design drafts arrive as `agent:event` `step-draft` events, not on their own channel.

#### Simulators, Simlock and computer use

| Call                                                                                        | Channel                                                     | Dir | Args → result                                                           | R/W   | Defined              |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --- | ----------------------------------------------------------------------- | ----- | -------------------- |
| `simulators.list`, `.attach`, `.detach`                                                     | `simulator:list`, `:attach`, `:detach`                      | Q   | {chatId[, deviceId]} → SimulatorList                                    | R/W   | P84-86 · RT360       |
| `simulators.open`, `.frame`, `.offer`, `.status`, `.control`, `.input`, `.repair`, `.close` | `simulator:*`                                               | Q   | `SimulatorApi` in `shared/simulator.ts:50`                              | mixed | P87-94 · RT368       |
| `simlock.readSettings`, `.saveSettings`, `.identity`, `.models`, `.lease`, `.release`       | `simlock:*`                                                 | Q   | `SimlockApi` in `shared/simulator.ts:91`                                | mixed | P105-111 · RT408-416 |
| `simlock.onSettings`                                                                        | `simlock:settings`                                          | E   | SimlockSettings                                                         | –     | P107                 |
| `computerUse.status`, `.saveSettings`, `.guide`, `.frame`                                   | `computer-use:status`, `:settings:save`, `:guide`, `:frame` | Q   | `ComputerUseApi` in `shared/computer-use.ts:38`; `frame` is a long poll | R/W   | P98-102 · RT397-401  |
| `computerUse.onSettings`                                                                    | `computer-use:settings`                                     | E   | ComputerUseSettings                                                     | –     | P99                  |

Simulator, computer-use and terminal frames are all pulled, never pushed.

#### Routines and Heartbeats

| Call                               | Channel                                   | Dir | Args → result                                               | R/W | Defined                |
| ---------------------------------- | ----------------------------------------- | --- | ----------------------------------------------------------- | --- | ---------------------- |
| `readRoutinesEnabled`              | `routines:enabled:read`                   | Q   | () → {enabled}                                              | R   | P234 · RT1814          |
| `listRoutines`                     | `routines:list`                           | Q   | () → {routines with runs}                                   | R   | P235 · RT1942          |
| `createRoutine`                    | `routines:create`                         | Q   | (RoutineCreate) → {routine, hookUrl?}                       | W   | P241 · RT1951          |
| `updateRoutine`, `deleteRoutine`   | `routines:update`, `routines:delete`      | Q   | (id, RoutineUpdate) → Routine / (id) → {removed}            | W   | P236-237 · RT1944-1945 |
| `runRoutineNow`                    | `routines:run-now`                        | Q   | (id) → RoutineRun?                                          | W   | P238 · RT1946          |
| `flowRunAct`, `testFlow`           | `routines:flow-act`, `routines:flow-test` | Q   | (routineId, runId, action, {reason?, note?}) / (id) → {run} | W   | P239-240 · RT1948-1949 |
| `routineTargets`                   | `routines:targets`                        | Q   | () → RoutineTargets                                         | R   | P242 · RT1961          |
| `routineLinearOptions`             | `routines:linear-options`                 | Q   | ({workspace?, team?}) → RoutineLinearOptions                | R   | P243 · RT2073          |
| `routineHook`, `rotateRoutineHook` | `routines:hook`, `routines:rotate-hook`   | Q   | (id) → {url, signed, signingHeader} / {url}                 | R/W | P244-245 · RT1957-1958 |
| `onRoutinesChanged`                | `routines:changed`                        | E   | ()                                                          | –   | P246                   |

#### Settings and preferences

| Call                                                              | Channel                                              | Dir   | Args → result                | R/W | Defined                |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ----- | ---------------------------- | --- | ---------------------- |
| `readContextSettings`, `saveContextSettings`, `onContextSettings` | `context:settings:read`, `:save`, `context:settings` | Q/Q/E | ContextSettings              | R/W | P225-227 · RT1924-1925 |
| `readBabysitSettings`, `saveBabysitSettings`, `onBabysitSettings` | `babysit:settings:read`, `:save`, `babysit:settings` | Q/Q/E | BabysitSettings              | R/W | P228-230 · RT1928-1929 |
| `readDoneSettings`, `saveDoneSettings`, `onDoneSettings`          | `done:settings:read`, `:save`, `done:settings`       | Q/Q/E | DoneSettings                 | R/W | P231-233 · RT1933-1934 |
| `readKeybindings`, `setKeybindingCommand`, `resetKeybindings`     | `keybindings:read`, `:set-command`, `:reset`         | Q     | → KeybindingsState           | R/W | P219-222 · RT1918-1921 |
| `onKeybindings`                                                   | `keybindings:changed`                                | E     | KeybindingsState             | –   | P223                   |
| `openKeybindingsFile`                                             | `app:open-keybindings-file`                          | Q     | ()                           | –   | P224 · M647 (main)     |
| `readDeviceNotesEnabled`, save, on…                               | `device-notes:read`, `:save`, `device-notes:changed` | Q/Q/E | {enabled}                    | R/W | P363-365 · RT1475-1478 |
| `setKeepAwake`                                                    | `app:set-keep-awake`                                 | Q     | (bool)                       | W   | P447 · RT1357          |
| `setWindowBackground`                                             | `settings:window-background`                         | Q     | (colour)                     | W   | P457 · M465 (main)     |
| `milagrePreferences.get`, `.set`                                  | `preferences:storage`                                | S     | (key) / (key, value or null) | R/W | P643-644 · M124 (main) |
| `milagrePreferences.onChanged`                                    | `preferences:changed`                                | E     | {key, value}                 | –   | P645 · M143 (main)     |

Most UI preferences (`milagre-settings` and the `milagre.*` keys listed in section 2) live in localStorage, mirrored to
`preferences.json` by main through `milagrePreferences`. The GPUI app needs its own preference store with the same keys.

#### Accounts, usage and limits

| Call                                                              | Channel                                                   | Dir | Args → result                                                      | R/W | Defined                       |
| ----------------------------------------------------------------- | --------------------------------------------------------- | --- | ------------------------------------------------------------------ | --- | ----------------------------- |
| `listAccounts`                                                    | `accounts:list`                                           | Q   | (refresh?) → AccountsSnapshot                                      | R   | P442 · RT2010                 |
| `accountAction`                                                   | `accounts:add`, `:select`, `:login`, `:cancel`, `:remove` | Q   | (action, provider, value) → AccountsSnapshot                       | W   | P443 · RT2013                 |
| `onAccountsChanged`                                               | `accounts:changed`                                        | E   | ()                                                                 | –   | P444 · RT2004                 |
| `listAccountScopes`, `getProjectAccounts`, `assignProjectAccount` | `accounts:scopes`, `accounts:scope`, `accounts:assign`    | Q   | → scopes / (scopeKey, refresh?) / (scopeKey, provider, id or null) | R/W | P402-404 · RT3308, 3340, 3343 |
| `getModels`, `getCliStatus`                                       | `agent:models`, `agent:cli-status`                        | Q   | (scopeKey?) → AgentModels / AgentCliStatus                         | R   | P405-406 · RT2510, RT2483     |
| `readUsage`, `getCachedUsage`                                     | `usage:read`, `usage:cached`                              | Q   | (scopeKey?) → UsageSnapshot                                        | R   | P446, P448 · RT2091, 2100     |
| `readAccountUsage`, `getCachedAccountUsage`                       | `usage:accounts:read`, `usage:accounts:cached`            | Q   | () → UsageSnapshot                                                 | R   | P449-450 · RT2148, 2154       |
| `onUsageChanged`                                                  | `usage:changed`                                           | E   | {scopeKey?}                                                        | –   | P445                          |
| `readTokenUsage`, `onTokenUsageChanged`                           | `token-usage:read`, `token-usage:changed`                 | Q/E | (TokenUsageRequest) → TokenUsageReport                             | R   | P451-452 · RT2195             |
| `readLimitAutoSwitch`, save                                       | `limits:auto-switch:read`, `:save`                        | Q   | {autoSwitch}                                                       | R/W | P206-207 · RT3350-3351        |
| `readLimitResumeAtReset`, save                                    | `limits:resume-at-reset:read`, `:save`                    | Q   | {resumeAtReset}                                                    | R/W | P208-209 · RT3379-3380        |
| `switchAccountAfterLimit`                                         | `chat:limit-switch`                                       | Q   | (path, sessionId, provider, accountId) → {continued, label}        | W   | P385 · RT3345                 |
| `scheduleLimitResume`, `cancelLimitResume`                        | `chat:limit-resume`, `chat:limit-resume:cancel`           | Q   | (path, sessionId, id) → boolean                                    | W   | P386-387 · RT3384, 3389       |
| `readComputerResources`                                           | `computer:resources:read`                                 | Q   | ({fresh?}) → ComputerResources                                     | R   | P216 · RT1827                 |

#### Computers, phone pairing and Links

| Call                                                                                       | Channel                                                               | Dir   | Args → result                                           | R/W | Defined                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----- | ------------------------------------------------------- | --- | ---------------------------------------------------- |
| `on(computerId)`                                                                           | none                                                                  | L     | → the same bridge for a paired computer                 | –   | P562-576                                             |
| `computers.list`, `.preview`                                                               | `computers:list`, `computers:preview`                                 | Q     | () → ComputersSnapshot / (link) → ComputerPreview       | R   | P589-590 · CI77, CI81                                |
| `computers.add`                                                                            | `computers:add`                                                       | Q     | (link, {name?}) → AddComputerResult                     | W   | P591 · CI83 (main unlocks the key vault first, M602) |
| `computers.cancelAdd`, `.rename`, `.remove`, `.setEnabled`                                 | `computers:cancel-add`, `:rename`, `:remove`, `:set-enabled`          | Q     | …                                                       | W   | P592-595 · CI104-115                                 |
| `computers.invoke`                                                                         | `computers:invoke`                                                    | Q     | (id, method, args) → any                                | any | P596 · CI122                                         |
| `computers.remember`, `.recall`, `.note`                                                   | `computers:remember`, `:recall`, `:note`                              | Q     | offline copy of a computer's states and Chats           | W/R | P597-599 · CI173, CI204, CI198                       |
| `onComputersChanged`, `onComputerAddPending`, `onComputerEvent`                            | `computers:changed`, `computers:pending`, `computers:event`           | E     | ComputersSnapshot / () / {computerId, channel, payload} | –   | P601-603 · CI218, CI90, CI227                        |
| `getPhoneStatus`, `setPhoneEnabled`, `setPhoneLan`, `resetPhoneAccess`, `openPhonePairing` | `phone:status`, `:set-enabled`, `:set-lan`, `:reset`, `:open-pairing` | Q     | → PhoneStatus                                           | R/W | P429-433 · SV818-844                                 |
| `onPhoneStatus`                                                                            | `phone:status`                                                        | E     | PhoneStatus                                             | –   | P441 · SV586                                         |
| `listDevices`, `removeDevice`, `acknowledgeDevices`                                        | `devices:list`, `:remove`, `:acknowledge`                             | Q     | → PairedDevice[]                                        | R/W | P434-436 · SV845-856                                 |
| `listPendingDevices`, `allowDevice`, `denyDevice`, `onDevicesPending`                      | `devices:pending`, `:allow`, `:deny`; event `devices:pending`         | Q/E   | → PendingComputer[]                                     | R/W | P437-440 · SV857-859, SV589                          |
| `listNamedLinks`, `createNamedLink`, `updateNamedLink`                                     | `link:list`, `:create`, `:update`                                     | Q     | → NamedProjectLink(s)                                   | R/W | P339-341 · LR105-108                                 |
| `checkDeleteNamedLink`, `deleteNamedLink`                                                  | `link:delete-check`, `link:delete`                                    | Q     | (id) → check / deleted                                  | R/W | P342-343 · LR137, LR146                              |
| `openNamedLink`, `readLink`                                                                | `link:open`, `link:snapshot`                                          | Q     | (id) → OpenLink with stamp / {link, state} with stamp   | W/R | P344-345 · LR178-179                                 |
| `getCanvas`, `getLinks`                                                                    | `canvas:snapshot`, `canvas:links`                                     | Q     | () → CanvasSnapshot / ProjectLink[]                     | R   | P350, P354 · RT3396, RT3440                          |
| `addLink`, `removeLink`, `restoreLink`                                                     | `canvas:link-add`, `:link-remove`, `:link-restore`                    | Q     | → ProjectLink[]                                         | W   | P351-353 · RT3429-3431                               |
| `onLinksChanged`                                                                           | `canvas:links-changed`                                                | E     | {links}                                                 | –   | P355 · RT2713                                        |
| `grantDelegations`                                                                         | `linked:grant`                                                        | Q     | (chatKey, linkId)                                       | W   | P356 · RT3450                                        |
| `setWorktreePosition`, `openCanvasProject`                                                 | `canvas:worktree-position`, `canvas:open-project`                     | Q     | … / (path) → OpenProject with stamp                     | W   | P357-358 · RT3451-3452                               |
| `getLinkedWork`, `onLinkedWork`                                                            | `linked:snapshot`, `linked:changed`                                   | Q/E   | LinkedWork                                              | R   | P359, P368 · RT3157                                  |
| `stopNegotiation`                                                                          | `linked:stop-negotiation`                                             | Q     | (id)                                                    | W   | P366 · RT3187                                        |
| `readRemoteDelegationEnabled`, save, on…                                                   | `linked:remote-enabled:read`, `:save`, `…-changed`                    | Q/Q/E | {enabled}                                               | R/W | P360-362 · RT3158-3161                               |

#### Updates (app and provider CLIs)

| Call                                                     | Channel                                                            | Dir   | Args → result                                                    | Defined                            |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ----- | ---------------------------------------------------------------- | ---------------------------------- |
| `getUpdateState`, `checkForUpdates`, `installUpdate`     | `update:state`, `update:check`, `update:install`                   | Q     | → UpdateState                                                    | P422, P424, P427 · M238-250 (main) |
| `getUpdateReleaseNotes`                                  | `update:release-notes`                                             | Q     | (version) → markdown                                             | P423 · M241 (main)                 |
| `getReleaseChannel`, `setReleaseChannel`                 | `update:channel`, `update:set-channel`                             | Q     | stable or beta                                                   | P425-426 · M242-244 (main)         |
| `onUpdateState`                                          | `update:state`                                                     | E     | UpdateState                                                      | P428 · M235 (main)                 |
| `readAutoUpdate`, `saveAutoUpdate`, `onAutoUpdate`       | `app-update:auto:read`, `:save`, `app-update:auto`                 | Q/Q/E | {autoUpdate}                                                     | P210-212 · RT1818-1819             |
| `readHostUpdate`, `checkHostUpdate`, `installHostUpdate` | `app-update:state`, `:check`, `:install`                           | Q     | → HostUpdate (the daemon calls back through `desktop:request`)   | P213-215 · SV861                   |
| `getAppVersion`                                          | `app:version`                                                      | Q     | → string                                                         | P180 · M645 (main)                 |
| `getProviderUpdates`, `updateCli`, `onCliProgress`       | `agent:provider-updates`, `agent:update-cli`, `agent:cli-progress` | Q/Q/E | → ProviderUpdate[] / (provider, version?) → result / CliProgress | P407-408, P411 · RT2481-2495       |

#### Files, attachments, images and media

| Call                                      | Channel                                  | Dir | Args → result                                                                                | R/W | Defined                      |
| ----------------------------------------- | ---------------------------------------- | --- | -------------------------------------------------------------------------------------------- | --- | ---------------------------- |
| `getPathForFile`                          | none (`webUtils`)                        | L   | (File) → path                                                                                | –   | P166                         |
| `readAttachment`, `readAttachmentChunk`   | `attachment:preview`, `attachment:read`  | Q   | (file) → {text, binary, truncated} / (file, offset, version?)                                | R   | P167-168 · RT808, RT812      |
| `uploadAttachment`                        | `attachment:upload`                      | Q   | ({projectPath, name?, base64?, reuse?, transferId?, offset?, totalBytes?}) → {file?, error?} | W   | P487 · RT767                 |
| `readMedia`                               | `media:read`                             | Q   | ({scope, path}) → bytes for a remote Chat's media                                            | R   | P320 · SV885                 |
| protocol `milagre-media://file/?path=`    | custom protocol                          | –   | local images and video with Range support                                                    | R   | M498 (main)                  |
| protocol `milagre-artifact://`            | custom protocol                          | –   | registered preview pages and their assets                                                    | R   | M220 (main)                  |
| `copyImage`, `saveImage`, `showImageMenu` | `image:copy`, `image:save`, `image:menu` | Q   | (file[, name]) → void / path or null / void (native menu)                                    | –   | P281-283 · M363-365 (main)   |
| `listEditors`, `openInEditor`             | `editor:list`, `editor:open`             | Q   | → EditorInfo[] / ({root, path?, line?, editor?}) → result                                    | –   | P311-312 · M385, M394 (main) |

#### Notifications, inbox and the floating window

The floating inbox is a second window loading the same renderer with `?floating-inbox=<view>` (`main.cjs:152-163`).
Every row here is main-local.

| Call                                                                      | Channel                                                                               | Dir   | Payload                                                                           | Defined                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------- | -------------------------- |
| `syncNotifications`                                                       | `notification:state`                                                                  | Q     | ({projectPath, activeChatId, unread, notifyOnCompletion, showDockBadge, hidden?}) | P458 · M457                |
| `notifyCompletion`                                                        | `notification:completed`                                                              | Q     | ({chatId, title}) → boolean                                                       | P484 · M462                |
| `setNotifyWhenWaiting`, `setNotificationChime`, `setNotificationSchedule` | `settings:notify-when-waiting`, `:notification-chime`, `:notification-schedule`       | Q     | bool / chime / schedule or null                                                   | P453-455 · M449-455        |
| `onPlayChime`, `onOpenChat`, `onOpenExperimental`, `onOpenPhoneSettings`  | `notification:play-chime`, `:open-chat`, `:open-experimental`, `:open-phone-settings` | E     | chime / chatKey / ()                                                              | P456, P483-486 · M188-431  |
| `getInbox`                                                                | `floating-inbox:snapshot`                                                             | Q     | → InboxSnapshot (merges `chat:inbox` from every online computer)                  | P459 · M664                |
| `setFloatingInbox`, `toggleFloatingInbox`, `closeFloatingInbox`           | `settings:floating-inbox`, `floating-inbox:toggle`, `:close`                          | Q     | bool / ()                                                                         | P460-461, P468 · M166-172  |
| `selectInboxItem`, `getSelectedInboxItem`, `onSelectedInboxItem`          | `floating-inbox:select`, `:selected`, `:selection`                                    | Q/Q/E | key                                                                               | P462-464 · M168-169, FI352 |
| `getFloatingInboxOpen`, `onFloatingInboxOpen`                             | `floating-inbox:is-open`, `:open`                                                     | Q/E   | bool                                                                              | P465-466 · M170, FI224     |
| `expandFloatingBar`, `resizeFloatingBar`, `resizeFloatingInbox`           | `floating-inbox:dock-expanded`, `:count`, `:height`                                   | Q     | (on, reducedMotion) / count / (height, reducedMotion)                             | P467, P469-470 · M171-181  |
| `showInboxPreview`, `getInboxPreviewKey`, `onInboxPreview`                | `floating-inbox:preview`, `:preview-key`, `:preview`                                  | Q/Q/E | key or null, position                                                             | P471-473 · M173-174, FI415 |
| `getFloatingPlacement`, `onFloatingPlacement`                             | `floating-inbox:placement`                                                            | Q/E   | left, right or bottom                                                             | P474-475 · M175, FI108     |
| `beginFloatingDrag`, `moveFloatingDrag`, `endFloatingDrag`                | `floating-inbox:drag-begin`, `:drag-move`, `:drag-end`                                | Q     | (reducedMotion) / () / (cancel?)                                                  | P476-478 · M176-178        |
| `getFloatingDragOverlay`, `onFloatingDragOverlay`                         | `floating-inbox:drag-overlay`                                                         | Q/E   | FloatingDragOverlay or null                                                       | P479-480 · M179, FI140     |
| `openInboxChat`, `openInboxSettings`                                      | `floating-inbox:open-chat`, `:settings`                                               | Q     | key / ()                                                                          | P481-482 · M182-186        |

#### Window, app chrome and shortcuts

| Call                                          | Channel                             | Dir | Payload                                                    | Defined                                |
| --------------------------------------------- | ----------------------------------- | --- | ---------------------------------------------------------- | -------------------------------------- |
| `getRuntimeConnection`, `onRuntimeConnection` | `runtime:connection`                | Q/E | {connected, message?, hostOutdated?, notice?, failed?}     | P162, P164 · M471                      |
| `restartHost`                                 | `runtime:restart-host`              | Q   | ()                                                         | P163 · M689 (main)                     |
| `onAppShortcut`                               | `app:shortcut`                      | E   | {key, code, meta, control, alt, shift} from embedded pages | P367 · `electron/app-shortcuts.cjs:85` |
| `retryQuit`, `onQuitFailed`                   | `app:retry-quit`, `app:quit-failed` | Q/E | () / message                                               | P371-372 · M842, M818                  |
| `milagreWindowChrome.controls`                | argv                                | L   | leading, overlay or external                               | P617-618                               |
| `milagreLaunch.openedProjectsBefore`          | argv                                | L   | bool                                                       | P621                                   |
| internal `app:host-ready`                     | `app:host-ready`                    | Q   | gates every call until the host connects                   | P8 · M497                              |

Quit confirmation, ⌘W and the menus live entirely in main.

#### Dictation (always runs on this computer)

| Call                                                              | Channel                                                               | Dir | Args → result                                                                    | Defined                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------- | -------------------------- |
| `dictationContext`                                                | `dictation:context`                                                   | Q   | ({cwd, chatTitle?, scope?, chatId?}) → {terms}                                   | P172 · RT825               |
| `polishDictation`                                                 | `dictation:polish`                                                    | Q   | ({cwd, text, chatTitle?, provider?, model?, scope?, chatId?}) → {text, polished} | P174 · RT841               |
| `dictation.status`, `.download`, `.cancel`, `.remove`, `.prepare` | `app:dictation-status`, `-download`, `-cancel`, `-remove`, `-prepare` | Q   | → DictationModelState[] / (id)                                                   | P606-610 · M352-356 (main) |
| `dictation.transcribe`                                            | `app:dictation-transcribe`                                            | Q   | ({audio: 16 kHz mono s16 ArrayBuffer, language, prompt, model}) → {text}         | P611 · M357 (main)         |
| `dictation.onModel`                                               | `app:dictation-model`                                                 | E   | DictationModelState                                                              | P612 · M349 (main)         |
| `dictation.openSettings`                                          | `app:dictation-open-settings`                                         | Q   | () opens the system microphone privacy pane                                      | P613 · M358 (main)         |

#### Linear

| Call                                                                | Channel                                                       | Dir | Args → result                                                      | R/W | Defined                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------- | --- | ------------------------------------------------------------------ | --- | ------------------------- |
| `readLinearStatus`                                                  | `linear:status`                                               | Q   | → LinearStatus                                                     | R   | P200 · RT2058             |
| `connectLinear`                                                     | `linear:connect`                                              | Q   | ({window}) → LinearStatus; main runs the sign-in window (M611-630) | W   | P201 · RT2059             |
| `disconnectLinear`                                                  | `linear:disconnect`                                           | Q   | ({workspace}) → LinearStatus                                       | W   | P202 · RT2061             |
| `readLinearEnabled`, `saveLinearEnabled`, `saveLinearMoveToStarted` | `linear:enabled:read`, `:save`, `linear:move-to-started:save` | Q   | → {enabled, moveToStarted?}                                        | R/W | P203-205 · RT2062-2064    |
| `listLinearIssues`                                                  | `linear:issues`                                               | Q   | ({query, fresh, workspace?}) → LinearIssuesResult                  | R   | P271 · RT2074             |
| `readWorktreeLinearIssues`                                          | `linear:worktree-issues`                                      | Q   | (path) → issues by path                                            | R   | P272 · RT2075             |
| `onLinearStatusChanged`, `onLinearEnabledChanged`                   | `linear:status-changed`, `linear:enabled-changed`             | E   | LinearStatus / {enabled}                                           | –   | P269-270 · RT2056, RT2066 |

#### MCP and skills

| Call                                                                                             | Channel                                      | Dir | Args → result                                         | R/W | Defined                      |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------- | --- | ----------------------------------------------------- | --- | ---------------------------- |
| `mcp.accounts`, `.check`, `.definition`                                                          | `mcp:accounts`, `:check`, `:definition`      | Q   | → McpAccount[] / McpAccountCheck / definition or null | R   | P248-250 · RT2040-2042       |
| `mcp.save`, `.saveUrl`, `.remove`, `.toggle`                                                     | `mcp:save`, `:saveUrl`, `:remove`, `:toggle` | Q   | …                                                     | W   | P251-254 · RT2043-2046       |
| `mcp.signIn`, `.cancelSignIn`                                                                    | `mcp:signIn`, `:cancelSignIn`                | Q   | (name, accounts) → {started}                          | W   | P255-256 · RT2047-2048       |
| `mcp.onChanged`                                                                                  | `mcp:changed`                                | E   | McpChangedEvent                                       | –   | P257                         |
| `localMcp.status`, `.create`, `.update`, `.rotate`, `.revoke`, `.enableClient`, `.disableClient` | `local-mcp:*`                                | Q   | `LocalMcpApi` in `shared/local-mcp.ts:28`             | R/W | P260-266 · RT3683            |
| `localMcp.onChanged`                                                                             | `local-mcp:changed`                          | E   | {projectAdded?}                                       | –   | P267                         |
| `listSkills`, `readSkill`                                                                        | `skills:list`, `skills:read`                 | Q   | (path[, file]) → SkillCatalog / text                  | R   | P170-171 · RT872-873         |
| `openSkill`, `revealSkill`                                                                       | `skills:open`, `skills:reveal`               | Q   | ({projectPath, file, editor?})                        | –   | P175-176 · M403, M407 (main) |

#### Checkpoints and undo (`checkpoints.*`, `CheckpointApi` in `shared/checkpoints.ts:28`)

| Call                  | Channel              | Args → result                               | R/W | Defined     |
| --------------------- | -------------------- | ------------------------------------------- | --- | ----------- |
| `checkpoints.list`    | `checkpoint:list`    | {chatId} → Checkpoint[]                     | R   | P375 · CK46 |
| `checkpoints.preview` | `checkpoint:preview` | {chatId, id} → CheckpointPreview            | R   | P376 · CK46 |
| `checkpoints.restore` | `checkpoint:restore` | CheckpointRestore → CheckpointRestoreResult | W   | P377 · CK46 |

#### Host methods the renderer never calls but a GPUI host needs

- Handshake and streaming: `daemon:status`, `daemon:state-patches`, `daemon:snapshot`, `daemon:snapshot-page`,
  `daemon:result-page`, `daemon:focus`, `daemon:flush`, `daemon:stop`, `daemon:authenticate` on Windows
  (`daemon/runtime-client.cjs`, `daemon/client.cjs`).
- Reconnect replays: `project:open`, `link:open`, `chat:set-open`; large states: `project:snapshot`, `link:snapshot`.
- Used by main today: `chat:inbox`, `computers:vault-status`, `computers:unlock`, `computers:import-keys`,
  `computers:browser-pages`, `computers:browser-proxy`, `browser:panel-pages`, `app-update:activity`,
  `link:workspace-roots`, `project:plain-root`, `linear:cancel`, `devices:take-notices`, `devices:confirm-notices`,
  `artifact:asset`, `desktop:register`, `desktop:respond`.
- Events main consumes or nobody listens to: `notification:waiting`, `phone:paired`, `computers:forgotten`,
  `computer-use:cursor`, `terminal:preferences-changed`, `delegation:report`, `daemon:stopping`, `desktop:request`,
  `linear:sign-in-window`.

### 4.5 Main data types the UI renders

| Type                                                                 | Defined                                                         | Fields in brief                                                                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CoordinatorState`                                                   | `shared/model.ts:1294`                                          | persistence, messagesInChats, next_id, projects, worktrees, sessions, messages, tasks                                                                                                                  |
| `OpenProject`                                                        | `shared/model.ts:1313`                                          | path, name, git, kind ("chats" for the Chats home), state, restoredChats                                                                                                                               |
| `StateStamp`, `ProjectRead`, `MessageChanges`, `ChatSearchMatch`     | `app/electron.d.ts:41-52`                                       | {version, epoch}; OpenProject without state plus stamp; changed and removed messages; search hit with snippet                                                                                          |
| `StatePatch`                                                         | `shared/state-patch.d.mts:2`                                    | `{v}`, `{o, d}` or `{a, s}`                                                                                                                                                                            |
| `LinkState`, `OpenLink`, `NamedProjectLink`                          | `shared/model.ts:338`, `:349`, `:289`                           | shared Chats, messages, preparations; {link, state, projects}; {id, name, projectIds, createdAt, hidden}                                                                                               |
| `AgentSession` (a Chat)                                              | `shared/model.ts:155`                                           | worktree, status, summary, provider, subagents, background tasks, plan, title, unread, archived, pinned, done_at, limits, context usage, suggestion, Routine, permission mode, parent (Subchat), queue |
| `ChatSummary`                                                        | `shared/model.ts:127`                                           | count, first and last ids and times, title line, last outcome, PRs, last model, Linear issue                                                                                                           |
| `Worktree`                                                           | `shared/model.ts:106`                                           | id, project, path, branch name, base, Linear issue, diff, shared Chat                                                                                                                                  |
| `ChatMessage`, `ChatContext`, `ChatStep`                             | `shared/model.ts:355`, `:828`, `:921`                           | message with role, context (about 20 kinds), images, files, outcome, steps; step with kind, title, status, timing, detail, file, artifact, source, error                                               |
| `AgentEvent`                                                         | `shared/model.ts:1154`                                          | 27 variants: message-sent, turn-_, text-delta, step-_, permission-_, question-_, subagent-update, plan-updated, context-*, …                                                                           |
| `AgentRun`, `AgentRuns`                                              | `shared/agent-runs.d.mts:21`, `:48`                             | streaming turn per Chat: text, steps, approvals, questions, context usage, timing                                                                                                                      |
| `PermissionRequest`, `QuestionRequest`, `AgentQuestion`              | `shared/model.ts:982`, `:1033`, `:1017`                         | approval card fields; questions with options, secret and bug-report variants                                                                                                                           |
| `Subagent`, `ChatPlan`, `QueuedMessage`, `BackgroundTask`            | `shared/model.ts:1053`, `:1128`, `:247`, `:264`                 | subagent with status and transcript tail; tasks and phases; queued sends; background work                                                                                                              |
| `AgentPort`                                                          | `shared/model.ts:1138`                                          | port, pid, command, address, computer, task                                                                                                                                                            |
| `ChatSendRequest`, `LinkSendRequest`, `WorktreeRequest`              | `shared/model.ts:1238`, `:1421`, `:1283`                        | what a send carries (body, images, files, provider, model, permission, effort, delivery, PR action, Linear issue)                                                                                      |
| `PullRequest`, `PullRequestSnapshot`, `PullRequestDetail`            | `shared/model.ts:79`, `:99`; `shared/pull-request-review.ts:53` | summary, per-folder snapshot, review data                                                                                                                                                              |
| `Routine`, `RoutineRun`, `FlowRun`                                   | `shared/model.ts:716`, `:751`, `:682`                           | trigger, target, schedule, flow; run status and Chat; flow step states                                                                                                                                 |
| `LinkedWork`                                                         | `shared/model.ts:898`                                           | open Delegations, Negotiations, receive-only                                                                                                                                                           |
| `UsageSnapshot`, `AccountsSnapshot`, `AgentCliStatus`, `AgentModels` | `shared/model.ts:1394`, `:1415`, `:67`, `:53`                   | usage windows, accounts, CLI states, model lists                                                                                                                                                       |
| `RuntimeSnapshot`, `RuntimeConnection`, `CanvasSnapshot`             | `app/electron.d.ts:256`, `:255`, `:265`                         | projects, links, runs, ports, eventSeq; connection state; canvas data                                                                                                                                  |
| `InboxSnapshot`, `InboxItem`                                         | `shared/attention.d.mts:62`, `:49`                              | agents and items with status, approval or question                                                                                                                                                     |

### 4.6 Totals and loose ends

- 403 renderer-facing functions: 369 on the bridge (268 top-level, 101 in 12 sub-APIs) plus 34 on the other globals.
  348 are calls and 55 are event listeners.
- 350 call channels (343 literal invoke channels, 5 built from `accounts:${action}`, 1 send, 1 sendSync) and 55 event
  channels. Core registers about 278 command names; the daemon adds its own.
- Defined but unused by the desktop renderer: `resetKeybindingCommand`, `computerUse.readSettings`,
  `pageComments.sendFromPage`, `artifacts.asset` (main uses it), and `browsers.open/frame/status/control/input/close`
  (phone only). `onDesignsEnabledChanged` has no emitter and `readDesignsEnabled` always returns true.
- Untyped or dynamic: `computers.invoke(id, "daemon:status" | "project:recent")` in `c/Settings.tsx:456-457`;
  `accountAction` builds its channel; `c/agents/SimulatorTrack.tsx:468` and `c/agents/BrowserViewer.tsx` call
  `api[method]` from strings.

## 5. Shared TypeScript logic the Rust UI must reproduce or call

There is no TypeScript-to-Rust generation in the repo today; Rust ports are hand-written and checked against Node with
shared vectors (for example `experiments/rust-owner-wire/tests/state-patch-node.mjs`). Already ported:
`shared/state-patch.mjs` (`experiments/rust-owner-wire/src/state_patch.rs`) and `shared/message-search.mjs`
(`experiments/rust-owner/src/search.rs`). DESIGN.md's token tables are pinned to code by
`apps/site/src/design-system.test.ts`; a Rust token table can be added as another source there.

Recommendation key: **Port** to Rust with JSON test vectors emitted from the TS; **Generate** at build time from the TS
source (tables, strings, palettes); **Host** means ask the daemon (it already computes it, or should).

### 5.1 Themes and appearance

| Module                                                   | Lines         | What it computes                                                                                                                                                                               | Recommendation                                                                             |
| -------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `shared/themes/color.ts`                                 | 108           | Hex and OKLab/OKLCH conversion, `mix` (OKLab), `withAlpha`, `over` (sRGB blend), WCAG luminance and contrast, `readableOn` (the contrast solver), `onColor`                                    | Port (about 110 lines). Keep the exact rounding and 8-digit hex output                     |
| `shared/themes/build.ts`                                 | 141           | `buildPalette`: about 40 tokens from 7 seeds; solver bisects 16 times on OKLCH lightness to reach 4.5 (ink-2, ink-3, accent-ink) and 4.8 (status inks on their tints); ANSI and syntax helpers | Generate the 12 themes × 2 schemes as a table; port the builder only for the custom theme  |
| `shared/themes/palettes/{milagre,catppuccin,popular}.ts` | 156, 174, 325 | Seeds of the 12 themes                                                                                                                                                                         | Generate. Never hand-copy hex values (the spike's `theme.rs` does this for one theme)      |
| `shared/themes/custom.ts`                                | 86            | A full source from 3 seeds, validation, contrast readout                                                                                                                                       | Port with G-04                                                                             |
| `shared/themes/{index,registry,types}.ts`                | 51, 9, 83     | `resolvePalette` with fallback to Milagre Blue, `ULTRACODE_PURPLE` override                                                                                                                    | Port (about 40 lines)                                                                      |
| `shared/appearance.mjs`, `shared/tokens.mjs`             | 182, 7        | Size, width, motion and diff-colour option tables and validators; token count formatting                                                                                                       | Generate the tables, port the validators                                                   |
| `lib/theme-sheet.ts`, `lib/appearance.ts`                | 44, 101       | Palette to CSS variables (including `--ansi-N`, `--syntax-*`, 10 `--shiki-*`); appearance to variables; font probe                                                                             | Replace: the palette struct is the theme. Keep the Shiki mapping as the syntax-colour spec |

### 5.2 Looks and copy (state to presentation)

| Module                                                      | Lines    | What it computes                                                                                                                 | Recommendation                                                   |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `shared/model-copy.ts`                                      | 70       | Permission modes and `permissionPresentation`, `UI_COPY`, `EFFORT_COPY`, persistence failure text                                | Generate the strings, port the two functions                     |
| `shared/approval-copy.ts`                                   | 31       | Approval kind, command in title, Always allow label                                                                              | Port                                                             |
| `shared/pr-blockers.ts`, `lib/pr-look.ts`                   | 146, 38  | Blocker order, `pullRequestPresentation`, `PR_TONE`, `pullRequestStatePill`, row PR order, dismissals; icon and colour per state | Port (about 150 lines); replace `pr-look` with an icon table     |
| `shared/pr-action.mjs`                                      | 34       | PR action labels and context                                                                                                     | Port the labels; prompts stay on the host                        |
| `shared/chats.mjs`                                          | 203      | `chatMarkPresentation`, 60-char titles, listed Chats, pin order, optimistic pending Chats, resend memory                         | Port the display parts; port pending Chats with the outbox       |
| `lib/chat-list.ts` (`chatMark`), `shared/chat-activity.mjs` | 110, 251 | Mark priority: asking, waiting, delegated, running, interrupted, background, unread, idle                                        | Port                                                             |
| `shared/chat-row.ts`, `shared/chat-display.ts`              | 41, 72   | Row field toggles and "5m" ages; compact button and tool-call display modes                                                      | Port                                                             |
| `shared/chat-scopes.mjs`                                    | 79       | `presenceTone`; computer-qualified keys and `milagre-link:` keys                                                                 | Port; the key format must match exactly                          |
| `shared/attention.mjs`                                      | 197      | Attention counts, "N waiting", inbox snapshot filters; notification text                                                         | Port the counts; notification text stays on the host             |
| `shared/done.mjs`, `shared/display-clock.ts`                | 51, 74   | Done countdown `H:MM`, retention options; `m:ss` and elapsed formats                                                             | Port                                                             |
| `shared/subchat-states.ts`, `shared/subagent-glance.mjs`    | 212, 131 | Subchat state kinds and summaries; subagent tool summaries                                                                       | Port                                                             |
| `shared/usage.ts`, `shared/usage-limit.mjs`                 | 145, 79  | Usage tones (75% and 90%), reset formats, account groups; limit card text in local time                                          | Port (needs `chrono` with matching local formats)                |
| `shared/chat-summary.mjs`, `shared/linear-issue.mjs`        | 66, 114  | Chat summaries; Linear issue context and prompt                                                                                  | Host (the daemon keeps `session.summary` and writes the context) |
| `lib/new-chat-look.ts`, `c/routines/flow-look.ts`           | 21, 149  | New-Chat heading copy; Flow step icons and colours                                                                               | Port with their surfaces                                         |

### 5.3 Lists and identity

| Module                                                     | Lines   | What it computes                                                                    | Recommendation                                        |
| ---------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `shared/project-list.ts`                                   | 14      | `projectInitial`, `projectAvatarRadius` (16→4, 20 and 24→6, 32 and 40→10, 72→20)    | Port                                                  |
| `shared/project-origin.mjs`                                | 54      | Git remote to `host/owner/repo`, group by origin                                    | Port                                                  |
| `shared/chats-home.mjs`                                    | 26      | Chats home detection and labels                                                     | Port                                                  |
| `shared/file-kinds.mjs`, `shared/file-link.mjs`            | 31, 70  | Extension to badge and colour (`IMAGE_COLOR`); local file links incl. Windows paths | Generate the table; port the link rules               |
| `shared/provider-logos.ts`                                 | 123     | SVG paths for 4 providers and Linear                                                | Generate SVG assets                                   |
| `shared/providers.mjs`, `shared/provider-capabilities.mjs` | 26, 40  | Provider order and names; capability flags (steer, compact, …)                      | Generate or port                                      |
| `shared/model-options.ts`, `shared/kiro-models.mjs`        | 112, 84 | Model catalogue, context windows, effort lists; Kiro credit formatting              | Generate the catalogue; live lists come from the host |
| `shared/antigravity-models.mjs`                            | 106     | Antigravity model families                                                          | Host                                                  |

### 5.4 Text and markdown

| Module                                                                              | Lines        | What it computes                                                                                                                                                            | Recommendation                                              |
| ----------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `shared/streaming-blocks.ts`                                                        | 104          | Splits a live answer at blank lines outside fences; keeps lists together; no split with reference definitions or raw HTML blocks; incremental                               | Port exactly; share test vectors as JSON                    |
| `shared/streaming-markdown.ts`                                                      | 38           | Closes an open `**` or inline code at the end of the live text                                                                                                              | Port exactly                                                |
| `shared/markdown-fence.ts`, `shared/ordered-list.ts`                                | 5, 11        | Markdown fence detection; marker digit width                                                                                                                                | Port                                                        |
| `shared/github-markdown.ts`                                                         | 69           | GitHub PR HTML to markdown                                                                                                                                                  | Port (the phone already renders PR bodies this way)         |
| `shared/prompt-parts.mjs`, `shared/prompt-mentions.mjs`, `shared/prompt-skills.mjs` | 269, 183, 57 | Quotes, mention and skill tokens, prompt title                                                                                                                              | Port (composer and user bubble)                             |
| `lib/editor-model.ts`                                                               | 353          | Composer string model, chip snapping, edit history (DOM parts excluded)                                                                                                     | Port                                                        |
| `shared/message-search.mjs`                                                         | 139          | Fuzzy message search                                                                                                                                                        | Host (`chat:search`; already ported in Rust)                |
| `c/markdown/Markdown.tsx` pipeline                                                  | 395          | react-markdown and remark-gfm; HTML only for PR bodies; fence routing (markdown, mermaid, openui, code); file-link chips; Windows paths through the URL filter; parse cache | Rewrite on pulldown-cmark (GFM options) keeping these rules |
| `c/markdown/highlighter.ts`, `lib/code-languages.ts`                                | 99, 60       | Shiki with 40 lazy languages, one CSS-variable theme, 40,000-char cap; alias table                                                                                          | Replace with syntect; generate the alias table              |
| `shared/file-syntax.mjs`                                                            | 99           | Prism tokens in 11 kinds for the file viewer                                                                                                                                | Replace with the same engine as code blocks                 |

### 5.5 Diffs

| Module                                       | Lines   | What it computes                                                                                                      | Recommendation                             |
| -------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `shared/diff-parse.ts`                       | 48      | One file's unified patch to hunks and numbered lines; hunk length from the header                                     | Port                                       |
| `shared/diff-layout.ts`                      | 94      | Split rows; word changes by LCS over tokens, skipped above 500 characters or below 0.4 similarity; offsets are UTF-16 | Port; convert offsets carefully            |
| `shared/diff-tree.ts`                        | 44      | Folder tree with summed counts; single-child folders merged; folders first, then `localeCompare`                      | Port; match the locale compare             |
| `shared/git-diff.ts`, `shared/git-codes.mjs` | 130, 19 | Diff types, comparison options, labels; git error messages                                                            | Port the formatters; generate the messages |

### 5.6 State plumbing and input

| Module                                                                    | Lines       | What it computes                                                                                             | Recommendation                                            |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `shared/state-patch.mjs`                                                  | 59          | Patch diff and apply                                                                                         | Reuse the Rust port                                       |
| `shared/agent-runs.mjs`                                                   | 527         | Folds `agent:event`s into streaming runs                                                                     | Port with recorded event vectors                          |
| `shared/chat-window-cache.ts`, `shared/chat-history.ts`                   | 120, 31     | Message window cache; prompt history                                                                         | Port                                                      |
| `shared/outbox.mjs`, `shared/outbox-delivery.ts`, `shared/send-retry.mjs` | 233, 55, 49 | Offline outbox phases, idempotent delivery, retry delays (1 to 30s, 10 min budget, matched on error strings) | Port with K-15 (or host it if the daemon gains an outbox) |
| `shared/queued-messages.mjs`, `shared/stable-order.mjs`                   | 28, 16      | Queue status text; keep shown order                                                                          | Port                                                      |
| `shared/undo-history.ts`                                                  | 127         | ⌘Z history for the Chat list and its toast                                                                   | Port                                                      |
| `shared/keybindings.mjs`                                                  | 485         | Command catalogue (about 33), key parsing, `when` expressions, last match wins, conflicts                    | Generate the catalogue; port the parser and evaluator     |
| `shared/settings-search.ts`, `lib/settings-index.ts`                      | 123, 735    | Accent-folded ranking; about 132 index rows                                                                  | Port the ranker; generate the index with row ids          |
| `shared/voice-dictation.ts`, `shared/voice-stream.ts`                     | 218, 223    | Dictation state machine and take editing; streaming segmentation and resampling                              | Port with K-06                                            |

### 5.7 Large modules to size, not port now

| Module                                                                                                    | Size                                                | Note                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `shared/routine-form.mjs`, `shared/routine-flows.mjs`, `shared/routine-prompt.mjs`, `shared/routines.mjs` | 370, 714, 142, 661                                  | Form state, cron, flow step operations, placeholders, Run text. Port with R-04 and R-06; the daemon validates too      |
| `shared/design*.mjs`                                                                                      | about 3,900 lines plus 730 KB of font and icon data | A full layout engine with font metrics, lint, SVG output and live drafts. Do not port; ask the host for layout and SVG |
| `shared/html-render.mjs`, `shared/artifact-document.mjs`                                                  | 252, 302                                            | Strings for the webview pages; generate at build time                                                                  |
| `shared/genui.ts`                                                                                         | 231                                                 | Wraps `@openuidev/lang-core`; defer (N-12)                                                                             |
| `shared/simulator-receiver.mjs`, `shared/browser-receiver.mjs`                                            | 1,027, 739                                          | Web viewers; the geometry and input mapping must be ported for P-18 and P-12                                           |

### 5.8 Ten modules to get exactly right

1. `shared/themes/color.ts` and `build.ts` (every colour, the contrast floors).
2. The 12 theme palettes and the `ULTRACODE_PURPLE` override.
3. `shared/streaming-blocks.ts` and `streaming-markdown.ts` (what stays stable while text streams).
4. The markdown rules: GFM, file-link chips, Windows paths, fence routing, the 40,000-char highlight cap.
5. `shared/pr-blockers.ts` (badges in the sidebar, header and tabs).
6. `shared/chats.mjs`, `chatMark` and `shared/chat-activity.mjs` (row state, titles, pins, pending Chats).
7. `shared/chat-scopes.mjs` (computer-qualified keys; a wrong key breaks every paired computer).
8. `shared/diff-parse.ts` and `diff-layout.ts` (line numbers, pairing, the 500-char and 0.4 thresholds).
9. `shared/state-patch.mjs` (already ported; depth 4 and array rules).
10. `shared/keybindings.mjs` (defaults, canonical keys, `when`, last match wins).

## 6. Work packages

### Decisions to make first

| ID  | Decision             | Options                                                                                                         | Recommendation                                                                    | Blocks |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| D1  | Web content engine   | wry child views; CEF; no inline web content                                                                     | wry for Artifacts, then inline HTML replies                                       | WP-34  |
| D2  | Browser panel        | wry tab (no CDP); CEF; streamed viewer over the host's `browser:*` API; default browser                         | Streamed viewer for agent and attached pages; default browser for user tabs in v1 | WP-35  |
| D3  | Simulator stream     | Frame relay; VideoToolbox H.264; webrtc-rs                                                                      | Frame relay, then H.264; drop WebRTC                                              | WP-37  |
| D4  | Design editor in v1  | Native rewrite; webview; leave out                                                                              | Leave out of v1                                                                   | WP-55  |
| D5  | GPUI version         | Decided 2026-11-11 (spike README): `gpui-pre` 0.3.12 with `gpui-component` 0.9.1; fallback a pinned Zed git rev | Upgrade `gpui-pre` and `gpui-component` together, once per wave at most           | done   |
| D6  | Scope of sync        | Does a GPUI desktop change need a phone change; which React commit is the target                                | Freeze a target commit per wave; GPUI-only changes need no phone change           | All    |
| D7  | Accessibility        | AccessKit roles from the start in every package; or a later pass                                                | Roles from the start (cheap per element, expensive to retrofit)                   | All    |
| D8  | `gpui-component` use | Adopt widgets and re-skin them; wrap them; write our own                                                        | Decide per widget from WP-01's table                                              | Wave 1 |

### Target crate layout

What exists at `6b521fb6` is marked "(exists)"; everything else is new. "In progress" marks files another agent was writing, uncommitted, at the time. Generators go in `tools/`, where
`tools/gen-icons.mjs` already is.

```
experiments/rust-gpui/
  tools/              node generators (exists: gen-icons.mjs); add themes, UI copy, keybindings, languages, method table, test vectors
  assets/             (exists) icons, provider logos; add pre-rendered images
  src/
    main.rs lib.rs app.rs   (exists) startup, windows, global actions, keymap
    testing/                (exists) headless helpers; add FixtureSource hooks
    theme/                  (exists: colors, typography, metrics; elevation in progress) add generated themes, resolve, appearance, component bridge
    assets/                 (exists) AssetSource and the embedded table
    ui/                     (exists: icon, icon_name, provider_logo, spinner_ring; in progress: button, checkbox, chip, labels, tabs, scroll_area, tooltip)
    motion/                 springs, tweens, morph, motion scale
    text/                   input, text area, selection, find, prompt_editor/
    markdown/               parse, stream, render, code, highlight, diagram, genui (move workspace/chat/markdown.rs here)
    logic/                  ports of packages/shared, one file per TS module
    data/                   (exists: fixture.rs, model.rs) add transport, source, native, api/<domain>.rs, store/, runs, chat_windows
    platform/               dialogs, editors, clipboard, notify, prefs, audio, whisper, webview, video, updates
    workspace/              (exists: mod.rs, chrome.rs, tests.rs) shell: layout, top bar, routing
    workspace/sidebar/      (exists: mod.rs, row.rs, bottom.rs, tests.rs)
    workspace/chat/         (exists: transcript.rs, composer.rs, markdown.rs, fixture.rs) add transcript/, cards/, composer/, pills/
    workspace/panel/        (exists: mod.rs, tests.rs) add dock, changes/, diff/, pr/, terminal/, browser/, designs/, artifacts/, simulator/
    workspace/grid/  workspace/link/
    canvas/  settings/  routines/  inbox/
    overlays/               palette, dialogs/, onboarding/, notices/
```

Rules that keep parallel packages from colliding:

- A package creates only the files it owns and adds one `mod` line to its parent `mod.rs`.
- Theme tokens change only in `src/theme/` (WP-02). Others ask for a token instead of adding one.
- WP-04 scaffolds `src/data/api/<domain>.rs` for every domain in section 4.4; after that, each domain file belongs to
  the package that uses it first (named under "Owns").
- Test fixtures live in `tests/fixtures/<package>/`.
- Packages that grow an existing file (the spike's `transcript.rs`, `composer.rs`, `markdown.rs`, sidebar and panel
  files) own it from then on; two packages never edit the same existing file in the same wave.
- Every adopted `gpui-component` widget is themed through `src/theme/` (WP-02), never with its default theme.

Verification tools every package can use: GPUI's headless test platform (`#[gpui::test]`, `TestAppContext`,
`debug_selector`, simulated clicks and keys), the snapshot mode (`MILAGRE_GPUI_SNAPSHOT`), JSON vectors emitted from the
TS source by `tools/`, the `FixtureSource`, and for integration the isolated server in `experiments/rust-runtime`
(fresh temporary profile, copied fixtures, never the real profile).

### Wave 0: foundations

The crate layout and test harness are done (`93fa0fe8`), the GPUI version is decided (`997af8b5`), the full Milagre
Blue token set is in `src/theme/` (`50ad41a2`) and Hugeicons with provider logos are generated (`6b6ca9e8`). Wave 0
therefore starts with the `gpui-component` fit check.

**WP-01 `gpui-component` fit check** · Opus · M

- Goal: for each candidate in section 3.1, mount it in a probe view fed by fixtures and record adopt, wrap or own
  against the surfaces it could serve: `TextView` against the markdown rules in 5.4 (file-link chips, fence routing,
  `splitStreamingBlocks` parity, selection across messages, copy of chips as tokens); `Textarea` and `input/token.rs`
  against K-01; `diff` against P-06 and P-07; `highlighter` against Shiki's colour buckets; `DockArea` and
  `resizable` against P-01; `virtual_list` against T-01 anchoring; menus, dialogs and tooltips against the dismissal
  rules of `lib/use-dismiss.ts`; `speech` against K-06. Output: a decision table appended to this file (D8).
- Surfaces: none directly. Owns: `src/testing/probes/` (deleted after), the D8 table.
- Depends on: nothing beyond the current crate.
- Verify: each verdict cites a headless test or a snapshot in the probe.

**WP-02 Theme engine, tokens and component theme bridge** · Sonnet · L

- Goal: replace the hand-copied palette with one generated from `shared/themes` for all 12 themes × 2 schemes; port
  `color.ts`, the resolver and the custom-theme builder; motion and blur tokens (with the no-blur fallback);
  appearance options (chat size, code size, sidebar delta, motion scale, chat width, fonts, diff colours); feed
  `gpui_component::Theme` from these tokens so adopted widgets match DESIGN.md.
- Surfaces: foundation for all. Owns: `src/theme/*` (exists), `tools/gen-themes.mjs`.
- Depends on: WP-01 (which widgets need theming).
- Verify: Rust vs TS palette parity for every theme and scheme; the existing DESIGN.md token tests; contrast floors;
  snapshots of adopted widgets in both schemes.

**WP-03 Icons and logos** · done in `6b6ca9e8`

- `tools/gen-icons.mjs` writes the Hugeicons the desktop uses and the provider marks from `shared/provider-logos.ts`;
  `src/assets/` serves them; `src/ui/icon.rs`, `provider_logo.rs` and `spinner_ring.rs` draw them. Re-run the tool when
  a package needs an icon the desktop did not use before.

**WP-04 Daemon transport and DataSource** · Opus · L

- Goal: extract `experiments/rust-desktop/src/transport.rs` into a Tauri-free client (handshake, paging, deadlines,
  32-request cap, reconnect with snapshot replay); the `DataSource` and `NativeHost` traits; a generated method table
  from `electron/preload.cjs` and `app/electron.d.ts`; typed structs for the hot types in 4.5; `FixtureSource`.
- Surfaces: section 4. Owns: `src/data/{transport,source,native,fixture}.rs`, `src/data/api/` (scaffold), `tools/gen-methods.mjs`.
- Depends on: nothing; the transport does not depend on the UI.
- Verify: unit tests against a fake socket (paging, timeouts, cap); integration against `experiments/rust-runtime`.

**WP-05 State sync store** · Opus · L

- Goal: held states per scope with version and epoch, patch apply (reuse `rust-owner-wire/src/state_patch.rs`),
  resync and re-read (3 tries, 3s), agent events held behind a re-read, `runtime:snapshot`, lean states, remote
  computers and key qualification; GPUI entities that views subscribe to.
- Surfaces: C-08, C-09 data. Owns: `src/data/store/*`, `src/logic/chat_scopes.rs`.
- Depends on: WP-04.
- Verify: replay recorded event sequences (gaps, new epoch, oversized patch) and compare with `lib/state-events.ts` output.

**WP-06 Chat windows and runs** · Opus · L

- Goal: per-Chat message windows (20 turns, 8 Chats, 8 MiB, load earlier and all, `MessageChanges`, reset), the
  `agent-runs.mjs` reducer with `seq` skipping, remote warm-up from `computers:recall`.
- Surfaces: T-01 data, T-05 data. Owns: `src/data/chat_windows.rs`, `src/data/runs.rs`.
- Depends on: WP-05.
- Verify: TS-recorded event streams replayed through the Rust reducer give identical runs.

Parallel: WP-01 and WP-04 start at once; WP-02 follows WP-01; WP-05 then WP-06 follow WP-04.

### Wave 1: UI kit, logic and text

**WP-07 Primitives: controls and display** · Sonnet · L

- Goal: Button and IconButton, Checkbox, RadioGroup, Chip, Segmented, Tabs with roving focus, ResizeHandle and the
  display primitives (EmptyState, InlineError, ProgressBar, ProjectAvatar, SectionLabel, Skeleton, SpinnerRing,
  TranscriptDivider, ZoomBar, CopyButton, ShortcutKeys).
- Surfaces: U-01, U-02, U-03, U-05, U-13, U-15. Owns: `src/ui/{button,checkbox,radio,chip,segmented,tabs,resize_handle,empty_state,inline_error,progress,project_avatar,section_label,skeleton,spinner,divider,zoom_bar,copy_button,shortcut_keys}.rs`.
- Depends on: WP-01, WP-02. When this map was written another agent was writing `src/ui/{button,checkbox,chip,labels,tabs,scroll_area,tooltip}.rs` (uncommitted); coordinate with it before dispatching WP-07, WP-08 or WP-10.
- Verify: a gallery view snapshot in both schemes; keyboard tests for roving focus.

**WP-08 Overlay layer** · Opus · L

- Goal: anchored popovers and menus (flip, clamp, roving, the `useDismiss` rules), Select with search and groups,
  Picker, Tooltip with delay and ⌘-held hints, modal Dialog (scrim, focus trap and restore, Escape routing,
  must-answer), the toast layer above dialogs, the Notice card.
- Surfaces: U-06, U-07, U-08, U-09, U-10, O-15. Owns: `src/ui/{popover,menu,select,picker,tooltip,dialog,toast,notice}.rs`, `src/ui/layer.rs`.
- Depends on: WP-07 (Button; can start against a stub).
- `gpui-component`: `Popover`, `PopupMenu`, `ContextMenu`, `Dialog`, `Tooltip` and `native_menu` are candidates (D8); keep the `useDismiss` rules either way.
- Verify: headless tests for dismissal (outside press, window blur, Escape), focus return, flip near edges.

**WP-09 Text inputs** · Opus · L

- Goal: a reusable single-line input and an auto-growing multi-line text area from the spike's `composer.rs`: IME,
  selection, clipboard, undo, word movement, double-click select, caret blink, password mode, placeholder.
- Surfaces: U-04 and every text field. Owns: `src/text/{input,text_area}.rs`, `src/ui/field.rs`.
- Depends on: WP-02.
- `gpui-component`: `Input` and `Textarea` are candidates (D8); this package then becomes theming, password mode and tests.
- Verify: headless tests driving the input handler (marked text, dead keys), undo coalescing, paste of multi-line text.

**WP-10 Scroll, slider and motion** · Opus · M

- Goal: ScrollArea (overlay thumb while scrolling, edge fades, chaining), RangeSlider (ticks, spring handle, keys),
  StatusPill (rolling digits), the morph helper used by pills and the update card, springs and tweens scaled by motion
  scale with reduced motion.
- Surfaces: U-11, U-12, U-14, U-16. Owns: `src/motion/*`, `src/ui/{scroll_area,range_slider,status_pill}.rs`.
- Depends on: WP-02.
- `gpui-component`: `scroll` and `slider` are candidates (D8).
- Verify: deterministic animation tests with a fake clock; snapshot at fixed times.

**WP-11 Logic ports: lists, marks and identity** · Sonnet · L

- Goal: port `chats.mjs` (display parts), `chatMark`, `chat-activity.mjs`, `chat-row.ts`, `chat-display.ts`,
  `done.mjs`, `display-clock.ts`, `project-list.ts`, `project-origin.mjs`, `chats-home.mjs`, `providers.mjs`,
  `provider-capabilities.mjs`, `stable-order.mjs`, `undo-history.ts`, `chat-pins.ts`, `subchats.ts`.
- Surfaces: logic behind the sidebar (S rows) and views (V rows). Owns: `src/logic/` files of those names.
- Depends on: nothing (pure ports).
- Verify: JSON vectors from each TS module's existing tests.

**WP-12 Logic ports: PRs, usage, copy and prompts** · Sonnet · L

- Goal: port `pr-blockers.ts`, PR action labels, `model-copy.ts` (generated `UI_COPY`), `approval-copy.ts`,
  `usage.ts`, `usage-limit.mjs`, `tokens.mjs`, `subchat-states.ts`, `subagent-glance.mjs`, attention counts,
  `queued-messages.mjs`, `send-retry.mjs`, `new-chat-glance.ts`, `file-kinds.mjs`, `file-link.mjs`,
  `prompt-parts.mjs`, `prompt-mentions.mjs`, `prompt-skills.mjs`, `github-markdown.ts`.
- Surfaces: logic behind the transcript (T rows), composer (K rows) and P-09. Owns: `src/logic/` files of those names, `tools/gen-copy.mjs`.
- Depends on: nothing (pure ports).
- Verify: JSON vectors from the TS tests; time formats checked in two time zones.

**WP-13 Diff engine and keybinding model** · Sonnet · M

- Goal: port `diff-parse.ts`, `diff-layout.ts` (UTF-16 offsets), `diff-tree.ts`, `git-diff.ts` formatters; port
  `keybindings.mjs` (parser, `when` evaluator, last match wins, conflicts) with a generated command catalogue, and map
  rules onto GPUI key contexts.
- Surfaces: logic behind P-03, P-06, T-09, G-09, global shortcuts. Owns: `src/logic/{diff_parse,diff_layout,diff_tree,git_diff,keybindings}.rs`, `tools/gen-keybindings.mjs`.
- Depends on: nothing (pure ports).
- Verify: vectors from `diff-*.test.ts` and `keybindings.test.mjs`.

**WP-14 Markdown renderer and streaming** · Opus · L

- Goal: pulldown-cmark with GFM to a block model; port `streaming-blocks.ts` and `closeOpenMarkdown`; render
  paragraphs, headings, lists with marker digits, block quotes, tables that scroll sideways, task lists, images,
  links (file links, Browser panel, ⌘-click) and inline code chips; per-text parse cache; fence routing hooks.
- Surfaces: T-04, T-05. Owns: `src/markdown/{parse,stream,render}.rs` (moves and grows `src/workspace/chat/markdown.rs`).
- Depends on: WP-02, WP-07; code blocks through a trait filled by WP-15.
- `gpui-component`: `TextView` is the main candidate (D8); if adopted, this package adds Milagre's link, chip and fence rules on top.
- Verify: streaming vectors identical to TS; snapshots of a markdown corpus taken from real transcripts.

**WP-15 Code highlighting and code blocks** · Sonnet · M

- Goal: syntect mapped to Shiki's colour buckets (N-09), generated language aliases from `lib/code-languages.ts`,
  40,000-char cap, highlight only near the viewport, code block chrome (label, Copy), diff mode.
- Surfaces: T-26. Owns: `src/markdown/{code,highlight}.rs`, `tools/gen-languages.mjs`.
- Depends on: WP-02.
- `gpui-component`: `highlighter` (syntect backend) is the main candidate (D8).
- Verify: token-colour snapshots for 10 languages in both schemes.

**WP-16 Selectable text and selection model** · Opus · XL

- Goal: one selection across blocks and messages (including items not laid out), copy as text with chip tokens,
  selection rectangles for popovers, highlight ranges for find; based on GPUI `StyledText` layout (index for point).
- Surfaces: T-04 selection, T-03, T-29, T-30, P-06 selection. Owns: `src/text/{selection,find}.rs`.
- Depends on: WP-14 (design the text-run model together).
- `gpui-component`: the `text` window selection is the main candidate (D8); if adopted, this package shrinks to L and covers what it lacks.
- Verify: headless drag-select across three blocks, shift-click extend, copy contents, selection survives scrolling.

**WP-17 Native host services** · Opus · L

- Goal: the main-local functions (section 4.4 "main" rows) natively: folder and file dialogs, editor list and open,
  reveal, clipboard image copy and save, an in-app image menu, local media reads (replacing `milagre-media://`),
  preferences store with the same keys, keep awake, notifications with Dock badge and chimes (rodio), answers to
  `desktop:request`.
- Surfaces: O-18, parts of C-01, T-17, K-04. Owns: `src/platform/{dialogs,editors,clipboard,notify,prefs,media}.rs`, `src/data/native.rs` impl.
- Depends on: WP-04.
- Verify: unit tests with temporary directories; notification payloads built from fixture events.

Parallel: WP-11, WP-12 and WP-13 have no dependencies and can start during wave 0. WP-07, WP-09, WP-10, WP-15 and WP-17 run together. WP-08 and WP-14 follow WP-07;
WP-16 follows WP-14.

### Wave 2: shell, sidebar and the Chat column

**WP-18 App shell and window chrome** · Opus · L

- Goal: window options, traffic lights, drag strips, minimum size, the three-column layout with the dock slot, view
  routing and the Escape cascade, sidebar bar controls, right corner controls with the panel registry, Chat identity,
  splash and frame, the keymap from WP-13.
- Surfaces: C-01, C-02, C-03, C-04, C-05, C-09. Owns: `src/workspace/{mod,chrome}.rs` (exist), `src/workspace/shell/`.
- Depends on: WP-05, WP-07, WP-08, WP-13.
- Verify: geometry tests (as the spike's), view switching and Escape order tests.

**WP-19 Sidebar rows and groups** · Sonnet · L

- Goal: the sidebar shell (resize, rail, scroll restore), All Chats and By Project modes, merged headings, Chats
  group, the Chat row in every variant with marks and the second line, Subchat nesting, Done section, usage block,
  empty states; virtualized with `uniform_list` where heights allow.
- Surfaces: S-01 to S-06, S-12, S-16, S-17, S-19. Owns: `src/workspace/sidebar/` (grows the existing `mod.rs`, `row.rs`, `bottom.rs`; adds `shell`, `groups`, `done`, `usage`).
- Depends on: WP-05, WP-07, WP-10, WP-11, WP-18.
- Verify: fixture states rendered in both modes; row snapshots for each mark; collapse and resize tests.

**WP-20 Sidebar menus, actions and undo** · Sonnet · L

- Goal: row context menu, hover card, inline rename, Done, Delete and Pin with the undo toast and ⌘Z history, pinned
  section, scope rail, Filters menu with submenus, footer.
- Surfaces: S-07 to S-11, S-13, S-18. Owns: `src/workspace/sidebar/{menu,hover_card,rename,undo,pins,rail,filters}.rs`.
- Depends on: WP-08, WP-09, WP-19.
- Verify: each menu action issues the right `DataSource` call (FixtureSource records calls); undo across 3 steps.

**WP-21 Transcript list and message kinds** · Opus · L

- Goal: the transcript `list` (bottom alignment, follow and anchor rules, load earlier and trim, measure-all on
  open), message dispatch by context kind, user bubble with chips, assistant reply layout, thinking, every divider,
  Delegation report lines, running and background indicators, transcript notices, preview rail.
- Surfaces: T-01, T-02, T-03, T-06, T-15, T-16, T-25, T-32. Owns: `src/workspace/chat/transcript/*` (grows `src/workspace/chat/transcript.rs`).
- Depends on: WP-06, WP-14, WP-16.
- Verify: the spike's timing probe on 2,000 items; anchoring tests when a page is prepended; snapshots of each divider.

**WP-22 Activity fold and tool rows** · Sonnet · L

- Goal: the activity summary and fold, tool rows for all 9 step kinds with running shimmer, waiting and failed
  states, lazy step details, inline diff, inline approval and its fallback card.
- Surfaces: T-07, T-08, T-09, T-10. Owns: `src/workspace/chat/transcript/{activity,step_row,step_diff,approval}.rs`.
- Depends on: WP-13, WP-15, WP-21.
- Verify: snapshots per step kind and state; approval buttons send `agent:respond-permission`.

**WP-23 Transcript cards and images** · Sonnet · L

- Goal: question, secret, bug report, answer, usage limit, Linear, PR action, advisor, recommendation, Heartbeat,
  next check, remote delegation and computer use cards; generated and viewed images with the dither field; the image
  lightbox (zoom, pan, swipe, morph; video opens externally).
- Surfaces: T-11, T-12, T-13, T-17, T-18, T-21, T-22, T-23, T-24. Owns: `src/workspace/chat/cards/*`.
- Depends on: WP-08, WP-09, WP-21.
- Verify: card snapshots from fixture messages; keyboard flow of the question card.

**WP-24 Composer editor** · Opus · XL

- Goal: the prompt editor over the string model of `lib/editor-model.ts`: atomic chips, chip-aware delete and caret
  steps, own undo history, paste as plain text, drop, IME, history recall, Tab suggestion, the @ and / menu with
  ranking, file chips only for files that exist.
- Surfaces: K-01, K-02. Owns: `src/text/prompt_editor/*`, `src/workspace/chat/composer/menu.rs` (grows `src/workspace/chat/composer.rs`).
- Depends on: WP-08, WP-09, WP-12.
- Verify: replay the cases in `lib/editor-model` tests; IME through the input handler; chip snapping vectors.

**WP-25 Composer bar, send, attachments and queue** · Sonnet · L

- Goal: the composer bar (translucent, Ultracode glow), send, stop, queue and steer rules, attachments (paste, drop,
  picker, tiles, upload progress, preview dialog), quote chips, queued messages, offline tray and outbox, drafts.
- Surfaces: K-03, K-04, K-05, K-09, K-15. Owns: `src/workspace/chat/composer/{bar,send,attachments,quotes,queue,offline,drafts}.rs`, `src/logic/outbox.rs`.
- Depends on: WP-06, WP-17, WP-24.
- Verify: send decision table (idle, running with steer, running with queue, offline); upload progress with a fixture.

**WP-26 Model picker, context and new-Chat tray** · Sonnet · L

- Goal: model picker (provider rail, accounts, search, effort slider, Fast and Ultracode tiles, permission, CLI
  notice), context ring and card, the new-Chat tray chips and pickers, the heading with the Project picker, the Linear
  issue picker, the New Chat glance.
- Surfaces: K-07, K-08, K-10, K-11, K-12, K-13. Owns: `src/workspace/chat/composer/{model_picker,context,new_chat,linear_picker,glance}.rs`.
- Depends on: WP-08, WP-10, WP-12, WP-25.
- Verify: picker keyboard tests; snapshots per provider state.

**WP-27 Pill row, Subchats, tasks and undo** · Sonnet · L

- Goal: pills that morph into panels (tasks with the phase graph drawn with paths, ports, Subchats, subagents, jump
  to bottom), subagent detail views, Subchat bookmark and family menus, the Undo panel.
- Surfaces: K-14, T-14, T-31, C-06. Owns: `src/workspace/chat/pills/*`, `src/workspace/chat/undo_panel.rs`.
- Depends on: WP-10, WP-21.
- Verify: morph snapshots at fixed times; phase graph geometry vs `shared/phase-graph.mjs` vectors.

**WP-28 Find in chat and quote selection** · Opus · M

- Goal: ⌘F over the transcript text model (what counts as searchable must be defined, since folded rows are excluded
  today), match navigation, highlights; the Quote button over a selection.
- Surfaces: T-29, T-30. Owns: `src/workspace/chat/{find_bar,quote}.rs`.
- Depends on: WP-16, WP-21.
- Verify: match counts on a fixture transcript; quote text equals the selected tokens.

Parallel: after WP-18, run WP-19, WP-21 and WP-24 together. Then WP-20 (after WP-19); WP-22, WP-23, WP-27 and WP-28
(after WP-21); WP-25 then WP-26 (after WP-24).

### Wave 3: panels

**WP-29 Dock and panel tabs** · Sonnet · M

- Goal: the dock (spring widths, resize handles, per-panel widths, at most two panels, the Chat keeps 420px), the
  panel tab strip from the spike, the Terminal drawer slot.
- Surfaces: P-01. Owns: `src/workspace/panel/{mod,dock,tabs}.rs` (`mod.rs` exists).
- Depends on: WP-10, WP-18.
- `gpui-component`: `DockArea` and `resizable` are candidates (D8).
- Verify: width rules at 980, 1440 and 2560px windows.

**WP-30 Changes panel** · Sonnet · L

- Goal: tabs with refresh, compare-with picker, Files view (flat list and folder tree with path fitting), Commits view,
  Link changes variant.
- Surfaces: P-02, P-03, P-04, P-05. Owns: `src/workspace/panel/changes/*`.
- Depends on: WP-13, WP-29.
- Verify: fixture `git:diff-files` and `git:history` results rendered; tree vectors.

**WP-31 Diff view and line comments** · Opus · XL

- Goal: the diff over the Chat with a virtualized row list, sticky file headers, unified, split and wrap, syntax runs
  with word marks, the pinned-file hold, large and binary states, selectable code, line comments (drag range, card,
  outdated and stale, Send), the diff bar.
- Surfaces: P-06, P-07, C-07. Owns: `src/workspace/panel/diff/*`.
- Depends on: WP-15, WP-16, WP-30.
- `gpui-component`: the `diff` module is a candidate for the row view and selection (D8).
- Verify: 10,000-line patch scroll timing; comment anchoring vectors from `lib/diff-comments.ts`.

**WP-32 PR panel, review and Git actions** · Sonnet · L

- Goal: PR header and merge actions with the ⋯ menu, checks bar, reviewer and label pickers with avatars (network
  images), description and comments through `github-markdown.ts`, files tab, review threads in the diff, review bar,
  the Git actions dialog.
- Surfaces: P-08, P-09, P-10. Owns: `src/workspace/panel/pr/*`, `src/overlays/dialogs/git_actions.rs`.
- Depends on: WP-14, WP-30, WP-31.
- Verify: snapshots for open, draft, merged, closed and blocked PRs; dialog mode table from `lib/git-dialog.ts`.

**WP-33 Terminal** · Opus · XL

- Goal: `alacritty_terminal` with an own grid painter (ANSI palette from the theme, cursor, selection, scrollback
  10,000), keys per platform (`lib/terminal-keys.ts`), IME, copy and paste menu, the long-poll client
  (`shared/terminal-client.mjs`: offsets, reset, backpressure), resize after 100ms of stillness, tabs and shell select.
- Surfaces: P-11. Owns: `src/workspace/panel/terminal/*`.
- Depends on: WP-04, WP-29.
- Verify: vttest-style escape fixtures; a recorded `terminal:read` stream replayed; resize and reset cases.

**WP-34 Web content host** · Opus · XL

- Goal: per D1, a wry child webview positioned over a GPUI element (z-order, clipping, focus and key forwarding), the
  `milagre-artifact` custom protocol with assets, the page helper message protocol; the Artifact page dock (tabs,
  zoom, comment pins); HTML replies as cards that open the dock (v1).
- Surfaces: P-17, T-19, T-20 (HTML cards). Owns: `src/platform/webview.rs`, `src/workspace/panel/artifacts/*`.
- Depends on: WP-29, WP-21.
- `gpui-component`: `gpui-webview` (on `lb-wry`) is the candidate for D1.
- Verify: a fixture artifact with assets loads; CSP blocks fetch; resize and scroll keep the webview aligned.

**WP-35 Browser panel** · Opus · L · **Out of scope (Victor, 2026-11-11): not migrated.**

- Goal: per D2, the tab strip, address bar and start page; agent and attached pages through the streamed viewer
  (frames as images, input forwarded, geometry from `shared/browser-receiver.mjs`); user tabs open in the default
  browser in v1; page comments deferred unless D2 picks a webview.
- Surfaces: P-12, P-13, P-14. Owns: `src/workspace/panel/browser/*`.
- Depends on: WP-29 (and WP-34 if D2 picks wry).
- Verify: fixture frame stream; input coordinate mapping vectors.

**WP-36 Designs canvas** · Opus · XL

- Goal: per N-03, the review board with pan and zoom, frames drawn from host-provided SVG or layout boxes, versions,
  Choose, Delete, comment pins and bubble, live drafts and replays with named agent cursors; design cards in the
  transcript.
- Surfaces: P-15, T-20 (design cards). Owns: `src/workspace/panel/designs/*`.
- Depends on: WP-10, WP-29.
- Verify: fixture design documents rendered; zoom-about-pointer maths; replay timing with a fake clock.

**WP-37 Simulator viewer** · Opus · L

- Goal: per D3, device list and attach, frame relay stream as images, H.264 through VideoToolbox, touch, button and
  key input with the letterbox geometry from `shared/simulator-receiver.mjs`.
- Surfaces: P-18. Owns: `src/workspace/panel/simulator/*`, `src/platform/video.rs`.
- Depends on: WP-29.
- Verify: recorded frames decode; touch mapping vectors at three device sizes.

**WP-38 Diagrams and generative UI** · Sonnet · M

- Goal: per N-07 and N-12, Mermaid via host-rendered SVG shown as an image with Source toggle and lightbox, genui as a
  code block (v1), the markdown fence hooks for both.
- Surfaces: T-27, T-28. Owns: `src/markdown/{diagram,genui}.rs`.
- Depends on: WP-14; a new daemon method for diagram rendering (coordinate with the backend owner).
- Verify: fallback paths when the host lacks the method.

Parallel: after WP-29, run WP-30, WP-33, WP-34, WP-36, WP-37 together; WP-31 and WP-32 follow WP-30; WP-35 follows
WP-34 when needed; WP-38 any time after WP-14.

### Wave 4: Settings, Routines, Canvas and the rest

**WP-39 Settings shell, search and simple sections** · Sonnet · L

- Surfaces: G-01, G-02, G-03, G-06, G-08, G-10, G-16, G-23, G-24. Owns: `src/settings/{mod,nav,search,general,chat,notifications,models,browser,church,about}.rs`.
- Goal: the in-window dialog, nav, search with row ids generated from `lib/settings-index.ts`, and these sections.
- Depends on: WP-08, WP-09, WP-10. Verify: search ranking vectors; every index row has a target.

**WP-40 Appearance and themes** · Sonnet · L

- Surfaces: G-04, G-05. Owns: `src/settings/appearance/*`.
- Goal: theme grid, custom theme editor with an own colour picker, font list from the platform, sizes, window preview
  (a scaled snapshot of a fixture workspace is acceptable).
- Depends on: WP-02, WP-39. Verify: theme switch repaints without reload; custom theme contrast readout matches TS.

**WP-41 Keybindings and Voice settings** · Sonnet · L

- Surfaces: G-07, G-09. Owns: `src/settings/{keybindings,voice}.rs`.
- Goal: key capture with conflicts and `when` editing per computer; speech model list with downloads.
- Depends on: WP-13, WP-39. Verify: capture of modifier combinations; conflict replace flow.

**WP-42 Accounts, usage and limits** · Sonnet · L

- Surfaces: G-11, G-12. Owns: `src/settings/{accounts,usage}.rs`.
- Goal: provider accounts, Project accounts, limit switches, plan usage and token analytics (calendar heatmap with
  drag-select, bars).
- Depends on: WP-12, WP-39. Verify: fixture usage reports rendered; calendar selection.

**WP-43 MCP, Milagre MCP, skills and integrations** · Sonnet · L

- Surfaces: G-13, G-14, G-15, G-18. Owns: `src/settings/{mcp,local_mcp,skills,integrations,babysit}.rs`.
- Goal: MCP list with checks and the server sheet, local MCP connections, skills with SKILL.md, Linear and Babysit PRs.
- Depends on: WP-14, WP-39. Verify: sheet validation; masked secrets restore on blur.

**WP-44 Devices, computers, This Mac, Projects and Worktrees** · Sonnet · L

- Surfaces: G-17, G-19, G-20, G-21, G-22. Owns: `src/settings/{devices,computers,this_mac,project,worktrees}.rs`.
- Goal: phone pairing QR (`qrcode` crate), devices, Simlock, resources gauges, computer use, computer pages with host
  updates, Project pages (icon upload and resize, branch policy, files to copy), worktree cleanup dialog.
- Depends on: WP-39. Verify: fixture snapshots; autosave timing with a fake clock.

**WP-45 Routines** · Sonnet · L

- Surfaces: R-01, R-02, R-03, R-04, R-05, V-04. Owns: `src/routines/{list,page,runs,editor,placeholders}.rs`, `src/logic/routine_form.rs`.
- Goal: list, Routine page, Run list, editor with schedule, Linear and webhook triggers, own time and date fields,
  `{{` placeholders, Run Chat split.
- Depends on: WP-08, WP-09, WP-12. Verify: `routine-form` vectors (cron round trips).

**WP-46 Flows** · Sonnet · L

- Surfaces: R-06, R-07, R-08. Owns: `src/routines/flow/*`, `src/logic/routine_flows.rs`.
- Goal: Flow page with rails, draft autosave and publish, inspector forms, Run view.
- Depends on: WP-45. Verify: step operation vectors from `routine-flows.test.mjs`.

**WP-47 Canvas** · Opus · XL · **Out of scope (Victor, 2026-11-11): the Canvas view is not migrated to GPUI.** The sidebar Canvas button stays hidden or inert.

- Surfaces: V-01. Owns: `src/canvas/*`.
- Goal: native node graph: pan and zoom, sections and Worktree cards with Chat rows, smooth-step edges with rounded
  corners via `PathBuilder`, dashed flow animation, drawing a Link between handles, filters, positions saved.
- Depends on: WP-10, WP-18. Verify: layout vectors from `shared/canvas.ts`; hit testing of handles and edges.

**WP-48 Chat grid, split and Link workspace** · Opus · L

- Surfaces: V-02, V-03. Owns: `src/workspace/grid/*`, `src/workspace/link/*`.
- Goal: tiles with the focused tile owning the composer, drop targets, family split; the Link workspace with
  member-aware Changes and its own palette.
- Depends on: WP-21, WP-25, WP-30. Verify: tile slot stability rules from `lib/chat-grid.ts`.

**WP-49 Sidebar drag and drop and Link popovers** · Opus · L

- Surfaces: S-14, S-15. Owns: `src/workspace/sidebar/{drag,links}.rs`.
- Goal: Project reorder, pin drag, row-on-row Links, drag into the grid, keyboard drag; the Link popovers.
- Depends on: WP-20, WP-48. Verify: drop intent zones (`lib/chat-list.ts:463` vectors); keyboard drag sequence.

**WP-50 Command palette and dialogs** · Sonnet · L

- Surfaces: O-01, O-05 to O-14. Owns: `src/overlays/palette.rs`, `src/overlays/dialogs/*` (except Git actions).
- Goal: palette sources, filter, recent, async message search; Add computer, Add Project with the remote folder
  browser, Link Projects, Remove Project, Delete Link, allow prompt, release notes, handoff brief, quit error, chooser.
- Depends on: WP-08, WP-09. Verify: `filterCommands` vectors; dialog focus tests.
- `gpui-component`: `command` is a candidate for the palette list (D8).

**WP-51 Onboarding** · Sonnet · M

- Surfaces: O-02, O-03, O-04. Owns: `src/overlays/onboarding/*`, `assets/onboarding/`.
- Goal: agent and Project steps, first-Chat starters, the Dawn intro from pre-rendered layers, the welcome sky.
- Depends on: WP-08, WP-09. Verify: step flow with a FixtureSource that has no Projects.

**WP-52 Notices and update card** · Sonnet · M

- Surfaces: O-16, O-19, C-08, K-16. Owns: `src/overlays/notices/*`.
- Goal: update pill and card morph, provider update card, host and save notices, editor toast, Ultracode Fatality
  (optional).
- Depends on: WP-10. Verify: each `UpdateState` rendered.

Parallel: WP-40 to WP-44 run together after WP-39; WP-45 to WP-48, WP-50, WP-51 and WP-52 run together; WP-46 after
WP-45; WP-49 after WP-48.

### Wave 5: platform-heavy features

**WP-53 Dictation** · Opus · XL · **Out of scope (Victor, 2026-11-11): not migrated.**

- Surfaces: K-06. Owns: `src/platform/{audio,whisper}.rs`, `src/workspace/chat/composer/dictation.rs`.
- Goal: cpal capture at 16 kHz mono, the `voice-stream.ts` segmentation, Whisper (whisper-rs, or keep a host helper),
  provisional text in the editor, fix-up, hold or toggle shortcut, model downloads.
- Depends on: WP-17, WP-24. Verify: recorded audio fixtures give stable segment boundaries.
- `gpui-component`: `speech` is a candidate for capture and levels (D8); Whisper stays.

**WP-54 Floating inbox** · Opus · XL · **Out of scope (Victor, 2026-11-11): not migrated.**

- Surfaces: O-17. Owns: `src/inbox/*`, `src/platform/floating.rs`.
- Goal: dock, inbox, preview and drag windows (`WindowKind::PopUp`, transparent), edge snapping per display,
  placement persistence, the inbox pager answering questions and approvals, number keys.
- Depends on: WP-17, WP-23. Verify: placement maths vectors from `electron/floating-inbox.cjs`; answering flows.

**WP-55 Design page editor** · Opus · XL

- Surfaces: P-16. Owns: `src/workspace/panel/designs/editor/*`.
- Goal: per D4, a native editor over the design scene (select, move, resize, snap, inspector, layers, undo, rebase,
  export through the host).
- Depends on: WP-36. Verify: operations diffed by `diffDesignDocuments` vectors; snapping vectors.

**WP-56 App updates and packaging** · Sonnet · M

- Surfaces: G-24, O-16 back end. Owns: `src/platform/updates.rs`.
- Goal: the `update:*` and `app:version` functions main provides today, release channel, answering the daemon's
  update requests.
- Depends on: WP-17; a decision on the update mechanism. Verify: state machine tests.

### Package outline

| WP  | Title                                        | Tier   | Size                                     | Depends on         | Wave |
| --- | -------------------------------------------- | ------ | ---------------------------------------- | ------------------ | ---- |
| 01  | `gpui-component` fit check                   | Opus   | M                                        | –                  | 0    |
| 02  | Theme engine, tokens, component theme bridge | Sonnet | L                                        | 01                 | 0    |
| 03  | Icons and logos                              | done   | –                                        | –                  | 0    |
| 04  | Daemon transport and DataSource              | Opus   | L                                        | –                  | 0    |
| 05  | State sync store                             | Opus   | L                                        | 04                 | 0    |
| 06  | Chat windows and runs                        | Opus   | L                                        | 05                 | 0    |
| 07  | Primitives: controls and display             | Sonnet | L                                        | 01, 02             | 1    |
| 08  | Overlay layer                                | Opus   | L                                        | 07                 | 1    |
| 09  | Text inputs                                  | Opus   | L                                        | 02                 | 1    |
| 10  | Scroll, slider and motion                    | Opus   | M                                        | 02                 | 1    |
| 11  | Logic: lists, marks, identity                | Sonnet | L                                        | –                  | 1    |
| 12  | Logic: PRs, usage, copy, prompts             | Sonnet | L                                        | –                  | 1    |
| 13  | Diff engine and keybinding model             | Sonnet | M                                        | –                  | 1    |
| 14  | Markdown renderer and streaming              | Opus   | L                                        | 02, 07             | 1    |
| 15  | Code highlighting and code blocks            | Sonnet | M                                        | 02                 | 1    |
| 16  | Selectable text and selection model          | Opus   | XL (L if D8 adopts `TextView` selection) | 14                 | 1    |
| 17  | Native host services                         | Opus   | L                                        | 04                 | 1    |
| 18  | App shell and window chrome                  | Opus   | L                                        | 05, 07, 08, 13     | 2    |
| 19  | Sidebar rows and groups                      | Sonnet | L                                        | 05, 07, 10, 11, 18 | 2    |
| 20  | Sidebar menus, actions and undo              | Sonnet | L                                        | 08, 09, 19         | 2    |
| 21  | Transcript list and message kinds            | Opus   | L                                        | 06, 14, 16         | 2    |
| 22  | Activity fold and tool rows                  | Sonnet | L                                        | 13, 15, 21         | 2    |
| 23  | Transcript cards and images                  | Sonnet | L                                        | 08, 09, 21         | 2    |
| 24  | Composer editor                              | Opus   | XL                                       | 08, 09, 12         | 2    |
| 25  | Composer bar, send, attachments, queue       | Sonnet | L                                        | 06, 17, 24         | 2    |
| 26  | Model picker, context, new-Chat tray         | Sonnet | L                                        | 08, 10, 12, 25     | 2    |
| 27  | Pill row, Subchats, tasks, undo              | Sonnet | L                                        | 10, 21             | 2    |
| 28  | Find in chat and quote selection             | Opus   | M                                        | 16, 21             | 2    |
| 29  | Dock and panel tabs                          | Sonnet | M                                        | 10, 18             | 3    |
| 30  | Changes panel                                | Sonnet | L                                        | 13, 29             | 3    |
| 31  | Diff view and line comments                  | Opus   | XL                                       | 15, 16, 30         | 3    |
| 32  | PR panel, review, Git actions                | Sonnet | L                                        | 14, 30, 31         | 3    |
| 33  | Terminal                                     | Opus   | XL                                       | 04, 29             | 3    |
| 34  | Web content host                             | Opus   | XL                                       | 21, 29, D1         | 3    |
| 35  | Browser panel                                | Opus   | L                                        | 29, D2 (34 if wry) | 3    |
| 36  | Designs canvas                               | Opus   | XL                                       | 10, 29             | 3    |
| 37  | Simulator viewer                             | Opus   | L                                        | 29, D3             | 3    |
| 38  | Diagrams and generative UI                   | Sonnet | M                                        | 14                 | 3    |
| 39  | Settings shell, search, simple sections      | Sonnet | L                                        | 08, 09, 10         | 4    |
| 40  | Appearance and themes                        | Sonnet | L                                        | 02, 39             | 4    |
| 41  | Keybindings and Voice settings               | Sonnet | L                                        | 13, 39             | 4    |
| 42  | Accounts, usage and limits                   | Sonnet | L                                        | 12, 39             | 4    |
| 43  | MCP, Milagre MCP, skills, integrations       | Sonnet | L                                        | 14, 39             | 4    |
| 44  | Devices, computers, This Mac, Projects       | Sonnet | L                                        | 39                 | 4    |
| 45  | Routines                                     | Sonnet | L                                        | 08, 09, 12         | 4    |
| 46  | Flows                                        | Sonnet | L                                        | 45                 | 4    |
| 47  | Canvas                                       | Opus   | XL                                       | 10, 18             | 4    |
| 48  | Chat grid, split and Link workspace          | Opus   | L                                        | 21, 25, 30         | 4    |
| 49  | Sidebar drag and drop, Link popovers         | Opus   | L                                        | 20, 48             | 4    |
| 50  | Command palette and dialogs                  | Sonnet | L                                        | 08, 09             | 4    |
| 51  | Onboarding                                   | Sonnet | M                                        | 08, 09             | 4    |
| 52  | Notices and update card                      | Sonnet | M                                        | 10                 | 4    |
| 53  | Dictation                                    | Opus   | XL                                       | 17, 24             | 5    |
| 54  | Floating inbox                               | Opus   | XL                                       | 17, 23             | 5    |
| 55  | Design page editor                           | Opus   | XL                                       | 36, D4             | 5    |
| 56  | App updates and packaging                    | Sonnet | M                                        | 17                 | 5    |

## 7. What I could not determine

Coverage. The renderer was read by twelve reading passes, one per area, plus my own reading of DESIGN.md, AGENTS.md,
GLOSSARY.md, `docs/agents/ui.md`, `docs/agents/domain.md` and the spike README.

- Read in full: every file in `c/agents/`, `c/changes/` (and `pr/`), `c/terminal/`, `c/checkpoints/`, `c/genui/`,
  `c/markdown/`, `c/motion/`, `c/primitives/`, `c/routines/`, `c/sidebar/`, `c/token-usage/`, `c/usage/`; `App.tsx`,
  `main.tsx`, `Workspace.tsx`, `SidebarNav.tsx`, `Settings.tsx`, `ChatComposer.tsx`, `PromptComposer.tsx`,
  `PromptEditor.tsx`, `FloatingInbox.tsx`, `LinkWorkspace.tsx`, `CanvasView.tsx`, `ChatGrid.tsx` and the other
  top-level components; most of `lib/`; `electron/preload.cjs`, `app/electron.d.ts`, `daemon/client.cjs`,
  `electron/main.cjs`, `daemon/runtime-client.cjs`, `daemon/server.cjs`, `daemon/protocol.cjs`,
  `daemon/computers-ipc.cjs`, `daemon/computer-routing.cjs`; `shared/themes/*` (not the palettes).
- Read in part: `app/styles.css` (lines 1990-2372, the onboarding and intro keyframes, by search only);
  `c/sidebar/SidebarLinks.tsx` (lines 330-622 by search); `c/settings/AppearanceWindowPreview.tsx` (first 200 lines);
  `c/settings/ChatDisplayChoices.tsx`; `c/McpServerRow.tsx` (search only); `c/agents/DesignExportDialog.tsx` and
  `DesignPageShareDialog.tsx` (search only); `c/agents/design-rebase.ts` and `design-draft-cache.ts` (signatures);
  `lib/settings-index.ts` (first 80 lines), `lib/outbox.ts` (first 50), `lib/dictation-worklet.js` (first 30),
  `lib/message-commands.ts`, `lib/babysit-settings.ts`; `shared/model.ts` (relevant types), `shared/keybindings.mjs`
  (142 of 485 lines), `shared/outbox.mjs` (60 of 233), `shared/voice-stream.ts` (80 of 223), `shared/genui.ts` (120 of
  231), `shared/dictation.mjs`, `shared/routines.mjs`, `shared/routine-*.mjs`, `shared/token-usage.ts`,
  `shared/design*.mjs`, `shared/simulator-receiver.mjs`, `shared/browser-receiver.mjs` (heads and exports);
  `core/runtime.cjs`, `core/git-ipc.cjs`, `core/link-runtime.cjs`, `core/checkpoint-runtime.cjs` (handler sections).
- Not read: `apps/mobile` (the sync rule applies to it); `daemon/mobile-bridge.cjs`; `core/pull-request-review.cjs`
  (the gh calls behind `pr:*`); `shared/chat-plan.mjs`; `shared/themes/palettes/*` (so no contrast numbers were
  computed); `lib/fit-folder.ts`; `experiments/rust-gpui/src` (only its file list at `6b521fb6`, its `Cargo.toml`, the README and the commit messages; another
  agent was restructuring it, and the README's "Layout" table still lists the old 0.2.2 files).

Open questions:

- How well `gpui-component` 0.9.1 fits: section 3.1 comes from the spike README and module names only; nothing was
  tested against Milagre's surfaces. WP-01 answers it, and several package sizes depend on the answer.
- The crate moved from `gpui` 0.2.2 to `gpui-pre` 0.3.12 while this map was written. The GPUI facts in section 3 were
  re-checked in the `gpui-pre` source; anything else that depended on 0.2.2 limits may be stale.

- The live `daemon:status.methods` list: section 4 comes from static registrations; commands added at run time may exist.
- Payload shapes named but not expanded: WorktreeRename, MainSyncStatus, McpChangedEvent, KeybindingsState, GitChanges,
  GitHistory, BranchPolicySettings, IdleWorktrees, ComputerResources, the TokenUsage types, LinearStatus.
- Whether composer draft text survives an app restart: `lib/draft-store.ts` and `lib/link-scope.ts` are in-memory maps;
  persistence, if any, is elsewhere (host or phone).
- `pele` internals: `node_modules` is not installed in this Worktree, so its API is known only from call sites.
- `@openuidev/lang-core` 0.3.2 internals and how big a Rust port of its parser would be.
- The exact Shiki scope-to-colour mapping inside `createCssVariablesTheme` (only the 10 variable names are known), and
  the full language set of `refractor` used by `shared/file-syntax.mjs`.
- The exact timings of the Dawn intro, splash and onboarding animations (`app/styles.css:1990-2372`).
- Native details of each `floating-inbox:*` geometry call beyond `electron/floating-inbox.cjs:1-140`.
- The simulator receiver's keyboard path and WebRTC reconnect logic (`shared/simulator-receiver.mjs`, located only).
- Whether React's `<Activity>` hidden mode keeps behaviour that a GPUI port must copy (the sidebar and both workspaces
  rely on it); GPUI has no direct equivalent, retained entities are the likely mapping.
- GPUI facts beyond the checks in section 3 (for example text-run sizes, the cost of `runtime_shaders` at launch, and
  child-view compositing with wry) are unverified.
- Linux and Windows: out of scope for now (macOS only).
