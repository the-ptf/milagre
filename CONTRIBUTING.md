# Contributing to Milagre

Thanks for helping improve Milagre. The project is still an early desktop alpha, so small, focused changes are especially useful.

## Before you start

1. Read the product/domain notes in [`docs/agents/domain.md`](docs/agents/domain.md).
2. Check existing GitHub Issues before starting a larger change.
3. Keep local project data, credentials and generated files out of commits.

## Local workflow

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm test
npm test -- --unit
npm test -- --only <name>
```

Use `npm run dev` for visual work. Keep the renderer and Electron process boundaries explicit:

- `apps/desktop/app/` owns UI state and presentation.
- `apps/desktop/electron/` owns native windows, dialogs, media, notifications and updates.
- `packages/core/` owns provider processes, Chat state, filesystem and git operations; `apps/daemon/` exposes that runtime over a private local socket.
- `packages/shared/` owns the model and pure Chat/state operations used by both sides. Import through `@milagre/shared` package exports.
- `scripts/` contains root development, integration-test and release helpers.

Install dependencies from the repository root with `npm ci`. Add package dependencies to their workspace. Root commands still work; `npm run build --workspace milagre` and `npm run test --workspace @milagre/shared` target individual packages. Electron packaging and semantic-release run at root, with installers in `release/`.

Run `npm run format` before pushing; CI fails on unformatted files. After cloning, run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips the repository-wide formatting commit.

When changing the UI, include a short description of the interaction and a screenshot or recording taken from the real app (the dev app or a packaged build), not from a test harness, mockup or fake provider.

## Pull requests

- Keep each pull request focused.
- Explain the user-visible behavior and how you verified it.
- Add or update tests when changing agent execution, persistence or approval behavior.
- Do not commit `.env` files, API keys, local coordination data, `node_modules`, build output or personal worktree paths.
- Run the checks above before requesting review.
- Use Conventional Commit prefixes in Pull Request titles: `fix:`, `feat:`, `perf:`, `docs:`, `refactor:` or `chore:`. Add `!` or a `BREAKING CHANGE:` footer for breaking changes.

## Commit messages

Pull Request titles are used to calculate automated releases. Use a short title such as `feat: add approval state for file edits` or `fix: prevent duplicate agent responses`.

## Local mobile preview

Run `npm run mobile:demo` to try the Expo client with an isolated local daemon and demo agent. See [simulator setup and real-provider instructions](docs/mobile-local.md). The existing desktop commands keep their behavior.
