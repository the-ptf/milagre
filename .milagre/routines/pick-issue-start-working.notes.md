# Proposed additions to the issue routine

Keep `pick-issue-start-working.md` as the original prompt. These are suggested additions for a future revision:

1. Check open PRs and issue comments before choosing work so another Chat's implementation is not duplicated. Prefer a ready, bounded issue whose required platforms can be exercised locally without a new native build.
2. Call `test-milagre-app` and `test-milagre-mobile` for local verification, `systematic-debugging` for failures, and `verification-before-completion` before reporting completion. Use Milagre Tasks and phase tools for progress, Argent for native interaction, and `gh` for GitHub.
3. When a decision has competing viable answers, ask independent reviewer personas for correctness, native UX and maintenance concerns. Record their resolution. Do not claim a named model participated unless it did.
4. Publish the review report through the existing `share.milagre.cloud` Artifact protocol. Embed real-app screenshots as data images, verify the anonymous URL at phone and desktop widths, keep management secrets private, and put the report link first in the PR. Store PR images only on the screenshots branch with commit-pinned URLs.
5. Finish with a reviewable PR, not an automatic merge or release. Report actual local checks, skipped platforms and unresolved failures. Retry recoverable failures without weakening checks, bypassing permissions, changing native fingerprints or touching another Chat's processes.
