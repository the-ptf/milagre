# Routine improvements from issue #239

Keep `pick-issue-start-working.md` as the user's original prompt. Proposed additions for future runs:

1. Reproduce platform-specific failures on that operating system. Use a task-owned Linux container and Xvfb for Linux checks; do not infer Linux success from macOS. Keep source and dependencies matched to the checkout, and distinguish a fixture startup failure from the reported interaction failure.
2. Ask available reviewers with different perspectives before choosing synchronization. Opus 5.5 and GPT-6 Astra both identified out-of-window pointer releases as a second Linux hazard. Include the issue text in advisor prompts and preserve exact assertions rather than rounding animated values.
3. Wait for observable completion: the committed saved value, exact rendered width, animation completion and cleared drag state. Queueing an input event is not proof that the renderer handled it. Exercise slower and zero-duration motion, clamps, consecutive drags and keyboard input locally.
4. Use `systematic-debugging`, `test-milagre-app` and `verification-before-completion`, plus Milagre Tasks/phases/advisors, Docker/Xvfb, CDP and `gh`. Isolate the real dev app's profile and Project for screenshots. Existing tools suffice; no new MCP installation is proposed.
5. Keep harness screenshots as test evidence. Publish a responsive report with embedded real-app images, verify its anonymous public URL at desktop and phone widths, and put the link first in the PR. An issue confined to desktop CI does not require unrelated native mobile changes or releases.
