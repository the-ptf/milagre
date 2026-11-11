# Native compatibility boundaries

## Shortcuts across frames

`shortcuts.rs` installs an AppKit local key monitor for the main window only. This receives keys while an Artifact, Design or other embedded frame has focus. It consumes only the forwarded shortcuts compiled by the existing `@milagre/shared/keybindings` implementation. The shim sends defaults on startup, replaces them with the host's actual `keybindings:read` result, and follows `keybindings:changed` in order. An empty rules list disables forwarding. The production renderer still evaluates each rule's `when` condition and command priority.

The monitor publishes the production `app:shortcut` event, including key, physical code and modifiers. CmdQ and CmdW stay with `lifecycle.rs`; native dialogs belong to other windows and are not intercepted. Rust's normalization tests use fixtures generated from the actual shared JavaScript compiler and matcher. Node tests require the checked-in fixtures to match the current shared implementation, including custom rules, layout letters, Option punctuation, function keys, extra modifiers and lifecycle exclusions. Native monitor installation compiles; actual focus and keyboard behavior in an embedded frame still needs interactive verification.

## Notifications for hidden scopes

The notifier reads the same persisted hidden-local-Project, hidden-remote-scope, hidden-computer and settings preferences as Electron. Computer filtering applies only while `otherComputers` is enabled. Its scope parser follows `shared/chat-scopes.mjs`: ordinary local Projects and Links belong to `local`, qualified Projects start with `<computer>|`, and qualified Links start with `milagre-link:<computer>|`. Tests cover local and remote Links/Projects and malformed preference entries. Reported hidden scopes also participate, and `notification:state` recomputes the badge.

## CLI and agent desktop command registration

The Rust shell currently serves its own renderer's implemented native commands. It does **not** advertise them through the shared daemon's `desktop:register` adapter yet. Existing Electron desktop commands remain available while Electron is connected.

The limitation is specific to coexistence: `apps/daemon/src/desktop-commands.cjs` chooses the **first registered host supporting a method**. There is no host priority, foreground preference or standby registration API. Registering Rust after Electron would leave Electron in control until it disconnects, but starting Rust first would route later clipboard, save-dialog and menu requests to Rust even while Electron is active. Registering a hidden verification process would be particularly misleading because background-mode native actions deliberately return cancellation.

A standalone Rust owner needs registration before Electron can be removed. The compatible integration should add explicit daemon host priority or foreground ownership, then register only implemented methods on connection/reconnection, consume `desktop:request` privately in native code, and answer each request once through `desktop:respond` on the same connection generation. It must never replay a native action after an uncertain response or disconnect. Renderer-facing access to these management commands should remain denied. Until host selection has that contract, the local side-by-side build leaves Electron's registration in place instead of claiming equivalent standalone desktop CLI support.
