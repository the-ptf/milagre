# Terminal panel

A Chat has Terminals that open in its Worktree (the Project folder for a Chat on This checkout). The user types commands as in any shell; output and files land in that folder.

## Sub-features

- `terminal-open` opens the panel with a first shell tab.
- `terminal-run` runs a command in the Chat's Worktree.
- `terminal-tabs` adds (`New Terminal`) and closes (`Close <shell>`) tabs.
- `terminal-hide` hides the panel without closing shells.

## How to get to it (user POV)

- The Terminals toggle in the top bar of an open Chat (`Toggle Terminals panel`).
- On the phone, `Open a Terminal in this Chat` under the transcript.

## Driving it with verify-milagre

Preconditions:

- An open Chat (any; the panel belongs to the Chat).

- **Open.** Run `node $V click '[data-panel-toggle=terminal]'`. The snapshot shows `tablist "Terminals"` with a `tab "zsh"` (`data-terminal-tab=<terminal id>`) and `textarea "Terminal input"`.
- **Run a command.** Run `node $V click 'textarea[aria-label="Terminal input"]'`, `node $V type 'pwd && echo verified-from-terminal > from-terminal.txt && ls'`, `node $V press Enter`.
- **Side effect.** `<project>/from-terminal.txt` contains `verified-from-terminal`.
- **Output.** Run `node $V host terminal:read '[{"terminalId":"<terminal id>","after":0}]' --map 'v => v.data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")'`. It contains the scratch repo path and `from-terminal.txt`.
- **Hide.** Run `node $V click 'button[aria-label="Hide Terminals"]'`. The panel closes; reopening shows the same tab.
- **Proof.** `node $V shot terminal-open` after the command.

## Gotchas

- xterm renders with WebGL, so the DOM has no text rows. Read output through `host terminal:read`.
- The shell is the user's login shell with their prompt theme; assert on files and command output, not on the prompt.
- A file created here shows in the Changes panel; run [changes-panel](./changes-panel.md) next to reuse it.
