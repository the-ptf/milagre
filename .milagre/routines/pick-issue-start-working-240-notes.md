# Routine improvements from issue #240

Keep `pick-issue-start-working.md` as the user's original prompt. Proposed additions for future runs:

1. Inspect issue history, closed PRs and current code before selecting work. A removed feature can leave an obsolete failure open. Record the commit that resolved it and protect the replacement coverage instead of recreating removed behavior.
2. Verify selection through the real test runner: default, Electron-only, targeted and CI shards. Repeat the Linux check with screenshots unset and retries disabled so capture delays and automatic reruns cannot hide failures.
3. Wait for native viewport dimensions and the shared surface's own CSS animations before asserting resized geometry. A 200 ms sleep can race Milagre's 300 ms morph. Keep layout assertions separate from readiness waits so overflow still fails. Use disposable Linux containers with non-root sandboxed Electron, Xvfb and software GL; keep container permissions out of product code.
4. Use `systematic-debugging`, `test-milagre-app` and `verification-before-completion`, plus independent Opus and GPT-6 Astra reviews. Milagre Tasks, advisors, Docker, browser attachment and `gh` cover this workflow; no new MCP installation is needed.
5. Capture review screenshots from a disposable Project in the real app with a real provider. Embed the images in a responsive public report, verify the anonymous desktop and phone layouts, then put its link first in the PR. State explicitly when the issue concerns desktop CI only.
