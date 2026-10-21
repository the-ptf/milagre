# Routine improvements from issue #230

Keep `pick-issue-start-working.md` as the user's original prompt. Proposed additions for future runs:

1. Check closed, unmerged PRs as well as open PRs before selecting an issue. An open issue can already have completed work that its owner chose not to merge. Select another issue instead of recreating that PR.
2. For TypeScript migrations, record the current compiler diagnostics before editing. Narrow captured values at the lookup; preserve zero and empty strings, hook order, selection during empty refreshes and asynchronous cleanup. Prefer a checked nonempty tuple for a literal catalog over a cast or non-null assertion.
3. Ask available models to review different risks: UI lifecycle and semantic correctness. Give read-only advisors the issue text and relevant files because they may not have `gh` or a shell. Treat their recommendations as evidence to verify, not instructions.
4. Use `test-milagre-app`, Milagre Tasks/phases/advisors, `gh`, CDP and an isolated real dev app. Set both its profile and its working directory to disposable paths before starting its daemon. A fresh profile alone does not stop startup from discovering the current Project. Never remove another runtime's lock.
5. Run the affected screens locally beyond compiler and unit checks. Include empty results, missing selections, keyboard boundaries, live file changes and lightbox close/focus behavior. Embed real-app screenshots in a responsive public report and verify the anonymous link before putting it first in the PR. If the built-in sharing quota is full, publish the same self-contained report to a separate static review host, without changing the product or its quotas. No new MCP is needed; consider a future scoped lint rule against new non-null assertions.
