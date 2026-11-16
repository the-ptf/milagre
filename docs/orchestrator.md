# Orchestrator

An Experimental box (Settings › Church › Orchestrator) that takes any request, picks the Project, role, model, account and
computer for it, and runs it as a task Chat tracked on a board. Each computer's host owns its own Orchestrator in
`orchestrator.json` (settings, tasks, owner memory); the desktop and phone read it with `orchestrator:read` and follow
`orchestrator:changed` (the phone gets the `orchestrator` signal).

## Task Chats are hidden Chats, not Subchats

A Subchat's parent must be in its own Project, and the Orchestrator spans every Project, so a task Chat is a normal Chat
marked `session.orchestrator = { taskId, hidden }`. `isHiddenTaskChat` keeps it out of every Chat list while `hidden`;
Move to sidebar clears the flag. It is the Run Chat pattern, with no "shown while waiting" exception: a task that needs
the owner shows in Needs you on the board instead.

## Routing

`orchestrator/router.cjs` asks the router model (Haiku by default) for a Project, role and title over each Project's hints
(its AGENTS.md, CLAUDE.md or README, or hints the owner typed) and the owner memory. When the model is missing, slow or
names a Project that isn't listed, keyword matching on names and hints decides. With no Project, the task waits in Needs you
unless Settings say Best guess.

The role sets provider, model and effort. The account is the least used one under its limit, pinned on the task Chat as
`orchestrator.accounts[provider]`: `startAgentTurn` resolves it through `taskAccounts` in `runtime/orchestrator-wiring.cjs`
instead of the Project's account, and the limit-resume check compares against it too. Every task gets its own Worktree; when
making one fails it runs in the Project folder.

## Computers

With Use other computers on and Drive other computers on (Settings › Phone & sharing), the host asks each paired computer
for `orchestrator:capacity` (CPU, free memory, busy Chats, Projects by Git origin) and, when another computer has the same
Project with more room, starts it there with `orchestrator:start-here`. The local task keeps `remoteComputerId` and
`remoteTaskId`; Move to sidebar and Undo go to that computer. That computer's own Orchestrator settings decide its autopilot.

## Autopilot

`orchestrator/autopilot.cjs` watches approvals and questions in task Chats only. Anything `isIrreversible` (merging,
pushing to main or with force, deleting, deploying, publishing, paying, messaging someone) always waits for the owner.
Otherwise confidence and the owner's trust for that kind of decision pick: answer now, answer after the veto window, or ask.
A question is answered only with its listed options. The owner stepping in during the veto window cancels the answer and
counts as a correction; corrections weigh three times an answer in `trustScore`.

## Owner memory

The first run reads Claude Code, Codex, Antigravity and Kiro instruction and memory files on this computer and has the router
model keep durable notes; without a model it keeps bullet rules that say always, never, must or prefer. The owner can untick,
delete, read again or forget. Memory syncs across paired computers by `orchestrator:memory:merge`: the copy with the newer
`updatedAt` wins on both sides, so two computers editing at once keep the later one.
