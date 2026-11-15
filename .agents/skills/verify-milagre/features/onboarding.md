# First launch onboarding

A first launch plays the Dawn intro, then walks three steps: Choose your agent (checks Claude, Codex, Antigravity and Kiro on the computer), Open a Project, First Chat. The user can skip the Project and start a Chat without one.

## Sub-features

- `onboarding-intro` plays the Dawn intro once with a `Begin` button.
- `onboarding-agents` shows each agent as installed, signed in, signed out or missing, with Sign in, Install or Copy command.
- `onboarding-project` offers Open folder, Clone a repository and Start from scratch, plus Skip.
- `onboarding-first-chat` lands in the composer, in the Chats home when the Project step was skipped.

## How to get to it (user POV)

- The first launch of Milagre on a computer that never opened a Project.

## Driving it with verify-milagre

Preconditions:

- Launch with `node $V launch --onboarding`: an empty profile, an empty starting folder, and empty Claude and Codex homes.

- **Intro.** Run `node $V wait '!!document.querySelector("[data-intro-begin]")' --timeout 15000`, then `node $V click '[data-intro-begin]'`. `[data-onboarding]` has `data-step="1"`; `localStorage` key `milagre.onboardingIntroSeen` is `"1"`.
- **Agents.** Run `node $V wait 'document.querySelectorAll("[data-onboarding-agents] [data-agent]:not([data-state=checking])").length === 4' --timeout 30000`. `node $V eval '[...document.querySelectorAll("[data-onboarding-agents] [data-agent]")].map(a => a.dataset.agent + ":" + a.dataset.state)'` lists all four (with the empty homes: `claude:signed-out`, `codex:signed-out`, and `missing` for agents not installed).
- **Project step.** Run `node $V click --text Continue --role button`. Step `2` shows `h1 "Open a Project"`, tiles `[data-onboarding-tile=open|clone|create]` and `[data-onboarding-skip]`.
- **Skip to a Chat.** Run `node $V click '[data-onboarding-skip]'` and `node $V wait '!document.querySelector("[data-onboarding]") && !!document.querySelector("[data-prompt-editor]")'`. `node $V eval 'window.milagre.getCurrentProject().then(p => p && p.path)'` ends in `/chats-home`.
- **Proof.** `node $V shot onboarding-agents` after the agent rows settle, `node $V shot onboarding-done` at the end.

## Gotchas

- Without `--onboarding` the app opens the scratch repo it starts in and never shows onboarding.
- The intro's cloud transition takes about two seconds; a screenshot taken right after `Begin` shows only clouds. Wait for the step, then a moment more.
- Open folder uses the native folder dialog, which background mode cancels. Drive the plain-folder path with `npm test -- --only test-desktop` instead.
- Start from scratch creates a folder in `~/Code`, outside the scratch dir. Do not drive it here.
