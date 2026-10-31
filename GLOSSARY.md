# Milagre

Milagre coordinates coding agents across projects and git worktrees on one machine. This glossary names the concepts users and agents share.

## Language

### Work

**Account**:
A saved Claude, Codex or Antigravity sign-in on one computer. Each provider has a computer default **Account**. Each **Project** and **Named Link** can select its own **Account** or inherit that default. Desktop and paired phones share these selections. A running reply and its active subagents keep their existing **Account**; subsequent idle turns use the owning Project or Named Link's selection. Switching the viewed Project never changes an Account assignment.

**Usage limit**:
The provider plan's cap (Claude's session or weekly limit, Codex's usage limit) that stops a turn until it resets. The stopped reply shows a limit card offering the Project's other **Accounts** for that provider; picking one assigns it to the Project or Named Link and continues the Chat. With auto-switch on (Settings › Experimental), Milagre picks the next signed-in **Account** that isn't limited by itself. Not the API's short-term rate limit, which only slows a turn down.

**MCP server**:
A tool server a provider loads into a Chat. A command server is a process on the Mac; a URL server is remote. Settings › MCP lists each account's servers and their status. Not to be confused with Milagre's own `milagre` server, which every Chat gets and which Settings › MCP does not list.

**Everywhere server**:
An **MCP server** saved in Milagre's own list instead of a provider's config. Milagre adds it at Chat start to every provider and account whose config has no server of that name, so it works in Milagre Chats on Claude, Codex and Antigravity but not in terminal CLI sessions. New servers added in Settings › MCP default to Everywhere.

**Project**:
A git repository that has been opened in Milagre at least once. Every **Worktree** of the repository belongs to the same **Project**, whichever of its folders was opened.
_Avoid_: folder, workspace, repo

**Chats home**:
The internal **Project** that holds a **Computer**'s **Chats** without a **Project**, one **Worktree** per **Chat**. A git repository at `~/.milagre/chats`, made on first use. Never shown as a **Project**: the UI calls it "No project" and lists its **Chats** in a **Chats** group. See ADR-0011.
_Avoid_: quick chats, default project

**Worktree**:
A git working directory of a **Project**, the main checkout included. A **Worktree** is active while git lists it and its folder exists; only active **Worktrees** appear on the canvas.
_Avoid_: branch (a **Worktree** has a branch, it isn't one)

**Main branch**:
The branch a **Project**'s remote names as its default (`origin/HEAD`), else `main`, else `master`. Source branch sync fast-forwards the branch selected for a new **Worktree** from its remote, together with the **Worktree** that has it checked out when that one is clean.
_Avoid_: base (the base is whatever branch a **Worktree** started from, which may not be the main branch)

**Linear issue**:
An issue in the Linear workspace connected on a **Computer**, named by its key (`ENG-123`). A **Worktree** has at most one: the link stored on it when there is one, else the first key in its branch name that matches one of the workspace's team keys. Explicitly unlinking an issue suppresses branch detection until another issue is linked. Milagre only reads it; Linear's GitHub integration moves its status.
_Avoid_: ticket, task (Linear's own word is issue)

**Chat**:
One conversation with one agent. A Project Chat is bound to exactly one **Worktree**; a named Link's shared Chat owns one isolated **Worktree** in each member **Project**. An ordinary **Worktree** can have many **Chats**; a shared Chat's owned Worktree does not receive an independent editable Project Chat.
A **Chat** started with No project is a **Chat** in the **Chats home**, on its own **Worktree**; it has no Git controls.
Chats can be marked **Done**, reopened, or archived automatically after their Done retention period. **Delete** immediately removes the conversation. Starting another Chat leaves existing Chats and their menu actions available. See ADR-0012.
An archived **Chat** stays readable from a linked side but is never chosen to receive a **Delegation**.
_Avoid_: session, thread (the providers' names for the agent process behind a **Chat**)

**Background task**:
Work that outlives the **Chat**'s turn and reports back to it by itself: a background subagent, a command the agent ran in the background, an MCP task, or an advisor. A **Chat** whose turn ended while one still runs is "in the background", with how many still run, on every surface; a failed last turn shows as failed instead. Anything that would end the agent process (handing the **Chat** to another provider, Reload, a move to another folder) is refused until the background tasks running in that process finish. After a **Usage limit**, switching to another Account or provider stops the limited process's remaining tasks and continues the Chat from its saved progress.
_Avoid_: job, child (Codex's term for a subagent)

**Browser page**:
A page in a Chromium browser on the host that a **Chat** may view and control. It belongs to the **Chat** whose agent process started its browser, or to a **Chat** the user attached that browser to. See ADR-0006.
_Avoid_: tab (a browser's own UI term), session (the page's sign-in state is part of it, not a separate thing)

**Terminal**:
An interactive shell the user opens in a **Chat**. It starts in that **Chat**'s **Worktree** (or a shared Chat's workspace folder before its first Worktree is created) with the user's own environment and the shell chosen for that computer. Automatic selection uses installed zsh on Linux or the user's login shell otherwise; changing the choice applies only to new **Terminals**. It belongs to the **Chat**: other **Chats**, even in the same **Worktree**, do not see it, and the **Chat**'s agent neither reads nor types in it. A **Chat** can have several. A **Terminal** keeps running when the desktop app closes, and ends when its shell exits or its **Chat** is archived. See ADR-0008.
_Avoid_: console, shell (the program running inside a **Terminal**)

**Task list**:
A **Chat**'s tree of tasks, at most three levels deep, written by the agent with Milagre's `tasks_set` and `task_update`. Saved with the **Chat**; a provider's own todo list fills it until Milagre's tools take over.

**Phase**:
Where a **Chat**'s work is (Start, Plan, Build, Test, Review, Merge, Release, Done), set by the agent with `phase_set` and drawn on the Tasks pill's phase graph.

### Linking

**Named Link**:
A named, selectable set of two or more **Projects** in the desktop sidebar. Its shared **Chats** each create their own set of isolated **Worktrees**, one per member Project, and have one canonical conversation. The agent can edit all Worktrees owned by that Chat. Editing a Link's members changes only Chats started afterwards. Named Links do not create or replace canvas Links. See ADR-0005.

**Link**:
A symmetric, persistent relationship between two **Link** endpoints, each a **Project** or a **Worktree**. The user draws it on the canvas, or an agent makes one between two **Worktrees** with `worktree_link`. Every **Chat** on either side sees the other side's state and can make a **Delegation** to it. A **Link** reaches one hop only: X–Y and Y–Z do not let X see or delegate to Z. It has no type and lasts until the user removes it or a **Worktree** endpoint stops being active. A **Project** endpoint stands for all of that project's active **Worktrees**, including ones created after the **Link**.
_Avoid_: Connection (the typed, possibly temporary relationship in spec 001, a separate feature), vínculo

**Delegation**:
A request from a **Chat** for work by another **Chat**, delivered as a message to it and carried out by that **Chat**'s own agent. The receiving **Chat** is on the other side of a **Link**, or in any **Worktree** of the requesting **Chat**'s own **Project**, which needs no **Link**. The requesting agent picks the receiving **Worktree** and **Chat**, opening a new **Chat** when none fits. It appears there as a message from the requesting **Chat**, never as the user's. If the receiving agent is mid-turn, it steers that turn; if it is waiting on the user, the **Delegation** waits too. Across a **Link**, the requesting agent never edits the other side's files itself. When the receiving agent finishes, a **Delegation report** appears in the requesting **Chat**.
_Avoid_: remote edit, cross-worktree edit

**Delegation report**:
A summary of what the receiving agent did for a **Delegation**, posted to the requesting **Chat**. Its agent gets it with the start of its next turn. Outside a **Negotiation** it never starts a turn there on its own.

**Negotiation**:
A back-and-forth of **Delegations** between two **Chats**, across a **Link** or inside one **Project**, where each **Delegation report** starts a turn on the other side, until one agent concludes it with a summary of the agreement. The requesting agent decides on its own that a request needs a **Negotiation**, and only it can; the user never has to ask for one, and the receiving side can't turn a **Delegation** into one. It stops after at most 10 rounds, when the user stops it, and pauses while either side waits on the user.
_Avoid_: consensus mode, auto-chat

### Routines

**Routine**:
A saved prompt plus a **Trigger** plus a target, kept by the **Computer**'s daemon so it fires while no window is open. Off until the Routines switch in Settings › Experimental is on.

**Heartbeat**:
A **Routine** whose target is an existing **Chat**: on a schedule, Milagre sends its prompt back into that **Chat** as a new turn. The **Chat**'s agent sets it on its own **Chat** with Milagre's `heartbeat_create`. Every **Heartbeat** ends: after 7 days by default, at most 30, after its maximum **Runs**, when its **Chat** is archived or gone, or after three failed **Runs** in a row.
_Avoid_: reminder, cron job

**Babysit**:
A **Heartbeat** Milagre adds to a **Chat** that opened a PR, when Babysit PRs is on. It checks the PR itself and wakes the agent only when something changed.

**Trigger**:
What fires a **Routine**: a schedule, a Linear event or a webhook. Used loosely for a **Routine** whose target is a new **Chat**.

**Run**:
One firing of a **Routine**. It acts, is quiet, fails, or is skipped because its **Chat** was busy or the **Computer** missed its time.

**Run Chat**:
A **Chat** a **Run** opened. It lives in its **Routine**'s Runs list, out of the sidebar, until you send it a message, pin it or rename it.

**Quiet run**:
A **Run** whose reply, after its last tool step, starts with `(pass)`. Its divider collapses, its reply is hidden, and it sends no notification.

### Bots

**Bot**:
A persistent named teammate on one **Computer**: name, role, brief, mascot, model, memory, **Routines** and one **Bot thread**. A **Bot**'s **Run** lands in its **Bot thread**. Its home is a hidden **Project** in the daemon's data folder (ADR-0010). Behind Settings › Experimental › Bots.
_Avoid_: agent (the provider process behind any **Chat**), assistant

**Bot thread**:
The **Bot**'s one ongoing conversation with the user, an ordinary **Chat** in its home. It never ends; old context is compacted.

**Group**:
A thread with the user and two to six **Bots**. A **Group** has no agent of its own.

**Starter bot**:
A template (Ops, Release, Chief) that ships with Milagre, filled in once from a short setup card.

**Gate**:
An action class that always needs the user's **Sign-off**: merge, publish, post as the user, delete, spend. A **Chat** a **Bot** opened runs under that **Bot**'s **Gates**.

**Sign-off**:
The user's answer to a **Gate**: Allow once, Always for the **Bot**, or Deny. One left unanswered for an hour expires and counts as denied.

**Grant**:
A standing "Always for this bot" answer for one **Gate** and target, revocable.

**Assignment**:
One **Bot** asking another to do something, tracked by the daemon until it is answered or expires.

**Digest**:
The Chief's daily summary, the only scheduled push.

**Mascot**:
A **Bot**'s avatar: a body shape, a color and a face whose expression follows the **Bot**'s state.

### Computers and devices

**Computer**:
A Mac running Milagre, whose daemon owns its **Projects**. "This Mac" is the **Computer** a window runs on; other **Computers** can be paired to it.
_Avoid_: host, machine, server (code says host; the UI says computer or Mac)

**Device**:
A phone or **Computer** paired to a Mac. That Mac's Settings › Devices lists each one, says whether it is connected now or when it was last seen, and removes it.
_Avoid_: client (any connection to the daemon, this Mac's own window included)

## Relationships

- A **Project** has one or more **Worktrees**; an ordinary **Worktree** has one or more **Chats**. A named Link's shared **Chat** owns one **Worktree** per member **Project**.
- A **Computer** has one **Chats home**, which holds one **Worktree** per project-less **Chat**.
- A **Chat** has zero or more **Terminals**; each **Terminal** belongs to exactly one **Chat**.
- A **Link** joins exactly two endpoints; each endpoint is a **Project** or a **Worktree**.
- A **Delegation** goes from one **Chat** to one other **Chat**, along exactly one **Link**, or along none inside one **Project**.
- A **Negotiation** involves exactly two **Chats** and is made of **Delegations** along one **Link**, or inside one **Project**.
- A **Project** lives on exactly one **Computer**, whose daemon is its only writer (ADR-0003).

## Example dialogue

> **Dev:** "X and Y are linked. In X's chat I asked for the new endpoint to be wired into the frontend."
> **Domain expert:** "Then X's agent makes a **Delegation** to a **Chat** in Y. Y's own agent edits Y. X only gets the **Delegation report**."
> **Dev:** "And if the two have to agree on the payload shape first?"
> **Domain expert:** "X's agent opens a **Negotiation** by itself. Each report starts the other side's turn until one of them concludes."

## Flagged ambiguities

- "Connection" in spec 001 and "Link" here are different features: spec 001's Connection is typed and can be temporary; a **Link** is untyped and persistent.
- The UI and README say "workspace" for what this glossary calls a **Project**.
