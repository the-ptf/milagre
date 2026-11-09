# Design council harness

Repeatable screenshots for the design council: five judge agents score a fixed screenshot set per category
(Typography, Hierarchy, Spacing & density, Color & contrast, Iconography, Consistency & polish, Clarity, Overall), fixes
land, and the same set is captured again until every judge gives 9 or more everywhere.

## Desktop

`node scripts/design-council/capture-desktop.cjs <outDir>` renders the real desktop renderer (`App.tsx` through Vite)
with fixture data in a hidden Electron window and writes 22 PNGs (11 screens, light and dark, 1440x900 at 2x) plus
`manifest.json`, in about a minute. The clock is frozen and animations settle, so runs are byte-stable. Elements are
found by role, label and `data-*` hooks; a failed step logs `FAIL <file>: <reason>` and the run moves on.

- `COUNCIL_ONLY=d01,d07` captures a subset; `COUNCIL_DEBUG=1` also saves `FAILED-*.png` and the page text.
- Vite takes a random free port and Electron a temp profile, so it never touches a running Milagre.
- These are fixture screenshots for judging. PR screenshots still come from the real app (see AGENTS.md).

## Phone

Captures a fixed set of Milagre phone screenshots, light and dark, from the real app running on a slim iOS
simulator against a throwaway local host. Each round of the design council runs the same capture while other agents
change the UI, so the screens are reached by route (expo-router, the same routes the `milagre://` links open) and
waited on by route name. Nothing taps coordinates.

| File                        | What it is                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture.cjs`               | A real Milagre daemon + mobile bridge on `127.0.0.1:8901`, seeded with the "Fieldnotes" Project: 4 Chats from a scripted agent (user message, tool rows, markdown list, code block), an uncommitted diff, fixed model lists and a made-up token usage report. Wiped and rebuilt on every start. No provider, network or personal data. |
| `start-services.sh`         | Starts the fixture and Metro (port 8899) detached and writes `/tmp/council/phone-env.txt`. `--restart` restarts both, `--metro` restarts Metro with `--clear`. Only ever stops PIDs it recorded itself.                                                                                                                                |
| `capture-phone.sh <outDir>` | The capture. 12 PNGs, about 2.5 minutes.                                                                                                                                                                                                                                                                                               |
| `app-eval.cjs`              | Talks to the debug app through Metro's inspector (Hermes CDP): reads the focused route, navigates with `router.replace/push`, and silences LogBox toasts.                                                                                                                                                                              |

### Screens

| File                         | Screen                                                                         | Route                              |
| ---------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `p01-chats-{light,dark}.png` | Chats list (home, "All Chats")                                                 | `/projects`                        |
| `p02-chat-…`                 | Open Chat: user message, tool activity row, markdown heading, list, code block | `/chat?id=<main>&projectPath=…`    |
| `p03-model-picker-…`         | Composer's model picker sheet over the Chat                                    | `/model-sheet?chatId=…`            |
| `p04-settings-…`             | Settings main page                                                             | `/settings`                        |
| `p05-changes-…`              | Changes: 3 uncommitted files in a tree with +/- counts                         | `/changes?worktreeId=1`            |
| `p06-new-chat-…`             | New Chat empty state with the Today card                                       | `/chat?worktreeId=1&projectPath=…` |

Every screen starts from a fresh app launch, so no sheet, scroll position or draft leaks from one screen to the next.

### One-time setup

Rules that apply on this Mac: Xcode is not `xcode-select`ed, so export `DEVELOPER_DIR`; simulators boot only through
`simslim`; never touch Victor's own Milagre (daemon 8797/8798, Vite 5180) or ports 8790-8798, 8891, 5180.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
WT=/Users/victor/.milagre/worktrees/milagre-ade/lets-run-a-deep-analysis-ak1v   # this worktree
UDID=F9224DDB-068D-4097-9DBC-0199CCBE07C0                                         # iPhone 17, iOS 27.2

# 1. Boot slim, verify before installing anything.
simslim boot $UDID
simslim verify $UDID --except widgets,icloud,web || {
  simslim on $UDID --except widgets,icloud,web
  simslim verify $UDID --except widgets,icloud,web
}

# 2. Local debug build for the simulator, Metro port baked in as 8899 (Info.plist RCTMetroPort = $(RCT_METRO_PORT)).
#    prebuild generates apps/mobile/ios (gitignored) and runs pod install. `expo run:ios` can't be used for the
#    build itself: it refuses --port together with --no-bundler, and it would start its own Metro. Cold build
#    (React Native compiled from source) took ~10 minutes on this Mac.
cd $WT/apps/mobile
CI=1 node ../../node_modules/expo/bin/cli prebuild --platform ios
xcodebuild -workspace ios/Milagre.xcworkspace -scheme Milagre -configuration Debug \
  -destination id=$UDID -derivedDataPath ios/build RCT_METRO_PORT=8899 COMPILER_INDEX_STORE_ENABLE=NO build
xcrun simctl install $UDID ios/build/Build/Products/Debug-iphonesimulator/Milagre.app

# 3. Fixture + Metro (detached; PIDs, ports and UDID go to /tmp/council/phone-env.txt).
$WT/scripts/design-council/start-services.sh
```

A local simulator build is fine; never start an EAS build, TestFlight upload or APK build for this. A rebuild is
only needed when native code changes (a new native dependency, `app.json` native fields). JS and styling changes
reach the app through Metro.

### Each round

```sh
$WT/scripts/design-council/capture-phone.sh /tmp/council/round-N/phone
```

- Subsets: `COUNCIL_SCREENS="p02 p03" COUNCIL_THEMES=dark capture-phone.sh …`.
- `COUNCIL_RENDER_WAIT` (default 2.5 s) is the pause after a screen's route holds still, for data and animations.
- If a UI edit doesn't show up, Metro missed the file change (no watchman here): `start-services.sh --metro`.
- If the app is wedged (red screen, stuck splash): `start-services.sh --restart`, then capture again. The first
  capture after a fresh install pairs the app with the fixture through the `/pair` route by itself.

The capture fails fast, with the fix, if the simulator isn't booted or slim, the app isn't installed, or Metro or the
fixture is down. It never boots, builds or starts anything itself.

### Why it works this way

- `xcrun simctl openurl milagre://…` raises iOS 27's "Open in Milagre?" system alert, which nothing here can tap.
  The capture therefore calls expo-router's `router.replace/push` with the same paths through Metro's inspector
  (`app-eval.cjs`), and waits until `navigationRef.getCurrentRoute()` names the expected screen and holds still for
  1.5 s. If an alert ever gets stuck on screen: `xcrun simctl spawn $UDID launchctl stop com.apple.SpringBoard`.
- The app is not in `EXPO_PUBLIC_DEMO` mode: demo mode adds a "Demo agent" caption, names the computer "Demo host"
  and ignores the host's model list. The phone pairs with the fixture as "Design Council Mac" instead.
- The fixture turns "Keep the Mac awake" on in its own data folder, so opening a Chat doesn't raise the keep-awake
  question (core's keep-awake there is a no-op stub; this Mac's power settings are untouched).
- The fixture serves its own token usage report and Project icon. Core's defaults would read `~/.claude` and
  `~/.codex` (the owner's real spend), fetch a price list, and fall back to the signed-in GitHub user's avatar.
- All Chats but "Dark mode in Settings" are marked read; the capture never opens that one, so the list is the same
  every round. A warm-up opens the main Chat once before the screens, because the list switches from per-Project
  groups to One list once the phone has a last Chat.

### Known variation between rounds

- The Today card highlights the current hour, so its bar colors move with the clock (the values don't).
- Relative times in rows, if the UI adds them, will drift while one fixture stays up for hours;
  `start-services.sh --restart` rebuilds it.

### Stop

```sh
kill $(sed -n 's/^METRO_PID=//p' /tmp/council/phone-env.txt) $(sed -n 's/^FIXTURE_PID=//p' /tmp/council/phone-env.txt)
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer simslim shutdown F9224DDB-068D-4097-9DBC-0199CCBE07C0
```
