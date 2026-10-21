# Routine improvements from issue #235

Keep `pick-issue-start-working.md` as the user's original prompt. Proposed additions for future runs:

1. Read issue history and blame before changing product code. A reported bug may already have a fix while a platform skip still disables its coverage. Repair broken fixtures first, then reproduce the original assertion.
2. Exercise Linux checks with the CI Xvfb screen and software GL, including a non-root sandboxed Electron process. Repeat with one and two CPUs and screenshots unset. Screenshot delays can hide loading and timing failures.
3. Use a fresh Electron window at existing independent fixture boundaries while retaining the same storage session. Keep continuous user flows together. Accumulate console errors across every window and bound stabilization loops so regressions fail instead of hanging.
4. Use `systematic-debugging`, `test-milagre-app` and `verification-before-completion`, with Opus for performance review and GPT-6 Astra for fixture lifecycle review. Existing Milagre advisors, Docker, CDP, Tasks and `gh` suffice; no additional MCP is needed.
5. Preserve exact performance assertions and run a deliberate mutation to prove they still detect unnecessary renders. Capture PR images from the real app with a real provider, embed them in a responsive public report and verify the anonymous URL before putting it first in the PR.
