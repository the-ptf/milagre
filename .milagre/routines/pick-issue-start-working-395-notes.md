# Routine improvements from issue #395

Keep `pick-issue-start-working.md` as the original prompt. These are proposals for future runs.

1. Check dependencies before running mobile fingerprint comparisons. A fingerprint generated without the installed native graph is not comparable with TestFlight. Install from the lockfile first, then compare the local `hash` with the finished build's `runtime.version`.
2. Start Metro with `node --dns-result-order=ipv4first`: Expo can bind `localhost` only to IPv6 while the installed simulator client checks IPv4. Use a task-specific `-RCT_jsLocation 127.0.0.1:<port>` launch argument, reuse a slim simulator, and attach it to the Chat.
3. Test the full recovery transition in the real app. A correct disk write does not prove the clients received its status event. Check failure, repeated retry, a newer edit, recovery, reconnect, and exact saved message identities on both clients.
4. When an advisor hits its usage limit, report the incomplete review and continue with an available independent reviewer. Give reviewers the issue's acceptance criteria and request concrete races and publication-boundary checks. Do not count a stopped advisor as a completed review.
5. Capture smaller screenshots directly from the device tooling for an embedded public report, while preserving larger real-app screenshots for the PR. Use `systematic-debugging`, `test-milagre-app`, `test-milagre-mobile`, `verification-before-completion`, Milagre Tasks/phases/advisors, Argent and `gh`. Existing tools cover this flow; no new MCP installation is proposed.
