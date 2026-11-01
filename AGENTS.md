## Agent skills

### Checks before a PR

Run `npm run typecheck`, `npm run lint` and `npm test -- --unit` before opening or updating a PR. Run the Electron check for the screen you touched with `npm test -- --only <name>`. A change under `apps/desktop/electron` or to window, dock, menu or notification code also gets `npm test -- --only test-desktop` on your Mac: CI runs that macOS smoke on pushes to main only, so a PR is the last place it is caught before merge.

Every desktop copy an agent or check starts on a Mac someone is using runs with `MILAGRE_BACKGROUND=1` (macOS only; other platforms ignore it): no window, Dock icon, focus change, notification or dialog, while CDP (`Runtime.evaluate`, `Page.captureScreenshot`) still sees the real UI. `test-desktop` and `test-project-links` set it; `MILAGRE_BACKGROUND=0` shows the app.

### Landing page Lighthouse budget

Lighthouse scores for `apps/site` never go down. The floors live in `apps/site/lighthouse-budget.json`: 100 for Accessibility, Best Practices and SEO, plus a Performance floor per form factor (mobile 97, desktop 99, median of three runs).

- After any change under `apps/site`, run `npm test -- --only lighthouse`. It builds the site, serves it compressed like production and fails below the budget.
- Never lower a number in the budget to make a change pass; find what made the page slower. Raise the numbers when the page gets faster.
- The one exception is `skipAudits`: an audit the site fails on purpose, with the reason beside it in the budget file. Today that is `robots-txt`, for the Content-Signal line agents read. Add to it only with the user's say-so.
- Heavy code (three.js, React, React Flow) loads after the first paint: on the first interaction or when its section nears the screen. Don't import it into the page's first load.

### Issue tracker

Issues and specs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.

### UI rules

Scroll containers, scrollbars and choice menus go through shared primitives. See `docs/agents/ui.md`.

### Desktop and mobile stay in sync

Every change on desktop must also be applied on mobile, and every change on mobile must also be applied on desktop, in the same task. Skip syncing only when the user explicitly says to keep the change on one platform or not to sync it.

- Inspect both implementations before editing. Keep features, behavior, copy, states and fixes in sync; use each platform's native controls and layout where appropriate.
- Prefer shared logic when it applies to both platforms. A missing counterpart is work to implement, not an automatic exemption from syncing.
- Verify the change on both platforms before declaring the task complete. If syncing is blocked, explain what remains and why. The mobile native-build approval rules below still apply; this sync rule does not authorize a new build.

### Mobile releases are OTA only

Every change to `apps/mobile` reaches phones as an over-the-air update (EAS Update) to the build already in TestFlight. A new native build is the exception, and it needs the user's approval before you write the change that requires it, not after.

- A change needs a new build when it changes the runtime fingerprint: a dependency with native code (direct, or newly linked), a config plugin, native fields in `app.json` (permissions, entitlements, icons, plugins, `ios`/`android`), or an Expo SDK upgrade. JS, TS, assets loaded at runtime and copy never do.
- If your task looks like it needs one, stop and ask first. Say what needs the build, and whether a JS-only way exists.
- A PR that changes the fingerprint strands every later OTA until a new build ships, so it is not merged without that approval either.
- Never start an EAS build, TestFlight upload or APK build on your own.

How to check the fingerprint and publish an update: `apps/mobile/AGENTS.md`.

### Pull request screenshots

Every PR that changes something visible includes screenshots in its description, showing the before/after or each state the change adds.

Take every PR screenshot from the real app running: the dev app (desktop dev copy, or the phone app on a simulator or device against Metro) or a packaged build, driving the real providers. Never use:

- `scripts/test-*.cjs` Electron checks or any other harness with seeded or scripted data. Their screenshots are test evidence, not PR images.
- Fake or scripted SDKs and agent servers (`fakeSdk`, `fake-app-server`, `fake-acp-agent`). They stay for automated tests only.
- Design mockups, HTML renders, components shown in isolation, or edited images.

Name the source in the PR body under "Screenshots from" (for example "desktop dev app, Claude Opus, real Chat"). If the real app can't show the state, say so there and leave the screenshot out rather than faking it.

Screenshots never go in the PR's own commits. They live on the `screenshots` branch, which has no shared history with `main`, holds only images and is never merged:

1. Fetch it (`git fetch origin screenshots`) and add the images in a folder named after the feature, e.g. `sidebar-resize/default.png`. Use a temporary worktree or clone so your PR branch stays untouched.
2. Commit and push to `screenshots`.
3. In the PR body, link each image by that commit's SHA so the link never moves: `https://raw.githubusercontent.com/the-ptf/milagre-ade/<sha>/<feature>/<name>.png`.

The `scripts/test-*.cjs` checks save screenshots only when `MILAGRE_SCREENSHOT_DIR` is set; point it outside the repo, e.g. `$TMPDIR/<feature>`. Use them to check your own work, not in the PR.
