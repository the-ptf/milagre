# Proposed additions to the issue routine

Keep `pick-issue-start-working.md` as the original prompt. These are suggested additions for a future revision:

1. Check open PRs and issue comments before choosing work so another Chat's implementation is not duplicated. Prefer a ready, bounded issue whose required platforms can be exercised locally without a new native build.
2. Call `test-milagre-app` and `test-milagre-mobile` for local verification, `systematic-debugging` for failures, and `verification-before-completion` before reporting completion. Run `npm run knip` alongside the required checks to catch unused exports after extractions. Use Milagre Tasks and phase tools for progress, Argent for native interaction, and `gh` for GitHub.
3. When a decision has competing viable answers, ask independent reviewer personas for correctness, native UX and maintenance concerns. Record their resolution. Do not claim a named model participated unless it did.
4. Keep review evidence in the PR. Capture screenshots from the real desktop dev app and a compatible installed mobile development client with real providers. Store PR images on the screenshots branch with commit-pinned URLs. Do not publish an Artifact, shared report, deployment or other public preview link.
5. Finish with a reviewable PR, not an automatic merge or release. Report actual local checks, skipped platforms and unresolved failures. Retry recoverable failures without weakening checks, bypassing permissions, changing native fingerprints or touching another Chat's processes.
