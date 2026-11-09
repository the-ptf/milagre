This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Shipping: OTA only, builds need approval

Changes ship as EAS Updates on channel `testflight` to the build people already have. `runtimeVersion` uses the `fingerprint` policy, so an update only reaches builds whose native fingerprint matches. `fingerprint.config.cjs` keeps `eas.json` and npm scripts out of it.

Before you write a change, and again before you publish:

1. Fingerprint your tree: `npx expo-updates fingerprint:generate --platform ios` (the `hash` field).
2. Compare it with the latest TestFlight build: `npx eas-cli@latest build:list --platform ios --status finished --limit 1 --json --non-interactive` (its `runtime.version`).
3. If they match, publish once the PR is merged: run the **Mobile OTA** GitHub Action from `main` (`gh workflow run mobile-ota.yml -f platform=ios -f message="<what changed>"`; `platform` is `ios`, `android` or `both`). It repeats this fingerprint check per platform and refuses an update no build can take. `npm run update:testflight -- --message "<what changed>"` from a clean `main` checkout still works as the local fallback.
4. If they differ, stop. A new build is required, and that needs the user's approval: say what changed the fingerprint and whether a JS-only way exists. Do not merge the PR, start `eas build`, upload to TestFlight or build an APK until they say yes.

A new native build ships through the **Mobile release** GitHub Action (iOS to TestFlight, Android as the APK on the newest GitHub release). Every run waits for Victor's approval on the `mobile-release` environment; never dispatch it without his go-ahead.

CI runs the same comparison as the `Mobile fingerprint` check and fails the PR when the hash changes without the `native-build-approved` label.

Run EAS CLI as `npx eas-cli@latest <command>` and substitute that for bare `eas` in docs examples. Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. A library with native code needs a development build to try locally (`npx expo run:ios|android`), and a new TestFlight build to ship, which needs the user's approval first (see Shipping above). Prefer a library already linked in the current build.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
