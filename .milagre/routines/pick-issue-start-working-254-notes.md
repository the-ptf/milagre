# Suggestions from #254

The original prompt in `pick-issue-start-working.md` already exists and is preserved.

1. Read issue comments and open PRs before claiming work. A platform-specific CI issue can stay on that platform when it changes no product behavior.
2. Use `test-milagre-app`, `gh`, Docker/Xvfb and Milagre Tasks, phases, advisors and Artifacts. The existing tools suffice; no new MCP is needed. Reviewers in this run were GPT-6 Astra and Claude Opus 5.5.
3. Isolate Electron profiles, select a bundled font explicitly for deterministic geometry, verify the loaded face, and acknowledge native resize events before interacting. Document the chosen font's coverage; do not call a default-system-font limitation fixed.
4. Run the check repeatedly on Linux with Chromium's sandbox enabled and on macOS. Preserve positive assertions, and evaluate related positive and negative assertions against one captured state. Verify the Linux runner and CI shard actually select the check.
5. Capture PR images only from the real app and providers. Embed those images in a responsive public report, verify its anonymous link and phone layout, then put that link first in the PR. Leave merging and releases for later review.
