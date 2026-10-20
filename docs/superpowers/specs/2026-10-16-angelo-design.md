# Angelo: named bots that work around the clock, on Milagre's daemon

Date: 2026-10-16. Status: draft design for Victor's review. Research and design only; nothing here is built.

Designs (Milagre Designs canvas, this Chat): `angelo-phone-home`, `angelo-phone-thread`, `angelo-phone-profile`,
`angelo-phone-group` (group "Angelo phone") and `angelo-desktop-bots` (group "Angelo desktop").

## Intent

Milagre is where Victor codes with agents: Chats in worktrees. Angelo is where his standing teammates live: a few named
bots that keep working while he does something else, remember what happened yesterday, talk to each other, and come
back to him only when they need a decision. It is Milagre's take on xAI's Grok Bot (beta 2026-08-11), built on what
Milagre already runs on the Mac: the daemon, the provider CLIs on Victor's own subscriptions, the milagre MCP tools, the
phone relay, approvals and accounts.

The first three bots are all about shipping Milagre:

1. **Ops** watches main, open PRs, CI, betas, OTA and Linear for the-ptf/milagre. When something needs code, it opens a
   Milagre Chat, steers it, and reports back.
2. **Release** owns beta and stable releases, OTA updates, TestFlight and store submissions and the Discord post, and asks
   before every irreversible step.
3. **Chief** (chief of staff) reads Linear, GitHub, Slack and mail, hands work to Ops and Release, chases it, and sends
   Victor one digest a day.

Success: a month in, Victor's mornings start with the Chief's digest, flaky CI gets fixed without him noticing until
he signs off a merge, and releases happen by tapping Allow on the phone.

## Goals

- Persistent named bots, each with one ongoing thread and its own memory.
- Bots message each other; the Chief directs the others. Group threads hold Victor plus several bots.
- Routines (schedules, Linear events, webhooks) wake bots without anyone sending a message.
- Bots do code work by opening Milagre Chats, never by editing repos themselves.
- A fixed set of irreversible actions always waits for Victor's sign-off, enforced by the daemon.
- Victor's phone buzzes only when a bot is blocked on him, plus the daily digest.
- An Angelo iPhone app, and a Bots area inside Milagre desktop.

## Non-goals (v1)

- Cloud computers. Bots run on Victor's Mac, which stays open and plugged in at night. Cloud comes later.
- Teammates sharing one set of bots. Each person runs their own bots on their own Mac; bots on different Macs don't
  talk in v1.
- Bots with their own identities in Slack, GitHub or Linear. Anything a bot posts goes out as Victor, behind a sign-off.
- A status-board home screen. The home is a messages list.
- Teach-by-demonstration (rakazo's TaughtSkill, Grok Bot's "Teach a task"). Bots have no computer to record yet.
- A visual workflow builder. Routines are scheduled prompts.
- Android Angelo app, Linux, Windows.

## Anti-goals (failure even if it works)

- **Notification spam.** Bots chatting at Victor all day. Every push must be something only he can unblock, or the one
  digest.
- **Milagre with a new skin.** Chats with names and cron. A bot must feel like a teammate: one conversation that never
  ends, memory of what it did and what Victor decided, and visible collaboration with the other bots.

## Decisions

Victor's answers in this Chat:

| Question | Decision |
| --- | --- |
| First bots | Ops, Release, Chief. |
| Audience | Victor and the team first. Each teammate runs their own bots on their own Mac. |
| Where bots run | Victor's Mac via the existing daemon. Cloud later. The Mac stays open and plugged in overnight. |
| App shape | Own iPhone app (Angelo). On desktop, Angelo is an area inside Milagre. |
| Routines | One shared engine in the daemon with two faces: Milagre routines start Chats, bot routines wake a bot. |
| Code work | Bots open Milagre Chats in fresh worktrees and steer them. |
| Teammate feel | One ongoing thread with memory per bot; bots talk to each other. |
| Pushes | Only when a bot is blocked on Victor (sign-off or question), plus the Chief's daily digest. |
| Sign-off | Free hand with fixed gates: merge, publish/release/OTA, posting as Victor, deleting, spending. Allow once / Always for this bot / Deny. |
| Bot talk | Chief assigns and chases; any bot can message another; group threads; daemon blocks loops and duplicates. |
| Phone home | Messages list with a pinned "Needs you" card; search and compose at the bottom, iMessage style. |
| Making bots | Ops, Release and Chief ship as starter templates. New bots come from asking the Chief to hire one, or a short form. |
| Usage | Bots use the same accounts as Chats. |
| Avatars | Mascots in the OpenMausBot style: a colored body shape with a face, per bot (Victor's design comment). |
| Bot-opened Chat on the phone | Tapping it deep links into the Milagre phone app. Angelo has no Chat screen. |
| Starter bots | Generic templates with a setup card (repos, release commands, digest sources). Victor fills in Milagre's values once. |
| Shipping | TestFlight only for v1. No App Store listing. |

Calls I made (marked again where they appear; Victor should check these):

1. Same daemon process. Bots are a module in `packages/core`, not a second host.
2. The daemon becomes a login item so bots survive a reboot without opening Milagre.
3. Each bot is a hidden Project: a git-initialised home folder in the daemon's data directory. The existing Chat
   machinery (sessions, resume, `chats.db`, account routing) runs there unchanged.
4. Each routine run is its own session; its result posts into the bot's thread. A run that ends with `(pass)` adds
   nothing to the thread.
5. Gates follow the work: a Chat a bot opens runs under that bot's gates, so a bot can't route around a gate through a
   full-access Chat.
6. Chats that a bot opened don't push Victor when they finish; the bot is told instead.
7. Sign-offs expire after 1 hour and count as denied.
8. The bot's brief and memory are snapshotted into its instructions when a session starts, to keep the prompt cache
   stable; edits apply from the next session.
9. Phone bundle id `com.victorlucas.angelo`, code in `apps/angelo`.
10. The phone connection layer moves out of `apps/mobile/src` into a shared package that both apps use.
11. Bot sessions and bot-opened Chats run in a new **Bot rules** mode: the provider runs ask-style and the daemon
    answers every permission request itself, allowing everything except gates. Victor never sees non-gate approvals.
    When Victor takes over a bot-opened Chat, it becomes an ordinary Chat in the Project's default mode and the bot's
    gates no longer apply.
12. A routine report is appended to the bot thread without starting a turn; the bot reads it on its next turn. A
    "Chat finished" event does start a turn, because the bot has to act on it.
13. One Mac per Angelo app in v1. The desktop Bots area shows the local Mac's bots only, not bots on remote Computers.
14. This spec builds the shared routines engine and the bot executor. The Milagre-side executors (heartbeat into a Chat,
    fresh-worktree runs) belong to the Routines spec.

## Terms

Add these to GLOSSARY.md when the work starts.

- **Bot:** a persistent named teammate on one Mac: name, role, brief, mascot, model, memory, routines and one thread.
- **Bot thread:** the bot's one ongoing conversation with Victor. It never ends; old context is compacted.
- **Group:** a thread with Victor and two to six bots. A group has no agent of its own.
- **Starter bot:** a template (Ops, Release, Chief) that ships with Angelo.
- **Routine:** a saved prompt plus one or more triggers (schedule, interval, once, Linear event, webhook). Owned by a
  Chat (Milagre face) or a bot (Angelo face).
- **Run:** one firing of a routine. A bot's run is its own session; its result lands in the bot thread.
- **Gate:** an action class that always needs Victor's sign-off (merge, publish, post as Victor, delete, spend).
- **Sign-off:** Victor's answer to a gate: Allow once, Always for this bot, or Deny.
- **Grant:** a standing "Always for this bot" answer for one gate and target, revocable.
- **Assignment:** one bot asking another to do something, tracked by the daemon until it is answered or expires.
- **Digest:** the Chief's daily summary, the only scheduled push.
- **Mascot:** a bot's avatar: a body shape, a color and a face whose expression follows the bot's state.

## What Angelo shares with Milagre, and what is new

| Piece | Today in Milagre | Angelo |
| --- | --- | --- |
| Daemon host | Detached Node process that outlives the window (`apps/daemon/src/bootstrap.cjs`, `docs/local-daemon.md`). No restart after reboot. | Same process. New: login item, bots module. |
| Provider layer | Claude Agent SDK, Codex app-server, Antigravity over ACP (`packages/core/src/agents/`). One session per Chat with resume (`session-manager.cjs`). | Reused as is. A bot thread and each run are sessions. |
| Projects and Chats | Every Chat needs a git worktree (`agents/chat-host.cjs:456`); `project-identity.cjs` rejects non-git folders. | Each bot gets a git-initialised home folder registered as a hidden Project. |
| Chat storage | Per-Project `.milagre/coordination.json` and `.milagre/chats.db` (ADR-0007). | Reused inside each bot folder. New daemon-level `angelo.db` for bots, groups, assignments, gates, grants. |
| Accounts and limit switch | `accounts.cjs`, `account-routing.cjs`, `limit-switch.cjs`. | Reused. Bot projects follow the computer default account. |
| Permissions | `ask` / `auto` / `full` mapped per provider (`agents/permissions.cjs`, `claude-provider.cjs:25`); approvals out to every client. | New gate policy on top. |
| Milagre MCP tools | Per-Chat groups: links, plan, management, simulators, browsers, designs, advisors, Linear (`runtime.cjs:1387`). | New groups for bot sessions: team, routines, memory, gates, Milagre Chats. |
| Delegation | Across canvas Links only, one hop, approval each time, 10 negotiation rounds (`delegations.cjs`). | Not reused for bot talk; the delivery rule (steer if working, queue if waiting, else start a turn) is. |
| `chat_start` | Inherits the caller's permission mode, no loop or depth guard (`local-mcp-host.cjs:71`). | Bots get their own Chat tools with caps and gate inheritance. |
| Keep-awake | `caffeinate -i` only while a turn runs (`keep-awake.cjs`, `apps/daemon/src/power.cjs:15`). | New hold while any bot routine is enabled. |
| Phone relay | One Durable Object per Mac, E2E frames, routes `/health`, `/v1/host`, `/v1/phone` only, no queue (`apps/relay/src/worker.ts:11`). | Reused for the Angelo app. Webhook route comes from the Routines work. |
| Push | The Mac posts straight to Expo (`apps/daemon/src/expo-push.cjs:1`); payload kind `milagre-chat`. | New kind `angelo-bot` to Angelo devices only. |
| Linear | Computer-wide sign-in, read tools (`packages/core/src/linear/`). | Reused for triggers and for the Chief. |
| Phone app | `apps/mobile`, Expo, flat Stack, no tabs, `com.victorlucas.milagre`. | New `apps/angelo` app sharing an extracted connection package. |
| Desktop | Sidebar, Chat pane, side panels (`apps/desktop/app/src`). | New Bots mode in the sidebar, thread pane, profile panel. |
| Scheduling | Nothing. No cron, routines or webhooks anywhere. | Shared routines engine (with the Routines work). |

## Architecture

### Process model

Bots live in the daemon that already hosts every Chat (call 1). A second host would duplicate accounts, provider
spawning, push and the relay identity, and Angelo's main job (opening Milagre Chats) is a direct call inside one
process.

Add `packages/core/src/bots/` and construct it in `createRuntime` next to the Chat host. It owns the bots store, the bot
projects, the team tools and the gate policy. The routines engine is a sibling module (`packages/core/src/routines/`)
that both faces use.

**Login item (call 2).** Today nothing restarts the daemon after a reboot; it waits for the desktop app
(`docs/mobile-local.md:172`). Register the daemon as a per-user launch agent when the first bot is created, and remove
it when the last bot is deleted. `ensureDaemon` already adopts a running host unless it is stale (`bootstrap.cjs:92`),
so the desktop app keeps working. App updates still replace a stale host through `daemon:stop`; the launch agent must
point at the installed app so the restart picks up the new version. The builder picks between `SMAppService` and a
plist in `~/Library/LaunchAgents`.

**Keep-awake.** Add a "bots" reason to `KeepAwake` that holds the blocker while any bot routine is enabled, in addition
to running turns. Victor's Mac stays open and plugged in, so `caffeinate -i` plus `-s` on AC power is enough. A Settings
switch under Bots turns the hold off.

**Restarts.** The daemon restarts on every Milagre update. A routine run interrupted by a restart is marked
`interrupted` and never replayed, because its external effects can't be known (Codync's rule). Its routine fires again
at its next slot. A bot thread turn that was interrupted resumes through the existing `resumeInterrupted`
(`chat-host.cjs:810`).

### A bot on disk (call 3)

```
<dataDir>/bots/<botId>/            git init, one empty commit; registered as a hidden Project (kind "bot")
  BRIEF.md                         role and standing rules, edited by Victor or by the bot with sign-off
  MEMORY.md                        durable memory, capped (see Memory)
  memory/<topic>.md, memory/archive/, memory/.journal
  AGENTS.md, CLAUDE.md, GEMINI.md  generated at session start: snapshot of BRIEF, MEMORY and the team roster
  .milagre/coordination.json       the bot's sessions: one thread session plus run sessions
  .milagre/chats.db                messages, as for any Project
```

Hidden means the Project never shows in Milagre's Projects list, in `project_list`, or on the canvas. The main checkout
is the only worktree. Account routing per Project works for free, so a bot could later get its own account without new
code.

`<dataDir>/angelo.db` (SQLite, `node:sqlite` like `chats.db`) holds what is not a Chat:

```ts
interface Bot {
  id: string;                 // slug, "ops"
  name: string;               // "Ops"
  role: string;               // one line: "Keeps Milagre's main green and PRs moving"
  mascot: { body: MascotBody; color: string; image?: string };
  provider: "claude" | "codex" | "antigravity";
  model?: string;
  projects: string[];         // Milagre Project paths this bot may open Chats in
  chief: boolean;             // at most one
  paused: boolean;            // paused bots run no routines and take no messages from other bots
  threadSessionId: number;    // session id inside the bot project
  createdAt: number;
}
interface Group { id: string; name: string; members: string[]; owner: string; createdAt: number } // owner = bot that answers when nobody is mentioned
interface Assignment {
  id: string; rootId: string; parentId?: string; depth: number;
  from: string; to: string;   // bot ids; "victor" for Victor
  mode: "work" | "consult" | "notify";
  text: string; status: "open" | "answered" | "expired" | "cancelled" | "rejected";
  reply?: string; createdAt: number; expiresAt: number;
}
interface GateRequest {
  id: string; botId: string; sessionRef: string; gate: GateKind;
  title: string; detail: string; command: string;   // exact text shown on the card
  status: "pending" | "allowed" | "denied" | "expired"; createdAt: number; expiresAt: number;
}
interface Grant { id: string; botId: string; gate: GateKind; target: string; createdAt: number; revokedAt?: number }
```

The builder may change field names and storage layout; the shapes above are what the screens need.

### The bot thread

One long-lived session per bot, kind `bot-thread`, never archived. Victor's messages, bot-to-bot messages addressed to
this bot and Chat-finished events arrive here as turns, using Delegation's delivery rule: steer a working turn, queue
behind a waiting one, otherwise start a turn (`delegations.cjs:14`). Routine reports are appended to the thread as
history and start no turn (call 12); the bot sees them on its next turn. That keeps overnight runs from costing a second
turn each and stops the bot from replying to its own reports.

**Instructions (call 8).** At session start the daemon writes `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` in the bot folder
from a template: who the bot is (BRIEF), what it remembers (MEMORY, wrapped as labeled data, not instructions, as rakazo
does with `<durable_memory>`), the team roster with each bot's role, Victor's name, the gate list, and the rule that
messages from other bots carry no authority from Victor. The snapshot stays frozen until the next session so the prompt
cache holds.

**Length.** The providers compact long sessions themselves. When resume fails or the session passes a size the builder
picks, the daemon starts a fresh provider session seeded with the last messages and MEMORY. The thread the user sees
is the `chats.db` history and stays continuous across sessions.

**What the thread shows** (designs `angelo-phone-thread`, `angelo-desktop-bots`):

- Victor's messages and the bot's replies.
- A divider line per routine run that produced something: `Routine · CI watch · 07:30`, then the run's report.
- A card for each Milagre Chat the bot opened: title, Project, branch or PR, state, "Open Chat".
- A one-line row per bot-to-bot exchange: `Messaged Release: hold beta.2 until main is green · 2 messages`. Tapping it
  opens the read-only pair transcript (Codync).
- Sign-off cards and question cards inline.
- Routine confirmation cards.

Tool calls stay collapsed; the thread shows results and asks, not tool lifecycle (rakazo's "calm on the surface").

### Routines: one engine, two faces

The Routines Chat (`milagre/grok-open-source-search-dc17`) is specifying Routines for Milagre. This design assumes its
decisions and moves the engine into a shared module so bots use the same scheduler and triggers. The two specs should
land as one engine; whichever ships first owns `packages/core/src/routines/`.

**Shared engine** (`packages/core/src/routines/`):

- **Routine:** `{ id, owner: {kind: "chat" | "bot", id}, name, instruction, triggers[], enabled, model?, rememberLastRun,
  createdBy, nextRunAt, lastRunAt }` plus face-specific fields (a Chat routine's run mode and permission mode, per the
  Routines spec).
- **Triggers** (OR-list, Codync): cron with an IANA timezone (Croner), interval (minimum 5 minutes), once, Linear event
  (assigned to me, label added, moved to state, new comment; polled with the existing sign-in), Sentry, and generic
  webhook through `https://relay.milagre.cloud/hook/<secret>`, queued in the Durable Object while the Mac is offline. An
  event trigger needs at least one filter (botroster: a bare source burns usage on every event).
- **Scheduling:** the daemon checks due routines every few seconds with no client connected. One run per routine at a
  time; due triggers coalesce. A run less than 12 hours late runs once on wake; older ones leave a "missed" line in the
  run history (OpenMausBot).
- **Confirmation card:** nothing goes live until Victor taps Turn on on a card that shows the rule, timezone and the
  next three dates (OpenMausBot; design `angelo-phone-group`).
- **No recursion:** `routine_save` is not available inside a run (rakazo).
- **Run history:** the last 20 runs per routine with trigger, start, end, outcome and a link to the run session.
- **Executor interface:** `start(routine, firing) → run`. The Milagre face implements heartbeat-into-Chat and
  fresh-worktree runs per the Routines spec. The bot face implements the bot run below.
- **Agent tools** (both faces): `routine_list`, `routine_save` (creates a disabled routine and posts the confirmation
  card), `routine_set_enabled`, `routine_delete`, `routine_run_now`. Bot runs also get `thread_wake(reason)` (below).

**Bot runs (call 4).** A run is a new session in the bot project, kind `routine-run`, hidden from lists, seeded with the
routine's instruction, the bot's instructions snapshot, the trigger payload, and the previous run's report when
`rememberLastRun` is on. When it ends, the daemon appends its final report to the bot thread under the divider, without
starting a thread turn. A report that is exactly `(pass)` posts nothing; the run shows only in the routine's history. A
run's sign-offs and questions reach Victor like the thread's. A run that needs the bot to keep going after it ends (wait
for a Chat it opened, follow up tomorrow) calls `thread_wake(reason)`; the daemon then starts one thread turn after the
report is appended. Chats a run opens report back to the bot thread, not to the finished run.

**Usage limits.** A run that fails on a usage limit is marked `limited` and runs once more after the reset, coalesced
with any firings in between. The existing auto-switch applies first if it is on.

### Bot to bot

New MCP tool group for bot sessions (thread and runs):

| Tool | Who | What it does |
| --- | --- | --- |
| `team_list` | all bots | Bots and groups, each bot's role, paused state and what it is doing. |
| `message_bot(to, text, mode)` | all bots | Creates an Assignment and delivers `text` into the target's thread, marked "from Ops (bot)". `mode` is `work` (do it, report back), `consult` (answer a question) or `notify` (no reply). Returns at once. |
| `ask_bot(to, question)` | all bots | Same as `consult` but waits for the answer, up to 10 minutes (Codync). |
| `assignments_list` | all bots | Open assignments to and from this bot. |
| `bot_pause`, `bot_resume`, `retry_run` | Chief | Pause a misbehaving bot, retry a failed run. |
| `bot_create(name, role, brief, mascot, model, projects)` | Chief | Posts a "New bot" card to Victor; nothing is created until he confirms. |

**Guards** (enforced by the daemon, not the prompt):

- No messages to yourself. No duplicate: the same `from`, `to` and text within 10 minutes is rejected with the open
  assignment's id.
- Depth: an assignment created while handling another one is its child; depth is capped at 3.
- Cycles: `ask_bot` is refused if the target is already waiting on the asker anywhere up the chain.
- Caps: 8 open assignments per bot, 32 per Mac. A thread gets at most 20 bot-to-bot deliveries per hour; past that,
  deliveries queue and the Chief's thread gets one "Team incidents" line (OpenMausBot's storm limit).
- Pausing or deleting a bot cancels its open assignments.
- Answers from bots never count as Victor's. A bot can't answer a gate or a question meant for Victor, and the Chief
  can relay a gate to Victor but not decide it (OpenMausBot's escalation rule).

**The Chief.** A bot with `chief: true`. Besides the extra tools, it receives a "Team incidents" line in its thread when
another bot's run fails, stalls (no tool progress for 20 minutes) or is interrupted, and decides whether to retry, ask
another bot or tell Victor. Its daily digest is a built-in routine (default 07:00, Victor's timezone) whose report is
the only scheduled push.

**Groups** (design `angelo-phone-group`). A group is a message log in `angelo.db`; it has no agent. When Victor posts:

1. The daemon picks responders: every @mentioned bot, otherwise the group's owner (the Chief by default).
2. Each responder gets a turn in its own thread session with the recent group transcript as input, and its reply posts
   to the group. Its own thread shows a one-line "Replied in Release room" row.
3. Bots may @mention each other in replies, which adds responders. A round ends when nobody new is mentioned; a post
   from Victor allows at most 3 rounds and 10 bot replies (Codync). A reply of exactly `(pass)` posts nothing.

Sign-off cards and secrets never appear in groups (Grok Bot does the same); they go to the bot's own thread and to
"Needs you".

### Code work through Milagre Chats

New tool group for bot sessions, scoped to the Projects listed in `bot.projects`:

| Tool | What it does |
| --- | --- |
| `chat_open(project, title, prompt, base?, model?)` | Creates a worktree from `base` (default the main branch) and a Chat, starts it, and records `startedBy: {kind: "bot", botId}`. |
| `chat_status(chatId)` | State, last reply, PR link, changed files. |
| `chat_send(chatId, text)` | Steers or continues a Chat this bot opened. |
| `chat_list_mine` | The bot's open Chats. |

- When a Chat the bot opened finishes a turn, the bot thread gets a "Chat finished" event with the last reply, like a
  Delegation report.
- Caps: at most 3 running Chats per bot; `chat_open` is refused inside a routine run unless the routine allows it.
- **Gates follow the work (call 5).** A Chat a bot opened runs in Bot rules mode under the bot's gates and grants, and
  its sign-offs are filed under the bot.
- **No completion pushes (call 6).** A bot-opened Chat never pushes Victor on completion. Its gate requests still reach
  "Needs you".
- In Milagre (desktop sidebar and Milagre phone app) these Chats carry a small "from Ops" mark with the bot's mascot.
  Victor can open one and take over like any Chat; once he sends a message there, the bot stops steering it and gets a
  "Victor took over" event.
- On the Angelo phone, the Chat card deep links into the Milagre phone app (`milagre://chat?host=<hostId>&project=<path>&session=<id>`,
  the `milagre` scheme already exists). If Milagre isn't installed or isn't paired with that Mac, the card says so and
  offers the TestFlight link. Angelo has no Chat screen of its own.

### Gates and sign-off

Bots work with a free hand: they read, run commands, use MCP servers and open Chats without asking. Five gate kinds
always ask:

| Gate | Matches (initial patterns; the builder extends them) |
| --- | --- |
| `merge` | `gh pr merge`, `git push` to a repo's default or protected branch, the GitHub merge MCP tools. |
| `publish` | `eas update`, `eas build ... --auto-submit`, `eas submit`, `node scripts/asc.mjs submit|release|beta`, `npm publish`, `gh release create`, `vercel --prod`, `wrangler deploy`, `gh workflow run publish.yml`. |
| `post` | Slack, Gmail, Discord webhook and Linear comment/create MCP tools; `gh pr comment`, `gh issue comment`, `gh pr review`; `curl` to a known webhook host. |
| `delete` | `git push --force`, `git branch -D` on a pushed branch, `gh repo delete`, `rm -rf` outside the bot folder or a worktree it opened, delete-style MCP tools. |
| `spend` | Purchase or payment tools. None exist today; the kind is reserved. |

**Enforcement: the Bot rules mode (call 11).** Bot thread sessions, run sessions and bot-opened Chats run in a fourth
permission mode, Bot rules, shown as such on the Chat's mode chip in Milagre. It is never Full, because Codex in Full
(`approvalPolicy: "never"`, `codex-provider.cjs:44`) sends no requests the daemon could gate.

- **Claude:** provider mode `default`, plus a `PreToolUse` hook (the provider already registers hooks,
  `claude-provider.cjs:329`) that runs whatever allow rules sit in the user's Claude settings. A gate match returns
  "ask" and becomes a gate card; everything else that reaches `canUseTool` is allowed by the daemon.
- **Codex:** `on-request` approvals with a workspace-write sandbox that has network access (for `gh`, `eas`, `curl`).
  The daemon answers every request: allow, unless it matches a gate.
- **Antigravity (ACP):** the same daemon answer for `session/request_permission`.
- Non-gate approvals never reach Victor, on any client.
- **Takeover:** when Victor sends a message in a bot-opened Chat, the Chat becomes his: Bot rules is replaced by the
  Project's default mode and the bot's gates and grants stop applying there.

Gates are guardrails on known commands, not a sandbox. A script that calls `gh pr merge` internally slips past the
pattern; the starter briefs tell bots to use the commands directly, and the gate list is the place to add release
scripts as they appear.

**The card** (designs `angelo-phone-thread`, `angelo-desktop-bots`): kicker "Needs your sign-off", the action in plain
words ("Merge PR #474 into main"), the exact command, context the bot attaches (diff size, CI state, reviewers) and the
expiry. Buttons: **Allow once**, **Always for Ops**, **Deny**.

- **Always for Ops** creates a Grant for this gate and target (repo for `merge`, project or channel for others). Grants
  are listed in the bot profile and in Settings › Bots, each with Revoke.
- **Expiry (call 7).** A request expires after 1 hour, shows as Expired, and counts as denied; the bot is told and may ask
  again.
- Only Victor answers, from the Angelo app, Milagre desktop, or the Milagre phone inbox for bot-opened Chats.

### Notifications

| Event | Angelo push | Desktop notification | Thread |
| --- | --- | --- | --- |
| Gate request | Yes | Yes | Card |
| Bot asks Victor a question | Yes | Yes | Card |
| Chief's daily digest | Yes, once a day | No | Message |
| Routine report | No | No | Divider + report, unread dot |
| `(pass)` run | No | No | Nothing |
| Bot-to-bot message | No | No | One-line row |
| Bot-opened Chat finished | No | No | Event in the bot thread |
| Run failed or stalled | No (goes to the Chief) | No | Incident line in the Chief's thread |

New push kind `angelo-bot` carrying `hostId`, `botId` or `groupId`, and `eventId`. Angelo devices register with the
daemon like Milagre phones do (`mobile-push.cjs`), tagged with their app. Expo push tokens are scoped to an Expo
project, so the daemon batches Milagre and Angelo tokens separately. The existing rules carry over: no push for a
thread already open on a focused screen.

### Memory

- `MEMORY.md` in the bot folder, capped at 200 lines or 24 KB (OpenMausBot), plus topic files under `memory/`.
- Tools: `memory_read`, `memory_write(section, text, mode: append | replace)`. Writes pass through secret redaction
  (token-shaped strings are replaced) and append to `memory/.journal` so each change can be undone from the profile.
- Victor can open and edit the file from the profile. Lines he wrote are marked and never removed by the bot.
- When the file passes its cap, the next run of a built-in consolidation routine moves old material to
  `memory/archive/`, removing at most 20% per pass (nanoMuse).
- Memory is per bot. Bots share knowledge by messaging, not by reading each other's memory.

### Accounts and usage

Bots use the same accounts as Chats. Bot projects have no account of their own, so they follow the computer default
through `account-routing.cjs`, and `limit-switch.cjs` applies. The bot profile shows the account and model it runs on
(design `angelo-phone-profile`). Usage per bot is not tracked in v1.

### Starter bots and hiring

- Templates live in `packages/core/src/bots/templates/` as Markdown with YAML front matter: name, role, mascot,
  provider, model, brief, routines (disabled) and a list of setup fields. Ops, Release and Chief ship as generic
  templates that anyone with Milagre can use; nothing in them names the-ptf/milagre, `asc.mjs` or Victor's accounts.
- **Setup card.** Adding a starter bot opens a setup card in its thread that asks for the template's fields, prefilled
  where Milagre can guess:

  | Bot | Setup fields |
  | --- | --- |
  | Ops | Projects to watch (from Milagre's Projects), GitHub repo per Project (from the remote), which checks count as CI, Linear team (if signed in). |
  | Release | Project, release commands per step (beta, OTA, store build, submit, announce), each marked as a `publish` gate; where release notes are drafted. |
  | Chief | Digest time and timezone, sources (Linear, GitHub, plus any Slack or mail MCP server present in Settings › MCP), which bots it directs. |

  The answers are written into the bot's BRIEF.md and routines, so Victor fills in Milagre's values once and edits
  them later in the profile. The release commands Victor enters for Release are added to that bot's `publish` gate
  patterns, so a new release script is gated the day it is configured.
- The routines in a template are proposed through confirmation cards after setup.
- First launch of the Bots area or the Angelo app offers "Start with Ops, Release and Chief", each individually.
- Hiring: asking the Chief ("hire a bot that triages Sentry") ends in a New bot card with the proposed name, role, brief,
  mascot and projects. Confirm, Edit, or Discard. The New bot form (compose button, "New bot") has the same fields.
- Export and import a bot as one Markdown file: configuration only, never memory, grants or history. Imported bots
  start paused. This is how teammates share bots while each runs their own.

### Mascots

Victor asked for the avatar style OpenMausBot and the other bot apps use. OpenMausBot draws a per-bot gradient mascot
with a face (two eyes, a mouth), ten selectable body shapes (cursor, blob, circle, squircle, capsule, drop, shield,
hexagon, diamond, star), ten colors and a set of expressions, or a custom image cropped circle, rounded or square
(`shared/bot-avatar.ts`, `docs/superpowers/specs/2026-08-31-mascot-shape-catalog-design.md`). Its lesson: desktop and
iOS drew the same face at different positions and drifted, so the geometry must come from one source.

For Angelo:

- One mascot definition in `packages/shared` (body path, face anchor, expression) rendered as SVG on desktop and with
  `react-native-svg` on the phone.
- v1 bodies: circle, squircle, capsule, blob, drop, shield. Colors from a fixed palette. Faces: white eyes with dark
  pupils and a smile, as in the designs (Chief squircle navy, Ops circle blue, Release capsule coral).
- Expression follows state, so status shows without a status board: idle blinks, working glances sideways, waiting on
  Victor looks at the viewer, failed looks worried, paused has closed eyes.
- Custom image upload, cropped circle; no face drawn over an image (OpenMausBot dropped that).

## Surfaces

### Angelo iPhone app (`apps/angelo`, call 9)

Expo app, bundle id `com.victorlucas.angelo`, scheme `angelo`, its own EAS project and App Store Connect record, the same
TestFlight pipeline as Milagre. iOS only, TestFlight only in v1: no App Store listing, screenshots or App Review until
Victor decides it has earned one. One paired Mac per app in v1 (call 13).

Screens:

1. **Messages home** (`angelo-phone-home`). Large title "Angelo", settings button top left. A "Needs you" card pinned at
   the top lists pending sign-offs and questions; tapping one opens the thread at its card. Below, bots and groups
   newest first: mascot, name, time, two-line preview, unread dot. Bottom: search capsule with dictation and a compose
   button (New message, New bot, New group). Search covers messages, bots, groups and routines.
2. **Bot thread** (`angelo-phone-thread`). Header with back, name and a status line ("Watching main · 3 routines"), the
   mascot opens the profile. Thread content as described above. Composer at the bottom.
3. **Group thread** (`angelo-phone-group`). Each message carries the sender's mascot and name. @ in the composer
   mentions a bot. Routine confirmation cards appear here when a routine is asked for in a group.
4. **Bot profile** (`angelo-phone-profile`). Mascot (tap to change), name, role, engine line (provider, model, account).
   Brief (editable), Routines (name, schedule or trigger, next run, switch; tap for run history and edit), Memory and
   grants (MEMORY.md with line count and last change; grants with Revoke), Projects the bot may open Chats in,
   Pause bot, Export, Delete.
5. **New bot** form and **New group** picker (2 to 6 bots, name, owner).
6. **Settings**: paired Mac, notifications (sign-offs, questions, digest time), keep-awake status, About.

Pairing and transport reuse Milagre's: QR pairing from Milagre desktop (Settings › Devices gets "Pair Angelo"), LAN
when possible, relay otherwise. Hosts live under their own secure-store key (`angelo.hosts.v1`).

**Shared connection package (call 10).** `client.ts`, `hosts-store.ts`, `relay-transport.ts`, `relay-native.ts`,
`lan-route.ts`, `routes-native.ts`, `pairing.ts`, `push-controller.ts` and the session provider move from
`apps/mobile/src` into a new workspace package (for example `packages/mobile-client`) with no behavior change, in its
own PR before Angelo starts. Both apps then import it. `notificationTarget()` learns the `angelo-bot` kind.

### Milagre desktop: the Bots area

Design `angelo-desktop-bots`. A Projects | Bots switch at the top of the sidebar. In Bots mode the sidebar shows the
Needs you row, then Bots (mascot, name, time, one-line preview, unread dot), then Groups, and "New bot or group" at the
bottom. The main pane is the thread, the same width and composer as a Chat. The right panel is the profile: brief,
routines with switches and next run, Chats the bot opened with their state, memory, grants. The header has Pause bot
and the panel toggle.

Ship behind Settings › Experimental ("Bots") until Victor turns it on by default.

### Milagre phone app

No bots UI. Bot-opened Chats show the bot's mark, and their gate requests appear in the existing inbox so Victor can
answer from either app.

## Gaps to build, in order

1. **Routines engine** (shared with the Routines work): scheduler, triggers, run history, confirmation card, executor
   interface, relay `/hook` route. The Milagre executors come from the Routines spec (call 14). Whichever work starts
   first builds the engine; the other plugs its executor in.
2. **Daemon always on:** login item, bots keep-awake reason, interrupted-run rule.
3. **Bots core:** `packages/core/src/bots/`, `angelo.db`, hidden bot projects, thread session and instructions
   snapshot, bot run executor, memory tools.
4. **Gates:** Claude `PreToolUse` hook, Codex and ACP policy answers, gate cards, grants, expiry, Settings › Bots.
5. **Milagre Chats from bots:** `chat_open` and friends, `startedBy` mark, caps, gate inheritance, completion events,
   push suppression.
6. **Desktop Bots area** behind the Experimental flag, with Ops as the first starter bot. Dogfood here.
7. **Team:** team tools and guards, Chief tools, incidents, groups, digest; Release and Chief templates.
8. **Shared mobile connection package** extracted from `apps/mobile`, no behavior change.
9. **Angelo iPhone app** with the `angelo-bot` push kind; TestFlight.
10. **Mascots** in `packages/shared` with expressions; hire flow; export and import.

Steps 1 to 6 give Victor a working Ops bot on desktop. The phone app comes after the team works on desktop.

## Risks and open questions

- **Gate coverage.** Pattern gates miss actions hidden in scripts or new tools. Mitigation: keep the pattern list in one
  file, log every gated and allowed command per bot, review after the first weeks.
- **User allow rules.** Victor's Claude settings allow many commands; the `PreToolUse` hook must run before those rules
  apply. The builder verifies this with the Agent SDK version in use.
- **Long sessions.** Quality after many compactions is unknown; the seeded-fresh-session fallback keeps the thread usable.
- **Same accounts.** Overnight runs share Victor's limits. Victor chose this knowingly; the run history shows limited
  runs.
- **Prompt injection.** Bots read PR comments, issues, Sentry events, Slack and mail. Gates are the main defense in v1.
  A taint rule (after reading untrusted content, any post or publish asks even with a grant) is a candidate for v2.
- **Daemon restarts on updates** interrupt runs several times a week during beta. Runs are not replayed; routines catch
  up at their next slot.
- **App Review** for an app that only works with a paired Mac: same situation as the Milagre phone app.
- **The Routines spec** may land with a different engine shape. If so, this design adapts to it; the bot executor and
  the confirmation card are the only hard requirements.

## Left to the builder

- Storage layout and field names, as long as the screens get what they show.
- Croner or another cron library; the polling interval of the scheduler.
- Gate pattern syntax and the exact initial list beyond the table.
- When to rotate a bot thread's provider session.
- Microcopy, except the strings shown in the designs and the card buttons.
- Launch agent mechanism (`SMAppService` or plist).
- How the Chief's digest is phrased; it must fit one push and one message.

## Prior art read for this design

| Source | What we took |
| --- | --- |
| xAI Grok Bot (x.ai/news/introducing-grok-bot, docs.x.ai/grok-bot) | Bot profile fields, groups of 2 to 6 bots with @mentions, approvals kept out of groups, Allow once / Always / Deny, expiring unattended approvals, sidebar of pinned bots, per-bot routines with next run and history. |
| milind-soni/OpenMausBot (Apache-2.0) | Assignment tree with depth and origin, confirmation card with the next three dates, 12-hour catch-up rule, Chief of staff incidents and escalations with storm limits, MEMORY.md caps, mascot avatars. |
| leepokai/Codync (Apache-2.0) | Routines MCP tool set, OR-list triggers, `(pass)`, run per session with result in the main chat, `ask_bot` with a 10-minute wait, cycle and duplicate guards, room rounds cap, compact "Messaged X" rows, no replay after restart. |
| elie222/rakazo (Apache-2.0) | "One bot, one visible thread", routines are scheduled prompts, no `schedule_create` inside runs, memory as labeled data, calm thread without tool lifecycle. |
| mandarwagh9/botroster (Apache-2.0) | Event triggers need a filter, gates decided by the host and failing closed, colour only for status. |
| nano-muse/nanoMuse (GPL-3.0, ideas only) | Grants with targets and a revoke list, 1-hour approval expiry, bounded memory consolidation, taint rule (v2). |
| CopilotKit/openmuse (MIT) | No blind retry after an uncertain external write. |
| Paseo (`paseo schedule`, `paseo heartbeat`) | Heartbeat versus fresh-agent runs, already adopted by the Routines spec. |
