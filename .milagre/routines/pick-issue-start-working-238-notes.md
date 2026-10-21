# Routine improvements from issue #238

Keep `pick-issue-start-working.md` as the user's original prompt. Proposed additions for future runs:

1. Trace an issue's original failure against the current code before changing behavior. A later feature may have fixed the failing interaction while leaving a platform exclusion behind.
2. Run platform-specific checks on that operating system. Use a disposable Linux container with Node 24, a non-root user, Electron's sandbox and Xvfb; keep its dependencies separate from the Mac checkout.
3. Verify discovery as well as execution. A successful direct script does not prove CI selects it. Check default selection, targeted selection and exactly one CI shard, then run the normal test command repeatedly.
4. Use `systematic-debugging`, `test-milagre-app` and `verification-before-completion`, plus Milagre Tasks/phases/artifacts, `gh` and an available independent correctness reviewer. No new MCP is needed for this workflow.
5. Keep real-provider app screenshots separate from fixture evidence. Embed the real images in a responsive public report, identify the source and platform scope, and put its verified public URL first in the PR.
