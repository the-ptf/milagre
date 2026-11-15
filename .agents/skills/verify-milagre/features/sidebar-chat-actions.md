# Sidebar Chat actions

Each Chat row in the sidebar can be renamed, pinned to the top, marked Done (it moves into the collapsed Done group) and acted on from a right-click menu. Changes show at once with an undo toast and persist.

## Sub-features

- `row-menu` opens the context menu with Copy path, Rename Chat, Reload Chat, Mark as read/unread, Pin, Snooze, Mark Done, Delete and more.
- `row-rename` renames inline from the menu.
- `row-pin` moves the row into a Pinned section.
- `row-done` marks the Chat Done from the hover button; it leaves All Chats for `Done`.

## How to get to it (user POV)

- Right-click a row in All Chats.
- Hover a row: the Done (check) and Snooze buttons appear on its right.

## Driving it with verify-milagre

Preconditions:

- At least one Chat exists (send one as in [chat-send](./chat-send.md)); `<id>` is its `data-chat-id`.

- **Open the menu.** Run `node $V rightclick '[data-chat-id="<id>"] [data-row]'` and `node $V eval '[...document.querySelectorAll("[data-chat-menu] [role=menuitem]")].map(r => r.textContent)'`. The list includes `Rename Chat`, `Pin`, `Mark Done`, `Delete`.
- **Rename.** Run `node $V click --name "Rename Chat" --role menuitem`. Focus moves to an input named `Chat name` with the old title selected. Run `node $V type 'Verified rename'` and `node $V press Enter`. The row reads `Verified rename`; `node $V host project:read '["$PROJECT"]' --map 'v => v.state.sessions[<id>].title'` prints `"Verified rename"`.
- **Pin.** Reopen the menu and run `node $V click --name Pin --role menuitem`. A `Pinned` heading appears above All Chats with the row under it, and a `Pinned · Undo` toast shows. `profile/preferences.json` key `milagre.chatPins` maps the Project path to `{"<id>": 0}`.
- **Done.** Run `node $V hover '[data-chat-id="<id>"] [data-row]'` and `node $V click '[data-chat-id="<id>"] [data-chat-done]'`. A `Moved to Done · Undo` toast shows, All Chats reads `All caught up`, and `Done 1` sits at the bottom of the sidebar. `host project:read` shows `done_at` set on the session.
- **Proof.** `node $V shot pinned` and `node $V shot done`.

## Gotchas

- Rename selects the whole old title; `type` replaces it. Do not press Backspace first.
- A pinned Chat marked Done leaves the Pinned section too.
- The Done button only exists while the row is hovered; hover first.
- Pins live in the desktop profile's preferences, not in the host's Project state.
