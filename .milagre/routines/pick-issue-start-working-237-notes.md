# Routine improvements from issue #237

The original prompt remains in `pick-issue-start-working.md`.

1. For platform-specific failures, reproduce on that operating system before changing code. A local OrbStack Linux container can exercise Electron under Xvfb while macOS remains available for native verification.
2. Follow existing test patterns for native shortcut modifiers. Check every chord in a flow, including opening Find, navigating matches, reopening Find and opening the command palette.
3. Use `systematic-debugging`, `test-milagre-app` and `verification-before-completion`. Run the existing interaction checks, then exercise a real-provider Chat in an isolated dev app. Harness images remain test evidence only.
4. Publish a responsive artifact with embedded real-app screenshots, verify its anonymous public URL and put that URL first in the PR. Use `gh` for issue and PR operations, plus Milagre task, phase and artifact tools. No new MCP is needed.
5. Keep runtime failures separate from setup failures. Missing dependencies or a container sandbox restriction need setup fixes, not application changes. Record the environment and limitations with the results.
