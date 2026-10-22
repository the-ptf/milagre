# Proposed additions to the issue routine

Keep the original prompt in `pick-issue-start-working.md` unchanged. These are optional additions for a later revision.

1. Check issue comments, open PRs, platform scope and dependencies before claiming a bounded issue. Prefer work that needs no external account, native build or product decision.
2. Use `test-milagre-app` and `test-milagre-mobile` for local verification. Record the exact checkout, device, provider, interactions, failures and fixes. Use isolated Projects and profiles with real providers for PR screenshots.
3. Use `systematic-debugging` for failures and `verification-before-completion` before declaring success. Ask independent reviewers to assess correctness and user behavior; use only models available in the session and report which ran.
4. Use Milagre task/phase tools and simulator/browser attachment to keep work reviewable. Put real screenshots on the screenshots branch and reference their immutable commits in the PR. Do not create or publish an artifact, share page or separate public report. Return the PR number without posting a public link.
5. Treat an operational error as a diagnosis task. Respect native-build approvals, ownership locks and credentials. If an external blocker cannot be resolved within authorization, keep evidence local and state the exact remaining action instead of claiming completion.

Existing tools are enough for this workflow: `gh`, Milagre MCP, Argent device interaction and browser automation. No additional MCP installation is proposed.
