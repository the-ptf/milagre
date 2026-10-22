# Proposed additions to the issue routine

Keep the original prompt in `pick-issue-start-working.md` unchanged. These are optional additions for a later revision.

1. Check issue comments, open PRs, platform scope and dependencies before claiming a bounded issue. Confirm current diagnostics instead of trusting an issue's old counts. Respect tracker requests such as one lint rule per PR. Prefer work that needs no external account, native build or product decision.
2. Use `test-milagre-app` and `test-milagre-mobile` for local verification. Install the locked dependencies before comparing mobile fingerprints. Record the exact checkout, device, provider, interactions, failures and fixes. Use isolated Projects and profiles with real providers for PR screenshots.
3. Use `systematic-debugging` for failures and `verification-before-completion` before declaring success. Ask independent reviewers to assess correctness and user behavior; use only models available in the session and report which ran.
4. Use Milagre task/phase tools and simulator/browser attachment to keep work reviewable. Keep the review in the requested PR, with real-app screenshots on the repository's screenshots branch. Do not create or publish an Artifact, shared report or public review page.
5. Treat an operational error as a diagnosis task. Respect native-build approvals, ownership locks and credentials. Use task-owned profiles, disposable Projects and simulators; never interrupt another Chat's running device. Record any unresolved verification gap in the PR instead of claiming completion.

Existing tools are enough for this workflow: `gh`, Milagre MCP, Argent device interaction and browser automation. No additional MCP installation is proposed.
