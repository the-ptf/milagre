---
name: milagre
description: Reference for Milagre agent tools, advisors, provider Accounts, owned Worktrees, linked reads, cancellation and result delivery. Use when operating Milagre or explaining its agent capabilities.
---

# Milagre

Read [the advisor contract](references/advisors.md) before launching or controlling advisors. Use `/milagre-advisor` for one second opinion and `/milagre-committee` for two independent analyses. Use `/milagre-help` for product setup and troubleshooting.

Milagre's host owns each Chat, its provider process, Accounts and persistence. Desktop and paired phones display the same work. A Project Chat owns one Worktree. A Named Link Chat owns one isolated Worktree in each member Project. The owning scope chooses Accounts independently of the Project currently on screen.

Link this Chat's Worktree to another Project's Worktree with `worktree_link` (the user approves it in Ask mode) and remove it with `worktree_unlink`. Canvas-linked Worktrees are read-only through `linked_overview`, `read_linked_chat`, `linked_git`, `read_linked_file` and `search_linked_files`. Changes there go through `delegate`; open a Negotiation when both sides must agree first. Advisors cannot delegate, negotiate, create Worktrees or launch children. The main Chat handles implementation and any existing provider handoff.

Discover the actual tools exposed in this session. Do not invent a Milagre or Paseo CLI command. Schedules, heartbeats, writable delegated advisors and launch profiles are outside this advisor API.
