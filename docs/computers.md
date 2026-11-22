# Computers

How a Chat on another computer reaches the device the person is using: its Browser pages, and messages queued while it is offline.

The Chat's computer always owns the Project, Worktrees, transcript and pages. The viewing device draws and queues; it never becomes a second owner.

## Computer map

Settings › This Mac and the phone's Computers screen show a Map beside the List (`@milagre/shared/computer-map` lays out both). Desktop puts the phones and computers that drive this Mac on the left, the ones it drives on the right; the phone stacks its computers under itself so the map fits the width without zooming.

- **Routes are the real ones.** A driven computer's line names the route in use (`ComputerView.route`): LAN, Tailscale when the LAN address is in 100.64.0.0/10, else the relay's host. A paired device's line uses `PairedDevice.route`; on the phone, the current `lanRoutes` route. Not connected is gray, offline dashed, refused red.
- **Two-way is joined by name.** A paired computer and a driven computer share no id (a device is keyed by its pairing key, a driven computer by this Mac's own id), so the map folds them into one two-way machine only when the name the device gave matches the driven computer's name. Renaming one side on this Mac splits them again. Phones never join.
- Worktree Links aren't drawn: they never span computers.

## Browser pages on another computer

A remote Chat's Browser panel pages open as webviews on the desktop being looked at, and every connection they make leaves from the Chat's computer. `localhost`, `127.0.0.1` and that computer's internal names resolve there, so a dev server bound to loopback works.

- **Network.** The host runs one SOCKS5 proxy per paired computer on a random loopback port. Each connection becomes a byte stream on the computer link (`peer-streams.cjs`) and the remote computer dials the target. The page's session uses the proxy with the `<-loopback>` bypass rule, so loopback goes through it too. A session is never attached before its proxy is set, so a page can't silently fall back to this computer's network. Chromium's SOCKS5 has no authentication; the loopback port is what keeps it local. Works the same on LAN, Tailscale and the relay.
- **Links.** A remote Chat's Ports and reply links open at the address the Chat wrote (`localhost:4317`), even where the link shows a LAN address.
- **Sessions.** All of one computer's Chats share one browser session here (`persist:milagre-browser-computer-<hash>`), as local Chats share `persist:milagre-browser`, so a sign-in carries across Chats and their agents can use it. The proxy is per session, so a session never spans two computers and sign-ins never leak between them. The CDP proxy refuses the `Network` cookie methods, so no client reads httpOnly cookies wholesale. Settings › Browser signs a session out on desktop and phone (`browser:sign-ins:clear`).
- **Ownership.** The desktop drawing the page registers it with the Chat's host (`browser:panel-pages` over the link). The host reaches it through a reverse stream to that desktop's DevTools proxy (`cdp-proxy.cjs`, via `panel-forwarders.cjs`); the desktop accepts reverse streams only to that port on 127.0.0.1. Opening a page in the panel is the ownership evidence, as process lineage is for agent browsers ([host.md](host.md#browser-pages)). Agent `browser_*` tools, the phone viewer and page comments all act on the one page the person sees. With several desktops, the most recently registered page wins; with none, the agent opens its own.
- Trap: `Page.reload` through a webview's debugger reloads Milagre's own window. The desktop reloads the guest itself instead.
- Only paired desktops get `peer-tcp-v1` and `peer-panel-pages-v1`. Agent-started and attached browsers still stream from their computer.

Rejected: streaming the computer's own webview (T3 Code's model, and ours before): size, quality and occlusion depend on a window nobody is looking at. Pointing the webview at the computer's IP (Paseo's model): fails over the relay and for loopback-bound servers unless the person runs their own proxy and DNS.

## Offline outbox

When a computer is offline, desktop and phone keep the composer usable and queue messages on the sending device. A queue item is not a transcript receipt.

Rejected and worth knowing: a disabled composer with nothing queued. That was the earlier policy; this outbox replaced it on purpose.

- **Saving.** Queue message saves the body, options, target, a stable `clientMessageId` and attachment bytes before clearing the draft; a storage failure keeps the draft. Desktop uses IndexedDB with strict durability, the phone versioned files moved into place. The latest committed revision rules: an unreadable one blocks delivery and is never overwritten, and a canceled message never returns from an older revision. No native dependency, so no fingerprint change.
- **Delivery** runs while desktop Milagre is open or the phone app is in the foreground, on a timer and on computer changes. Messages go in order per computer, owner and Chat; others proceed independently. The queue isn't synced across devices. Each New Chat submission makes its own Chat, and later messages wait for the computer to return its id.
- **No duplicates.** Before any remote change, delivery reads `chat:send-status`. A saved receipt completes the item with no upload or send. Otherwise it sends with the original `clientMessageId` (and Link `operationId`), which the host already deduplicates. A computer without receipts fails visibly before any change.
- **Worktree creation** has no idempotency key. Its intent is saved before the request and its Chat id before any upload. An interrupted creation is never replayed: the user checks the computer and recovers to that Chat. Canceling the message doesn't delete a Worktree creation may have made.
- **States.** Queued on this device (Cancel removes it durably), Sending, Sent (the computer saved it, not that the agent finished). A lost acknowledgement keeps the id and shows Check delivery; cancel is unavailable once dispatch may have happened. Needs attention keeps body and attachments and offers retry, cancel, or recover to the open Chat of the same owner; a missing or archived target is never silently replaced. Re-pairing never retargets items.
- **Attachments** are copied into the record and uploaded only to the recorded computer. File mentions keep their remote paths. Retries may upload again but never start a second turn.
- **UI.** No outbox screen: waiting messages sit in a tray by the Chat's composer, the sidebar row counts them, and removing a computer discards its waiting messages after saying how many. This stays separate from the host's agent-turn queue.
