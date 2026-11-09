# Routines: agents that run on a schedule or when something happens

Date: 2026-10-16. Status: design after builder check, awaiting Victor's review.

## Goal

Victor keeps checking whether CI went green or a reviewer commented, then telling an agent to act. He also wants work
to start on its own when something happens elsewhere: a Linear issue gets the `agent` label, Sentry reports a crash.
Routines make that happen without anyone sending a message.

A **Routine** sends a prompt to an agent when its trigger fires. There are two shapes, and one record covers both:

1. **Heartbeat:** a schedule that sends its prompt back into the Chat that set it. Used for babysitting a PR until it
   merges. The agent keeps its context.
2. **Trigger:** a schedule, a Linear event or a webhook that starts a fresh Chat for each run, in a new worktree.

Release, OTA, dependency and hygiene chores are out: they belong in CI workflows.

## Decisions

| Question | Decision |
| --- | --- |
| Shapes | Heartbeats (prompt into the creating Chat) and triggers (fresh Chat per run). One data record with a polymorphic target, as Paseo and T3 Code do. |
| Who creates | Agents through milagre MCP tools, and Victor through a **New routine** form on desktop and phone. The form is plain fields, no agent in the loop (T3 style). Victor rejected a "describe it in words" box. |
| Event sources | Linear (polled), Sentry and generic webhooks (through the relay), and cron/interval schedules. GitHub is not an event source: heartbeats poll it with `gh`. |
| Linear | Polled about once a minute with the existing Linear sign-in. Events: issue assigned to me, label added, moved to a state, new comment. A comment on an issue already linked to a Chat goes into that Chat. |
| Webhooks | Public URL per routine on the relay, `https://relay.milagre.cloud/hook/<secret>`. The Durable Object queues deliveries while the Mac is offline. Only Victor creates webhook routines, in the UI; agents never mint a URL. |
| Where a trigger run works | New worktree per run by default (Linear reuses the issue branch naming). The form also offers the Project folder. |
| Permission mode | Set on the routine. Agent-created routines take the creating Chat's mode (as #435 does for delegations). A run that hits an approval pushes to the phone and waits. |
| Mac asleep or off | Milagre keeps the Mac awake while any routine is enabled. The daemon already survives quitting the app. |
| Busy Chat | A heartbeat that fires while its Chat has a turn running is skipped and logged. The next one runs on schedule. |
| Quiet runs | An agent ends a run that found nothing to do with `(pass)`. A quiet heartbeat leaves a one-line divider in the Chat ("10:30 · quiet: CI green, waiting on jefo3") and no push. Back-to-back quiet dividers merge into one line. A quiet trigger run archives its Chat. |
| No recursion | Runs started by a routine don't get the create tools. |
| Computers | Each Mac runs only its own Routines. A paired desktop lists and manages every paired computer's Routines as its own (all `routines:*` calls, `routines:changed` included); each row names its Mac once there are other computers, and a new Routine runs on the computer of the Project or Chat it targets. A paired Mac is already trusted with full-permission Chats, so reading or rotating a webhook URL from it is no new exposure; the URL is never kept in the offline cache. The phone lists the Mac it is paired to. Changed 2026-10-20: the first version refused Routine RPCs from paired Macs. |
| Several events at once | Each Linear or webhook event gets its own Run, up to 3 at once per Routine. The rest queue in order, persisted. Schedule triggers never overlap. *My call.* |
| Existing-Chat target | Only schedule triggers can target an existing Chat (a heartbeat). Linear and webhook triggers always start new Chats. *My call.* |
| Heartbeat end | Every heartbeat ends. The form doesn't offer "never" for heartbeats, and agent-created ones default to 7 days unless the agent sets a run limit or a date. Trigger routines may run forever. *My call.* |

Rejected:
- Routines in the Angelo companion app only. Another Chat is designing Angelo (persistent bots); heartbeats for PR
  babysitting stay in Milagre regardless.
- A natural-language create box with an agent preview.
- Steering the running turn with a heartbeat.
- Queueing beats behind a busy turn. T3 piles them up (#16818).
- Hiding heartbeat prompts entirely. Paseo does this, and then the Chat gives no sign it is being watched.

## Non-goals and anti-goals

Non-goals for this round:
- GitHub event triggers.
- Slack or email triggers.
- A run-history screen.
- A webhook deliveries dialog.
- Catch-up of runs missed while the daemon was down.
- Routines on a Named Link.

Anti-goals. Any of these makes the build a failure even if it technically works:
- **Beats that pile up.** A Chat that receives five stale "check CI" prompts after a long turn.
- **Invisible babysitting.** A heartbeat that runs with no trace in the Chat, so Victor can't tell it is alive.
- **Wrong run status.** A failed run recorded as succeeded (T3 #17889).
- **Lost deliveries.** A webhook delivery acknowledged by the relay, then lost when the Mac restarts (T3 #18810).
- **Payload as instructions.** Webhook or issue text that can instruct the agent. It is always passed as data.
- **Unbounded babysitting.** A heartbeat with no way to end. Every heartbeat has an end: run limit, expiry, or the
  agent deleting it.

## Terms

Add to GLOSSARY.md:
- **Routine:** a saved prompt plus a trigger plus a target.
- **Heartbeat:** a Routine whose target is an existing Chat.
- **Trigger:** used loosely for a Routine whose target is a new Chat. Strictly, the trigger is the thing that fires
  it: schedule, Linear or webhook.
- **Run:** one firing of a Routine.
- **Quiet run:** a Run whose agent answered `(pass)`.

## Data model

Sketch. The builder may adjust names. Lives in `packages/shared/src/model.ts`:

```ts
type RoutineTrigger =
  | { kind: "schedule"; cron: string; timezone: string }            // "every 15 min" compiles to cron
  | { kind: "linear"; workspace: string; event: "assigned" | "label-added" | "state" | "comment";
      team?: string; label?: string; state?: string }
  | { kind: "webhook"; hookId: string; signing?: { header: string; secretRef: string } };

type RoutineTarget =
  | { kind: "chat"; chatId: string }                                // heartbeat
  | { kind: "new-chat"; projectPath: string; workspace: "worktree" | "project" };

interface Routine {
  id: string;
  name: string;
  prompt: string;              // may contain {{placeholders}} for the trigger's fields
  trigger: RoutineTrigger;
  target: RoutineTarget;
  provider: ModelProvider; model: string; permissionMode: string;
  enabled: boolean;
  createdBy: { kind: "agent"; chatId: string } | { kind: "user" };
  maxRuns?: number; expiresAt?: number;  // "Stop after"
  nextRunAt?: number; lastRunAt?: number;
  runCount: number;
}

interface RoutineRun {
  id: string; routineId: string;
  scheduledFor?: number; startedAt: number; endedAt?: number;
  status: "running" | "acted" | "quiet" | "failed" | "skipped-busy" | "missed";
  chatId?: string; summary?: string; error?: string;
}
```

Storage is the builder's call, with one constraint: the scheduler must see every enabled Routine even when its Project is
idle-unloaded (ADR-0009). One option is a daemon-level `routines.db` next to the other daemon state. Keep the last 50
Runs per Routine.

A heartbeat whose Chat is archived or deleted completes itself, as Paseo does with `ScheduleTargetGoneError` and
`sweepOrphanedSchedules`. So does a trigger whose Project is gone.

## Scheduler

- **Where it runs:** in the daemon. One tick about every second. Each Routine is claimed and advanced in one store
  update, so a restart can't fire it twice.
- **Cron:** five fields with an IANA timezone; the form's default is the Mac's zone. A small pure-JS cron library
  is fine (it doesn't touch the mobile fingerprint), as is a hand-written parser like Paseo's
  (`packages/protocol/src/schedule/cron-expression.ts`). Builder's call.
- **Missed slots** (daemon down or Mac asleep) are not replayed. *My call*, matching Paseo and T3. Record one
  `missed` Run, then advance past now.
- **Interrupted runs:** on daemon start, a Run left `running` becomes `failed` ("daemon restarted").
- **Overlap:** a schedule Routine never has two Runs at once. A Linear or webhook Routine runs one Run per event, up to
  3 at once. Further events wait in a persisted queue, in order, and a webhook delivery stays acknowledged only once it
  is in that queue.
- **Run limit and expiry:** a Routine past `maxRuns` or `expiresAt` turns itself off.
- **Keep-awake:** `packages/core/src/keep-awake.cjs` (which spawns `caffeinate -i`) holds while any Routine is
  enabled. Known limit: `caffeinate -i` doesn't stop lid-close sleep on battery. Say so in the UI's empty or help text,
  and nowhere else.

### Heartbeat run

1. If the Chat has a turn running, record `skipped-busy` and stop.
2. Otherwise send the prompt into the Chat with `context: { kind: "routine-run", routineId, name }`, following how
   `continueAfterLimit` sends `account-switch` (`agents/chat-host.cjs`).
3. The transcript renders that message as a divider ("Heartbeat · 10:15"), not as a user bubble.
4. When the turn ends:
   - **Reply starts with `(pass)`:** the run is `quiet`. The reply collapses into the divider text, using the words
     after `(pass)` as the summary (cap about 80 characters), and no push is sent.
   - **Otherwise:** the run is `acted`. The reply shows normally and the usual completion push goes out.
5. Back-to-back quiet dividers merge ("3 quiet checks · last 10:30: CI green").

### Trigger run

1. Create the worktree (or use the Project folder) the way `worktree:create` does (`runtime.cjs`).
2. Start a Chat with the Routine's provider, model and mode. Its first message carries
   `context: { kind: "routine-run", ... }`.
3. **Linear runs:**
   - The run reuses the Chat-from-issue path: issue branch naming, the `linear-issue` card, and the move to In
     Progress when that setting is on.
   - The first message shows both the issue card and the routine divider. Extend the `linear-issue` context with an
     optional `routine: { id, name }` rather than adding a third kind. *My call.*
   - The first message is the Routine's prompt, not `issueFirstMessage` (`packages/shared/src/linear-issue.mjs`).
     `issueFirstMessage` puts the description inline as the instruction.
   - The issue fields fill `{{issue.key}}`, `{{issue.title}}`, `{{issue.description}}`, `{{issue.url}}` and
     `{{issue.labels}}`.
4. **Webhook runs:** fill `{{body.path}}`, `{{headers.name}}`, `{{query.name}}`, `{{body}}`, as T3 does.
5. **Untrusted data:** issue text and webhook payloads always reach the agent fenced in a block labelled as untrusted
   data, never as instructions. Every value that comes from outside Milagre expands to a delimited data block,
   whatever its length: `{{issue.description}}`, `{{issue.title}}`, `{{issue.state}}`, labels, names, `{{body}}`,
   header and query values. Only Milagre or Linear identifiers (`{{issue.key}}`, `{{issue.url}}`, `{{date}}`,
   `{{time}}`) substitute inline. The autocomplete preview shows the substituted value.
6. **Quiet run:** the Chat is archived and no push is sent.
7. **Approvals:** push to the phone and wait, the same as any Chat.

### Linear polling

- One poller per signed-in workspace that has a Linear Routine, about every 60 s, using the sign-in already in
  `packages/core/src/linear/`.
- Only changes after the Routine was created count. Creating one doesn't backfill old issues.
- Dedupe per Routine by issue plus event, keeping a cursor such as `updatedAt`.
- **Comment events.** All of this is *my call*:
  - They need a Linear Routine with `event: "comment"`. In the form, that event hides **Each run** and says
    "Comments go into the Chat linked to the issue".
  - A comment on an issue whose worktree carries that `linearIssue` goes into the most recently active, unarchived
    Chat in that worktree, with a routine-run divider. A comment on an unlinked issue is ignored.
  - If that Chat is busy, the comment waits until the turn ends. It is a person talking, not a beat, so it isn't
    skipped.
  - Comments created by Milagre's own Linear OAuth app (a bot actor) are ignored, so nothing loops. Victor's own
    comments go through: replying to the agent from Linear is a use case.
- The poller must not trip the rate limits the busy-Mac work hit (#368). Back off on errors.

### Webhooks through the relay

- **Today:** the relay (`apps/relay/src/worker.ts`) accepts only `/health` and the WebSocket routes.
- **New:** `POST /hook/<secret>` on the Worker.
  - The secret routes to the right Mac's Durable Object. The mapping is the builder's call. Whatever it is must not
    let anyone enumerate hooks or reach another Mac. The Mac checks the secret again.
  - The DO **stores** the delivery before answering 202 and holds it up to 24 h. Payload cap about 256 KB.
  - It forwards over the Mac's existing socket.
  - The Mac acknowledges only after it has persisted the delivery. This avoids T3's lost-on-restart bugs.
- **Signing:** an optional HMAC check per Routine: header name plus secret. Sentry's `Sentry-Hook-Signature` is the
  first case.
- **The URL lives in the form only.** Copy and Rotate buttons on webhook routines. Rotating kills the old URL at once.
- **Deploy:** the relay goes out before the desktop release that uses it. Deploy command and gotchas are in the memory
  note `milagre-public-relay`.

## Agent tools

Added to the per-Chat milagre tools next to `tasks_set` (`runtime.cjs` `extraTools`), so Claude, Codex and
Antigravity all get them. Flat zod schemas, as `chat-plan-tools.cjs` requires.

| Tool | Does |
| --- | --- |
| `routine_list` | Lists the caller's Project's Routines with their status and next run. |
| `heartbeat_create` | Creates a heartbeat on the calling Chat. Args: `name`, `prompt`, `cron` or `every`, `timezone?`, `maxRuns?`, `expiresIn?`. Upserts by name plus Chat, so an agent re-registering "babysit-pr" refreshes it rather than duplicating it. |
| `routine_create` | Creates a schedule or Linear trigger in the caller's Project. Webhook triggers are refused with a message pointing to the New routine form. |
| `routine_update` | Changes the prompt, cadence, filters, limits or enabled state of a Routine in the caller's Project. |
| `routine_delete` | Deletes one Routine. |
| `routine_run_now` | Fires one Run without moving the schedule. |

- Runs started by a Routine don't get `heartbeat_create` or `routine_create`.
- Agent-created Routines take the creating Chat's provider, model and mode, unless args override them.
- Each tool's description tells the agent to end a run with `(pass) <short reason>` when nothing needs doing.
- Add the tool names to the auto-approved milagre set (`agents/permissions.cjs`).

## UI

Designs are in this Chat's canvas, group **Routines**:

| Design id | What |
| --- | --- |
| `routines-desktop` | Desktop Routines page |
| `routines-new-sheet` | New routine form, desktop, including `{{` autocomplete |
| `routines-phone` | Phone Routines list |
| `routines-new-phone` | New routine form, phone |
| `routines-heartbeat-chat` | Heartbeat runs in a phone Chat |

Victor's note on the phone designs: they don't look close enough to the real app. **Build the phone screens from the
app's own components** and treat the mockups as layout and content only:
- `ListRow`, `Button` and `HeaderButton` from `apps/mobile/src/ui.tsx`
- the formSheet route
- the native switch with the ink tint, as the MCP screens use it
- Hugeicons, not Lucide

The desktop screens follow `Settings.tsx` groups and the sidebar tool buttons.

### Desktop

**Entry point.** A Routines icon button sits in the sidebar tools row: Canvas, Search, **Routines**, Filters. It opens
the Routines page in the main area.

**Routines page:**
- Title "Routines", a one-line description, and a **New routine** button at the top right (ink primary button).
- Filter chips: All, Heartbeats, Triggers, Paused.
- Two groups headed by an icon and a title only: pulse **Heartbeats** and zap **Triggers**.
- **Each row:**
  - Icon tile, title, and one meta line. For a heartbeat: cadence, Chat and end condition. For a trigger: source,
    filter, model and mode.
  - On the right: "Next 10:45" for a heartbeat, or the last issue and time for a trigger. Then an enable switch and a
    ⋯ menu with Edit, Run now, Open Chat (heartbeat) or Open last Chat (trigger), and Delete.
- No run history on the row. Victor removed it twice: what a run did lives in its Chat.

**Sidebar:** a Chat with a heartbeat shows a small pulse icon on its row.

**New routine form** (also used to edit):
- **Name.**
- **Trigger:** a switch between Schedule, Linear and Webhook. The fields below change with it:
  - **Schedule:** every N minutes or hours, or at a time on chosen weekdays, plus a timezone. Raw cron under an
    "Advanced" disclosure.
  - **Linear:** When (assigned to me, label added, moved to state, new comment), Label, State and Team.
  - **Webhook:** the URL with Copy and Rotate, and optional signing (header plus secret).
- **Project,** and **Each run:** New worktree, Project folder, or An existing Chat (which makes it a heartbeat).
- **Model and mode.**
- **Prompt.** Typing `{{` opens an autocomplete of the trigger's fields with a live example value, filtering as you
  type; Enter or Tab inserts.
- **Stop after:** never, after N runs, or on a date. A heartbeat has no "never" and defaults to 7 days.
- **Linear and Webhook triggers** don't offer "An existing Chat".

### Phone

**Entry point.** A Routines button in the bottom dock next to Canvas, Link and Settings. *My call:* Victor didn't pick
between the dock and Settings. The screen is pushed with a back button and has a **+** at the top right that opens the
form.

**List:** the same groups and rows as desktop, using native switches.

**New routine form:** a formSheet. It has a round close button, three trigger tiles with icons (the selected one ink),
grouped cards of `ListRow`s with leading icons, the Prompt box with the same `{{` autocomplete, and a fixed ink
**Create routine** pill at the bottom.

**Chat header:** a Chat with a heartbeat shows a routine button at the top right that opens its heartbeat in the form.

### Transcript (both platforms)

- **Heartbeat set:** when an agent creates a heartbeat, its tool call renders as a "Heartbeat set" card: name, cadence,
  end condition, and a Stop button.
- **Dividers:** routine runs use the existing divider pattern (`AccountSwitchDivider` and `ChatReloadDivider`):
  - an acted run shows "Heartbeat · 10:15" followed by the agent's normal reply
  - a quiet run is a single divider line with the summary
  - a skipped-busy run leaves nothing in the Chat; it is logged only
- **Next check:** "Next check 10:45" under the last divider while the heartbeat is on.
- **Wiring:** a new `context.kind` needs a type in `ChatContext`, a shared guard, a desktop branch in
  `ChatComposer.tsx`, a mobile branch in `app/chat.tsx` and a mobile accessibility label.

## Rollout

- **Flag:** behind a **Routines** switch in Settings › Experimental, off by default. *My call*, matching how recent
  features shipped.
- **Order:**
  1. Deploy the relay.
  2. Ship the desktop beta.
  3. Publish the phone OTA after merge, if main's fingerprint still matches the TestFlight build. Otherwise it waits
     for a build, as other OTAs have.
- **Remote peers:** paired desktops reach every Routine RPC and hear `routines:changed` (`peer-policy.cjs` denies none).
  The window routes them to the Routine's computer, with Routine, Run and target ids qualified by it
  (`computer-routing.cjs`). The phone, paired to one Mac, reaches that Mac's.

## Prior art read for this design

- **Paseo** (`getpaseo/paseo`, `packages/server/src/server/schedule/`):
  - heartbeats as schedules targeting an agent
  - a 1 s tick with claim-then-advance
  - missed runs skipped
  - upsert by name plus target
  - permanent-failure completion
  - Its gaps: a busy agent drops the beat, and beats are hidden in the transcript.
- **T3 Code** (`pingdotgg/t3code`, `apps/server/src/scheduledTasks/`, PR #3638, webhooks #15085):
  - a `threadId` or new-thread target
  - interval, fixed-time and webhook schedules
  - relay store-then-deliver with a 24 h hold
  - HMAC signing and placeholders
  - a Settings form on desktop and phone
  - Its open bugs to avoid: #17889, #16818, #19985, #16833, #18810 and #18632.
- **Codync and OpenMausBot** for `(pass)`, coalesced missed runs and blocking recursion.

## Left to the builder

- Storage layout and file locations, within the idle-unload constraint.
- Cron library or a hand-written parser.
- How the relay maps a hook secret to a Mac.
- Exact polling interval and backoff.
- Split into PRs. A sensible order:
  1. Daemon scheduler, heartbeats and tools.
  2. Desktop UI.
  3. Linear triggers.
  4. Relay webhooks.
  5. Phone UI.
- Copy for empty states and errors.
