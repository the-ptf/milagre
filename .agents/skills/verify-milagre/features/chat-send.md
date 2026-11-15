# Send a Chat message

A user starts a Chat in a Project, picks the agent and model, sends a prompt, watches the agent reply, and can stop a turn while it runs. The Chat appears in the sidebar and keeps its messages.

## Sub-features

- `send-new` sends the first message from the New chat screen and creates a Chat.
- `send-model` picks provider and model in the composer's model picker.
- `send-reply` shows the agent's reply in the transcript.
- `send-stop` stops a running turn from the composer.
- `send-persist` keeps the user and assistant messages in the host.
- `send-limit` shows the usage limit card when the account is at its limit.

## How to get to it (user POV)

- The New chat screen ("Start building in verify-project") that opens with the Project.
- The `New chat` button (pencil) at the top of the sidebar, or `+` beside All Chats.
- The composer at the bottom of an open Chat, for a follow-up.

## Driving it with verify-milagre

Preconditions:

- A run launched with a Claude account that is not at its limit (`--claude-config-dir`).
- `node $V doctor` passes.

- **Open New chat.** Run `node $V click --name "New chat"` and `node $V wait '!!document.querySelector("[data-new-chat-heading]")'`. The heading "Start building in verify-project" shows.
- **Pick Claude Haiku.** Run `node $V click '[data-permission-mode]'`, `node $V click --name Claude --role button`, `node $V click --text Haiku --role button`, `node $V press Escape`. `node $V eval 'document.querySelector("[data-permission-mode]").textContent'` reads `Haiku·High`.
- **Send.** Run `node $V click '[data-prompt-editor]'`, `node $V type 'Reply with exactly the word pong and nothing else. Do not use any tools.'`, `node $V click '[data-composer-submit]'`. The user message shows as `article[data-from=user]` and a row with `[data-chat-id]` appears in the sidebar.
- **Reply.** Run `node $V wait '(() => { const a = [...document.querySelectorAll("article[data-from=assistant]")].at(-1); return a && !document.querySelector("[aria-label=\"Stop agent\"]") ? a.textContent : false })()' --timeout 120000`. It prints `"pong"`. The Chat gets a generated title in the top bar.
- **Persisted.** Run `node $V host chat:messages '["$PROJECT", <id>]' --map 'v => v.messages.map(m => m.role + ": " + m.body)'` with the row's `data-chat-id`. It lists the user prompt and `assistant: pong`.
- **Stop.** In the same Chat send `Write the numbers from 1 to 600 in words, one per line. No tools.`, wait for `[aria-label="Stop agent"]`, then `node $V click '[aria-label="Stop agent"]'`. The transcript ends with `Turn stopped`, the button turns back into Send, and `node $V host chat:runs` returns `"runs": {}`.
- **Proof.** `node $V shot chat-reply` after the reply and `node $V shot chat-stopped` after Stop.

## Gotchas

- The prompt contains the word you assert on; wait on `article[data-from=assistant]`, never on the transcript text as a whole.
- New Chats default to the last model used on the profile. A fresh profile starts on Codex (GPT-6.1-Sol): switch to Claude before sending.
- Accounts at their weekly limit reply with a limit card (`[data-slot=usage-limit]`, "Claude hit its usage limit") instead of text. That is `send-limit` working, and a precondition failure for `send-reply`: relaunch with another account rather than weakening the check.
- Chat ids are not sequential (the second Chat in one run was id 5). Read the id from the row.
- The open Chat can keep its Unread dot because the background window never has focus.
