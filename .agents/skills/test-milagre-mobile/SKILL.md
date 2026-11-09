---
name: test-milagre-mobile
description: Verify Milagre's native iOS and Android UI using an attached device, an isolated host and matching Metro checkout. Use for phone regression checks, pairing fixtures and screenshot evidence in this repository.
---

# Test Milagre mobile

Read [mobile AGENTS.md](../../../apps/mobile/AGENTS.md) before changing mobile code and [root AGENTS.md](../../../AGENTS.md) for desktop parity. Use [test-milagre-app](../test-milagre-app/SKILL.md) for the corresponding desktop flow.

## Choose the device and installed client

Use Milagre's `simulator_list`, choose the exact device and call `simulator_attach` with its `deviceId` before interaction. Follow [the bundled simulator skill](../../../packages/core/src/bundled-skills/simulator/SKILL.md) for attachment ownership. Use available device automation with that same ID and fresh accessibility data/screenshots. Attaching does not boot a device or install an app.

Inspect the installed client before launching Metro. A development client loads this checkout's JavaScript; a release client uses its bundled or OTA JavaScript, so it cannot prove an unshipped local change. Confirm the visible app is connected to the intended fixture and code before declaring success.

Reuse a compatible installed development client. Testing does not authorize a new native build, prebuild, dependency/config change that changes the fingerprint, EAS build, TestFlight upload or OTA publication. If compatibility requires a native change, explain the specific blocker and any JS-only alternative, then obtain approval as mobile AGENTS.md requires. Compare fingerprints at its required checkpoints. Older build examples in the development docs do not override this rule.

## Start an isolated host

For a scripted check of the general phone flow (Chats, diffs, send, approval, question and Stop), run `npm run mobile:demo` from the repository root. It creates a temporary Project and host profile with a scripted provider and accepts `approval`, `question` and `slow` messages. Scripted replies verify UI/host behavior, not live model behavior, and its screenshots never go in a PR: PR images come from the real app with real providers, as [AGENTS.md](../../../AGENTS.md) specifies.

The demo currently defaults to bridge 8787 and Metro 8790. Check availability before starting and read the actual startup output. Reuse only a healthy fixture belonging to this task and checkout. Configure another available port where the script supports it, or adapt a task-owned fixture; never kill an unrelated listener.

The demo starts Metro with its disposable connection settings. Retain that terminal session. Do not start a second Metro with missing environment settings. Startup output or connection files can contain pairing credentials: consume them privately and keep them out of replies, screenshots and commits.

For real-provider testing and every PR screenshot, use a separate temporary Project and profile through the host workflow in [phone development](../../../docs/mobile-local.md). Do not use its desktop-profile sharing instructions for an isolated test. Never copy real provider credentials into fixtures or edit a live host's storage to seed state.

## Pair, exercise and retain evidence

Open the development-client URL from the task's Metro in the selected device using the available device tool. Confirm both Metro and the bridge are reachable from that device. On an Android emulator, host loopback is normally reached through `10.0.2.2`; a physical device needs a reachable host address. Do not expose a listener or create a public tunnel as an incidental test setup step.

If the installed client's bundle address differs, first use its supported development-server selection. Record and restore any task-specific simulator preference change. Do not hard-code a device container path or change native app code to resolve a Metro port mismatch.

Exercise the changed flow with representative data and its relevant pending, failure and retry states. Verify the result after tapping, not merely the button's presence. Include keyboard, scrolling or reconnect behavior when the change touches it. Save real device screenshots outside the repository and inspect them before sharing.

Run `npm run typecheck:mobile`, `npm run lint --workspace @milagre/mobile` and the relevant shared/bridge tests. `node --test scripts/mobile-ui.test.cjs` checks mobile rendering and interactions through a test harness; it is not a substitute for a real device check. Verify the desktop counterpart with the app testing skill.

Keep an interactive app, Metro and fixture available while the user is inspecting or iterating. At teardown, stop only processes started by this task, close only its automation sessions and remove only its disposable saved connection. Scope Argent service cleanup to the exact device IDs used. Leave the device attached for inspection unless the user asks to detach it. Report the device/platform, fixture versus real-provider coverage, checks, evidence and any unverified platform.
