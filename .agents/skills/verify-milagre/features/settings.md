# Settings

Settings opens over the app with a section list, a search field and the chosen section. Choices save at once and survive a restart.

## Sub-features

- `settings-open` opens Settings on General.
- `settings-appearance-mode` switches System, Light and Dark.
- `settings-search` finds a setting by name and jumps to it.
- `settings-close` closes with the X or Escape.

## How to get to it (user POV)

- The gear at the bottom of the sidebar (`Settings`).
- The app menu's Settings item (not driven by this map yet).

## Driving it with verify-milagre

Preconditions:

- None beyond the baseline.

- **Open.** Run `node $V click '[data-update-settings]'`. The snapshot shows `input "Search settings"`, section rows (`General`, `Appearance`, `Chat`, `Accounts`, `Phone & sharing`, `About` and more) and `h1 "General"`.
- **Light mode.** Run `node $V click --name Appearance --role button`, then `node $V click '[data-segment=light]'`. `node $V eval 'document.documentElement.classList.contains("dark")'` prints `false`, and `profile/preferences.json` key `milagre-settings` has `"theme":"light"`.
- **Search.** Run `node $V click '[data-settings-search]'` and `node $V type 'keep awake'`. The first `[data-settings-result]` reads `Keep the Mac awake · General › System`.
- **Close.** Run `node $V press Escape` twice (the first clears or leaves search). `node $V eval '!!document.querySelector("[data-settings-search]")'` prints `false`.
- **Proof.** `node $V shot settings-light`.

## Gotchas

- The phone's onboarding tells users to open "Settings › Devices"; the desktop section is named `Phone & sharing`.
- Accounts, Usage and the model picker show account names and emails. Keep those screenshots private.
- Settings lists other computers this Mac knows. Do not drive them.
