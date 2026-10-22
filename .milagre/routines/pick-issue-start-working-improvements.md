# Proposed additions to the issue routine

Keep the original prompt in `pick-issue-start-working.md` unchanged. These are optional additions for a later revision.

1. Check issue comments, open PRs, platform scope and dependencies before claiming a bounded issue. Prefer work that needs no external account, native build or product decision.
2. Use `test-milagre-app` and `test-milagre-mobile` for local verification. Record the exact checkout, device, provider, interactions, failures and fixes. Use isolated Projects and profiles with real providers for PR screenshots.
3. Use `systematic-debugging` for failures and `verification-before-completion` before declaring success. Ask independent reviewers to assess correctness and user behavior; use only models available in the session and report which ran.
4. Use Milagre task/phase tools and simulator/browser attachment to keep work reviewable. Put real app screenshots on the repository's screenshots branch and embed them in the PR description. Do not create or publish an artifact or share public links in the reply. For an umbrella issue that requests one item per PR, name the completed item and leave the umbrella issue open.
5. Treat an operational error as a diagnosis task. Respect native-build approvals, ownership locks and credentials. If an external blocker cannot be resolved within authorization, record the completed evidence locally and state the exact remaining action instead of claiming completion.

Existing tools are enough for this workflow: `gh`, Milagre MCP, Argent device interaction and browser automation. No additional MCP installation is proposed.
