# Routine improvements from issue #592

The original prompt already exists in `pick-issue-start-working.md`; keep it unchanged.

1. Give independent advisor models the complete issue and ask distinct security and workflow perspectives. Use `advisor_providers` to choose installed models. This run used Claude Opus 5.5 and GPT-6 Astra; both recommended opt-in execution capped by the parent's existing Full permissions.
2. After this change ships, use `create_advisor(mode: "execution")` for real app/browser verification by another provider. Prepare shared Worktrees first, state exact checks and cleanup, and coordinate edits. Analysis remains the right mode for design and code review. Retry must inspect side effects before repeating actions.
3. Use `test-milagre-app`, `test-milagre-mobile`, `systematic-debugging` and `verification-before-completion`. Exercise installed real providers locally, including permission downgrade, Stop/Retry, legacy analysis, browser ownership and screenshot persistence. Automated fixtures are supplementary evidence.
4. Keep screenshots outside PR commits and use the separate screenshots branch. Do not publish artifacts or share a report. No extra MCP installation is needed: Milagre advisors/tasks/phases, `gh`, local browser automation and Argent cover the workflow.
