# Approve a tool call

In Ask mode an agent's file write or command waits on an approval card in the transcript. The user reads what it will do, then allows it once, allows it for the Chat, or denies it. Allowing lets the agent finish and the change lands in the Project.

## Sub-features

- `approval-card` shows the pending tool call with its file and diff under Details.
- `approval-allow-once` lets this one call run.
- `approval-allow-chat` allows that tool for the rest of the Chat.
- `approval-deny` refuses the call and the agent carries on without it.
- `approval-sidebar` marks the Chat's row as waiting (shield icon) while the card is open.

## How to get to it (user POV)

- Any Chat in Ask mode (the default; the model picker footer reads "Ask for approval") whose agent edits a file or runs a command.

## Driving it with verify-milagre

Preconditions:

- A run launched with a working Claude account; Claude Haiku picked as in [chat-send](./chat-send.md).
- `approved.txt` does not exist in the scratch repo.

- **Ask for a write.** In a New chat, run `node $V click '[data-prompt-editor]'`, `node $V type 'Use your Write tool to create a file named approved.txt in the current folder containing the single word yes. Do nothing else.'`, `node $V click '[data-composer-submit]'`.
- **Card shows.** Run `node $V wait '!!document.querySelector("[data-slot=step-approval]")' --timeout 90000`. `node $V snapshot approval` lists `group "Tool approval"` with `Deny`, `Always allow in this Chat`, `Allow once`, and the composer's `Stop agent`. The scratch repo has no `approved.txt` yet (`ls` it).
- **Allow once.** Run `node $V click --name "Allow once" --role button` and `node $V wait '!document.querySelector("[data-slot=step-approval]") && !document.querySelector("[aria-label=\"Stop agent\"]")' --timeout 90000`.
- **Side effect.** `cat <project>/approved.txt` prints `yes` (project path from `node $V host project:current --map 'v => v.path'`). The assistant message reports the file created.
- **Proof.** `node $V shot approval-card` before allowing, `node $V shot approval-allowed` after.

## Gotchas

- While the card waits, the step title already reads `Wrote approved.txt`, in the past tense, before anything is written. Assert on the file, not the title.
- The card lives in the transcript, not a dialog; Escape does not dismiss it.
- `Always allow in this Chat` changes later turns in that Chat. Use a new Chat for the next approval recipe.
