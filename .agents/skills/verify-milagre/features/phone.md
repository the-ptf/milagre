# Phone pairing and shared Chats

The phone app pairs with a computer by scanning its pairing code (a `milagre://pair` link), then lists that computer's Projects and Chats. A Chat opened on the phone shows the same transcript as the desktop, and a message sent from the phone runs on the computer and shows on both.

## Sub-features

- `phone-pair` pairs through the `milagre://pair` link and lands on All Chats.
- `phone-list` shows the desktop's Project with its Chats and Done group.
- `phone-open-chat` opens a Chat with its full transcript.
- `phone-send` sends from the phone composer; the reply shows on phone, desktop and host.

## How to get to it (user POV)

- First launch: "Connect your computer", `Scan pairing code`, or open the code with the Camera app.
- Desktop: Settings › Phone & sharing shows the pairing code.

## Driving it with verify-milagre

Preconditions:

- A desktop run with at least one Chat (from [chat-send](./chat-send.md)).
- A shut-down iPhone simulator for `phone-sim`, and a booted simulator with a Milagre development build to copy from (see SKILL.md, Phone).

- **Host and app.** Run `node $V phone-host`, `node $V metro`, `node $V phone-sim --udid <new>`, `node $V phone-install --from <source>`. Then argent `launch-app` `com.victorlucas.milagre` and `await-ui-element` `{text: "Bundling"}` `hidden` (about 5 s warm). The phone shows "Connect your computer".
- **Pair.** Run `node $V phone-pair`, take one argent `screenshot`, tap `Open` on "Open in “Milagre”?". The phone shows `All Chats` with `verify-project` and the desktop's Chats (`AXButton "<title>, main, Unread"`).
- **Open a Chat.** Tap the Chat row from the describe tree. The heading is the Chat title and the tree lists `Go to user message 1 of N` buttons matching the desktop transcript.
- **Send from the phone.** Tap `Message`, argent `keyboard` `Reply with exactly the word phoneok and nothing else. No tools.`, tap `Send message`. The composer becomes `Stop agent` and shows `Working with Haiku`.
- **Seen everywhere.** Desktop: `node $V wait '(() => { const a = [...document.querySelectorAll("article[data-from=assistant]")].at(-1); return a && a.textContent.includes("phoneok") })()' --timeout 90000` (open that Chat on desktop first). Host: `node $V host chat:messages '["$PROJECT", <id>]' --map 'v => v.messages.slice(-2).map(m => m.role + ": " + m.body)'` ends with `assistant: phoneok`.
- **Proof.** `node $V phone-shot phone-sent` and `node $V shot desktop-sees-phone-send`.

## Gotchas

- The first-launch copy says "Open Settings › Devices"; on the desktop that section is `Phone & sharing`.
- iOS asks "Open in “Milagre”?" for every `milagre://` link. argent's tree misses the alert on a simulator it did not boot; the first tap can only wake it, so tap again if the alert stays.
- Close the yellow "Open debugger to view warnings" banner (its X, bottom right) before tapping near the bottom; tapping the banner breaks the debugger connection.
- The phone keeps paired hosts across reinstalls. A reused simulator shows earlier runs' computers too; pick the one named `Verify host`.
- `phone-install` refuses a simulator this run did not boot if it already has Milagre: that build is someone else's.
- Metro runs with `CI=1`: restart it (`stop` the run, or kill only `pids.metro` from state) after editing phone code.
