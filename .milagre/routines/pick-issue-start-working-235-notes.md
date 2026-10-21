# Routine improvements from issue #235

Keep `pick-issue-start-working.md` as the user's original prompt. Proposed additions for future runs:

1. Inspect open PRs and task-owned containers before choosing an issue. A container's read-only source mount can reveal an active checkout working on an issue even before its PR exists. Choose another issue rather than duplicate that work.
2. Reproduce on the affected operating system. Run the existing check directly if a platform restriction skips it. Repair stale fixture contracts before diagnosing the original assertion; never change production code to accommodate an incomplete fixture.
3. Make performance assertions non-vacuous: wait for populated UI and observed instrumentation, bound settlement, then measure from the first background event through delayed work. Keep exact zero-render assertions. Verify the failure path with temporary mutations outside committed code.
4. Use `systematic-debugging`, `test-milagre-app` and `verification-before-completion`, plus Milagre Tasks/phases/advisors, Docker/Xvfb, CDP and `gh`. Ask available models for reliability and correctness perspectives. Record which models ran; do not claim unavailable reviewers participated.
5. Run real providers in an isolated dev profile and disposable Project for PR images. Keep fixture screenshots as test evidence only. Embed the real images in a responsive public artifact, verify the anonymous page and place its URL first in the PR. Desktop-only CI issues need no unrelated mobile change or native build.

Existing tools cover this workflow. No additional MCP installation is proposed.
