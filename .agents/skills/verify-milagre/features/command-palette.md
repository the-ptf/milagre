# Command palette

The command palette searches commands, Chats (Done ones included), Projects and messages, and opens the chosen result.

## Sub-features

- `palette-open` opens the palette with focus in its search field.
- `palette-search-chat` finds a Chat by title.
- `palette-open-chat` opens the selected Chat with Enter.

## How to get to it (user POV)

- The magnifier button at the top of the sidebar (`Command palette`).
- ⌘K.

## Driving it with verify-milagre

Preconditions:

- A Chat titled `Verified rename` exists (from [sidebar-chat-actions](./sidebar-chat-actions.md)), Done or not.

- **Open.** Run `node $V click --name "Command palette"`. `node $V eval 'document.activeElement.getAttribute("aria-label")'` prints `"Search commands, Chats, Projects and messages"`.
- **Search.** Run `node $V type 'Verified'`. `node $V snapshot palette` shows `listbox "Commands"` with `option "Verified renamemain" [selected]`.
- **Open the Chat.** Run `node $V press Enter`. The palette closes and `node $V eval '[...document.querySelectorAll("article[data-from]")].map(a => a.dataset.from)'` lists that Chat's messages.
- **Proof.** `node $V shot palette-open-chat`.

## Gotchas

- The ⌘K entry is not proven by this map yet; the sidebar button is the driven entry point. Report ⌘K as unverified unless you drive it.
- Results update as you type; wait for the `option` before Enter.
