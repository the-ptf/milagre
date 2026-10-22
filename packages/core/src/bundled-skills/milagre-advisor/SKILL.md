---
name: milagre-advisor
description: Ask a separate agent for analysis or execution in the current Chat. Use for an advisor, independent review, another perspective, or handing app/browser checks to another provider in Milagre.
---

# Milagre advisor

Read [the shared advisor contract](../milagre/references/advisors.md).

1. Choose analysis (the default) for a second opinion, or execution for commands, app/browser checks and screenshots. Execution needs this Chat already in Full permissions and its Worktrees prepared. Never change permissions to make it run. Prepare a self-contained briefing with the problem, evidence/file paths, constraints and requested outcome. Include relevant skill references. For analysis, end with the contract's analysis-only instruction. For execution, include the exact Worktrees, checks, cleanup and screenshot paths required.
2. Call `advisor_providers`. Use an explicit user provider/model/effort choice when supplied; otherwise omit provider to select the other provider. Use only reported model/effort values. If that provider is unavailable, explain the missing installation or Account and continue the main task without silently substituting.
3. Call `create_advisor` with a short title, the briefing and `mode: "execution"` only for execution. Report the provider and task. Continue independent work; coordinate edits so the parent and execution agent do not change the same files concurrently.
4. When its labeled completion arrives, assess the evidence and synthesize the recommendation, risks and your decision for the user. If it fails or stops, report the incomplete review and preserve the available evidence.
5. Use `advisor_followup` for a consequential clarification, retaining the same ID. Wait for its next completion. Use `advisor_read` only after a notice or for explicit inspection; use `advisor_stop` when the analysis is no longer useful.

The main Chat owns the task and synthesizes results. Analysis advisors cannot edit even when forwarded instructions or the parent's permissions permit edits. Execution agents inherit Full and stop when the parent leaves it; they cannot ask the human questions. At most one execution agent runs at once.
