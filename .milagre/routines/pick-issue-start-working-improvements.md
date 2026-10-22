# Proposed additions to the issue routine

Keep the original prompt in `pick-issue-start-working.md` unchanged. These are optional additions for a later revision.

1. Check issue comments, open PRs, platform scope and dependencies before claiming a bounded issue. Prefer work that needs no external account, native build or product decision. Follow an issue's requested PR size, such as one lint rule per PR, and leave a tracking issue open until all of its work is complete.
2. Use `test-milagre-app` and `test-milagre-mobile` for local verification. Record the exact checkout, device, provider, interactions, failures and fixes. Use isolated Projects and profiles with real providers for PR screenshots. Launch the desktop from the disposable Project directory. Verify a task-owned simulator's slim profile before driving it; do not clone another task's live device because cloning can stop the source.
3. Use `systematic-debugging` for failures and `verification-before-completion` before declaring success. Ask independent reviewers to assess correctness and user behavior; use only models available in the session and report which ran.
4. Use Milagre task/phase tools and simulator/browser attachment to keep work reviewable. Put real-app screenshots on the repository's separate `screenshots` branch and reference immutable image commits in the PR. Do not create or publish an artifact, public review page or other public sharing link.
5. Treat an operational error as a diagnosis task. Respect native-build approvals, ownership locks and credentials. If an external blocker cannot be resolved within authorization, record the completed evidence and exact remaining action in the PR instead of claiming completion.

Existing tools are enough for this workflow: `gh`, Milagre MCP, Argent device interaction and browser automation. No additional MCP installation is proposed.
