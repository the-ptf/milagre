---
name: orchestrate
description: Run a change as an orchestrator. You explore and decide, then cheap subagents carry out briefs that leave nothing to decide. Use when the user asks you to orchestrate, dispatch agents or fan out work, or for a multi-file change where the design is clear but the edits are long.
---

# Orchestrate

You own every decision. Subagents only type. A brief that asks a small model to "figure out" something returns a plausible guess, and you pay for it twice: once to run it and again to find the guess.

## 1. Research the unknowns first

Before you design, list the facts you don't have: how another tool does it, an API's shape, what a library supports. Send each to one research agent on a mid-tier model (Sonnet), in the background, with a word limit and a request for evidence (file paths, quoted code, links) and for anything it could not verify to be marked. Keep exploring the code while it runs. Treat its answer as a claim to check against the code, not as the design.

## 2. Explore until you can write the diff in prose

Read the code yourself; don't delegate it. You are done exploring when, for every file that changes, you can say:

- which functions, props, types and CSS rules change, and how;
- the exact new names: props, data attributes, helpers, labels;
- the snippets where getting it wrong costs most (state handoffs, async races, caches), written out as code;
- what stays, so nobody "cleans up" something that callers still use.

Settle product decisions here as well. If the user's request leaves one open and the code doesn't answer it, ask the user now with your question tool, not after the agents have finished.

## 3. Split by file ownership

Give each agent a disjoint set of files, then run them in parallel in the same worktree. Shared contracts (a prop that one agent adds and another passes) are fixed in both briefs, word for word. If two edits must touch one file, give it to one agent or run them in sequence.

Use the cheapest model that can follow a precise brief (Haiku) for execution. Use a stronger one only where a step still needs judgment, and say why in your own notes.

## 4. Write briefs a careless reader can't misread

Every brief contains:

1. Repo path and the rules: stay in the worktree, never `git stash`, don't commit.
2. **You own:** the exact file list. **Don't touch:** the files the other agents own, named.
3. The goal in two sentences, so a reader who hits a surprise knows the intent.
4. Numbered changes, each one bounded, with code for the subtle parts and the literal strings (labels, aria, test ids).
5. Known transient breakage: "type errors about X while agent B is still working are expected; re-run once after a few minutes."
6. Verification commands that must pass, and the report format: files changed, a summary, the output tail.

Match the repo's conventions in the brief itself: its check commands, comment style, and any rules from AGENTS.md (shared UI primitives, platform sync, OTA limits).

## 5. Integrate and verify yourself

When the reports come back, read the diff. Don't trust the summaries. Then:

1. Run typecheck, lint and unit tests once yourself on the combined tree.
2. Hand test updates (end-to-end checks that relied on removed UI) to one more agent, with a mapping from each old selector to its replacement.
3. Run the real app or its UI checks for every screen you touched, and look at the screenshots.
4. Fix small integration gaps yourself; send larger ones back to the agent that owns the file, using the same agent so it keeps its context.

## 6. Report

Tell the user what changed, what you verified and how, and the decisions you made on their behalf, each with its reason. List anything you skipped or that remains open, and say why.

## In Milagre

- A brief that should run as its own Chat in this Project goes through `delegate` with chat `"new"`: in this Worktree, or in one you made with `worktree_create` when the edits must not collide. Its Delegation report comes back with your next turn, so end the turn instead of polling. `chat_start` is fire-and-forget. Once its work is merged or pushed, archive its Chats and remove the Worktree with `worktree_remove`.
- A change that spans Projects (desktop and mobile in two repos, a client and its server) goes through Links. Use `delegate` to hand each brief to the other Worktree's agent, and use a Negotiation when both sides must agree on a contract before either one builds it.
- Attach any simulator an agent drives to the Chat (`simulator_attach`), so the user can watch it.
