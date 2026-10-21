# Routine improvements from issue #238

Keep `pick-issue-start-working.md` as the original prompt. Proposed additions:

1. Check open and closed PRs before selecting an issue. A closed, unmerged attempt is evidence to inspect, not proof that the issue is fixed. Verify the current source and runtime again.
2. Separate an obsolete platform skip from the failure it describes. Run the existing check directly on the target OS before changing product code; keep its assertions intact.
3. Use `systematic-debugging`, `test-milagre-app` and `verification-before-completion`. Exercise Linux/Xvfb with sandboxed Electron, a non-root user, screenshots both enabled and disabled, and constrained CPUs. Keep harness images separate from real-provider PR screenshots.
4. Ask available advisors to assess scope and review the final diff from different perspectives. Record the actual models used. Respect the issue's platform scope and avoid unrelated mobile changes for desktop-only CI work.
5. Use `gh`, Milagre Tasks/phases/advisors/artifacts, Docker/Xvfb and CDP. Publish a responsive report with embedded real-app images, verify its anonymous URL and place it first in the PR. Existing tools suffice; no new MCP installation is needed.
