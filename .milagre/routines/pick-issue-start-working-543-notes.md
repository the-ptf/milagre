# Routine improvements from issue #543

Keep `pick-issue-start-working.md` as the user's original prompt. Proposed additions for future runs:

1. Check daemon authorization as well as client dialogs for any feature that starts background AI work. Test fresh profiles, old saved profiles, disconnects and restart before declaring consent covered.
2. Use an independent correctness reviewer for decisions and races. GPT-6 Astra caught a final-send gate that could leave a Chat busy; verify the observable terminal state after a refused start.
3. Launch the real desktop app from a disposable Project with an isolated profile. Clear inherited `ELECTRON_RUN_AS_NODE`. Reuse a slim installed mobile development client with a temporary `-RCT_jsLocation` launch argument and confirm Metro's checkout.
4. Use `test-milagre-app`, `test-milagre-mobile`, `systematic-debugging` and `verification-before-completion`, plus Milagre Tasks, Argent and `gh`. Existing tools suffice; no new MCP installation is needed.
5. Keep public reports self-contained with embedded real-app images and precise local coverage. Verify the anonymous report at desktop and phone widths, then put its URL first in the PR. Report the device-reset scope and migration behavior explicitly.
