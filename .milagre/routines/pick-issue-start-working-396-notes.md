# Routine improvements from issue #396

Keep `pick-issue-start-working.md` as the original prompt. Proposed additions:

1. Prefer a bounded issue without an open implementation PR. Read the acceptance criteria and ask an independent reliability reviewer to check persistence, retries and cleanup before implementation. Use only models available in this session and record the model that reviewed the work.
2. Separate transport acceptance from durable acceptance. Reconcile a lost send acknowledgement against a settled, persisted receipt before clearing a draft. File transfer retries must never imply another message send.
3. Put upload reuse, retention claims and cleanup under the runtime's single owner. Exercise actual files and HTTP transfers, not only mocks. Check filesystem aliases, missing files, changed bytes, partial multi-file failure, restart, quota and claim-versus-cleanup races.
4. Use `test-milagre-app`, `test-milagre-mobile`, `systematic-debugging` and `verification-before-completion`. Check that commands exist before invoking them: mobile has no `lint` script, so use `npx oxlint apps/mobile` alongside root lint. Use a cloned, verified slim simulator to avoid changing another Chat's test device.
5. Keep real-provider PR screenshots separate from harness evidence. Embed screenshots into the public Artifact, verify its anonymous page, and put that link first in the PR. Existing Milagre, Argent, GitHub CLI and browser tools cover this routine; no extra MCP installation is required.
