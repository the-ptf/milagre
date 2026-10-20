# Routine improvements from issue #541

Keep `pick-issue-start-working.md` as the user's original prompt. These are proposals for future runs, based on this execution.

1. Give advisor models the issue text in their prompt. Milagre's read-only advisors can inspect code but cannot run `gh`; do not assume they can fetch the issue themselves. Ask separate UX and correctness personas and record the final decision.
2. Check out the existing app testing skills and use an isolated Project/profile with installed real providers. Confirm Metro's `projectRoot` before phone verification. Reuse an already slim simulator; a task-specific `-RCT_jsLocation` launch argument can select Metro without changing saved simulator preferences or creating a native build.
3. Treat full-suite failures as work to diagnose. Update obsolete assertions and fixture contracts without weakening production behavior. There is currently no mobile workspace lint script: use the root `npm run lint` and `npx oxlint apps/mobile/src` rather than assuming `npm run lint --workspace @milagre/mobile` exists.
4. Publish the review report with real screenshots embedded as data images. Capture smaller screenshots directly from the device tooling to stay under `artifact_show`'s 1,000,000-character limit; keep original PR screenshots on the screenshots branch. Verify the anonymous report at desktop and phone widths before placing its link first in the PR.
5. Use `systematic-debugging`, `test-milagre-app`, `test-milagre-mobile`, `verification-before-completion`, Milagre Tasks/phases/advisors, Argent and `gh`. The available tools covered this run; no additional MCP installation was necessary. Finish at a reviewable PR, with no automatic merge, OTA or native release.
