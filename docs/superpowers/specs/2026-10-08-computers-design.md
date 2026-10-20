# One desktop window drives every paired computer

Date: 2026-10-08. Status: approved design, awaiting spec review.

## Goal

A Milagre desktop window shows and drives the chats of other Macs running Milagre, next to its own, in one sidebar. The
phone already pairs with several Macs; this brings the same pairing to the desktop, with full desktop parity on a remote
computer: send, stop and continue, approvals and questions, diffs, commit/push/PR, canvas, Links, designs, simulators,
browsers and adding Projects.

Modeled on Paseo (getpaseo/paseo, read at 06fe97c on 2026-10-08): one merged list with the host on each row, the local
machine as just the first host, a footer popover listing hosts with status, and a gear per host that opens its settings.

## Decisions

| Question | Decision |
| --- | --- |
| Sidebar | One merged list of Projects (design `sidebar-c-sections` v6). Each chat row's second line starts with its computer, then its PR chips. No per-computer headers. |
| When rows show the computer | Only with two or more computers. With just this Mac the sidebar is unchanged. |
| Computer status | Footer laptop button opens a popover: each computer with its status dot, route on a second line ("This Mac", "Same network", "relay.milagre.cloud", "Offline, seen 2h ago"), a gear on hover, and Add computer. |
| Scope on a remote computer | Full desktop parity, except actions that only make sense on the machine in front of you (below). |
| Architecture | The remote daemon accepts paired desktops and runs its normal command dispatcher for them. Electron main keeps one channel per computer and routes calls and events by computer id. |
| Pairing | The phone's pairing link and QR, unchanged in format. Add computer takes the pasted link. |
| Transport | Same as the phone: the encrypted LAN route when both Macs share a network, relay.milagre.cloud otherwise. |
| Trust | A paired desktop can do anything the Mac's own window can, except pairing and device management. Removable any time from that Mac. |
| Allowing a computer | A new computer's first pairing waits for Allow on the Mac being paired. Phones pair as before. Decided 2026-10-08: the pairing token lives until Reset, so without this any phone that ever scanned the QR could pair a full-control computer. |
| Offline computer | Its Projects and chats stay in the sidebar from a local cache, dimmed and read-only. |
| Phone in this work | The phone sends its name when pairing so Settings › Devices can list it. A merged multi-computer list on the phone is a follow-up. |
| Rollout | Behind Settings › Experimental ("Other computers") until the last PR lands. |

## Screens

All on the Chat's canvas, approved 2026-10-08:

- `sidebar-c-sections` v6: merged list, computer on each chat's second line, popover open, gear tooltip.
- `add-computer` v1: paste the link, the computer it found and how it is reached, "Show it as" name, full-control note.
- `settings-devices` v1: on the other Mac. Replaces Settings › Phone. The on/off switch, Pair a device (QR, Copy link,
  countdown), then Computers and Phones lists, each with status, last seen and Remove. Its "Each link pairs one
  device" line is wrong: any number of devices can pair while the window is open, and the link only changes on Reset.
  The Remove confirm reads "Remove <name>? It can pair again from Pair a device."
- `add-project-remote` v1: choose the computer (offline ones disabled), then browse that computer's folders.
- `computer-settings` v1: what the gear opens for a remote computer. Name (local label only), connection routes and
  which is in use, what lives there, Remove. For This Mac the gear opens Settings › Devices.

Opening a chat of an offline computer shows a banner ("studio is offline. This is the last copy it sent, 2h ago.") and
a disabled composer (`sidebar-c-sections` v3 shows that state).

## Terms

Add **Computer** to `GLOSSARY.md`: a Mac running Milagre whose daemon owns its Projects. "This Mac" is the computer the
window runs on; others are paired computers. **Device** covers phones and computers paired to a Mac.

## Today

- The daemon serves the desktop over a private Unix socket. `apps/daemon/src/server.cjs:335-535` handles each
  connection inline: `wire()` framing, `dispatch()` (383-534, method chain from about 461), per-socket `context.clientId`, `views`, `resultPages`,
  `patchSockets`, and `broadcast()` fan-out (256-272). Nothing there is socket-agnostic.
- Electron main registers every daemon method as a pass-through (`apps/desktop/electron/main.cjs:209-215`) and rebroadcasts
  every event to all windows (184-196). `daemon-runtime.cjs` owns reconnect, resync and state patches.
- Phones pair through `relay-crypto.mjs` (`phoneHello`, `hostAccept`) and talk HTTP-over-channel to the mobile bridge
  (`phone-channels.cjs`), which allows a fixed method list (`mobile-bridge.cjs:22-106`). There is no client kind.
- The Mac remembers phones only as public keys (`relay-identity.cjs:99-130`, `relay-phones.json`, at most 32), so the
  Phone panel shows a count and "Reset all".
- The relay caps frames at 1 MiB and rooms at 16 devices (`apps/relay/src/room.mjs:4-5`). Daemon frames go up to 16 MiB.
- Chat keys are `${scopePath}#${id}` (`packages/shared/src/agent-runs.mjs:16-27`), built or parsed in 17 renderer files.
- ADR-0003: one daemon owns each Project; remote transports "cannot create another writer". This design keeps that: a
  remote computer's Projects are only ever opened by its own daemon.

## The other Mac (daemon)

### Connections

Factor the inline handler into `acceptConnection({ send, end, destroy, isClosed, requireAuthentication, policy })` in
`server.cjs`, returning `{ receive, invalid, close }`. The socket needs `end` and `destroy` separately, `isClosed` for
the late simulator and browser cleanup, and Windows authentication, so a smaller signature cannot keep its behavior. It
owns the connection key, `context.clientId`, the view, result pages, patch subscription, in-flight limits and cleanup
(`runtime.disconnect`). The Unix socket calls it with `wire()`'s `send`; paired desktops call it with a channel `send`.
Behavior over the socket does not change; the existing daemon tests must pass untouched.

`policy` is checked in `dispatch` before the method chain. The socket gets none. Paired desktops get a deny set:

- `phone:*` and `devices:*` (pairing and device management)
- `linear:connect` and `linear:disconnect` (signing this Mac in to Linear, #338)
- `push:*`
- `daemon:stop`

Everything else is allowed, so a new desktop method works remotely by default. A denied call answers with a typed error
the renderer shows as "Not available on a remote computer".

### Channel

Paired desktops use the phone's routes (relay room and LAN on 8798) and its crypto. Changes in `phone-channels.cjs`:

- The hello's inner JSON gains `kind: "desktop"` and `name`. No `kind` means phone, so existing phones keep working.
- After `hostAccept`, a desktop channel stops speaking HTTP-over-channel. Its messages are `t: "rpc"` (one daemon
  request), `t: "evt"` (one daemon frame: a reply, an error or a pushed event) and `t: "part"`. A frame over 768 KiB
  travels as 512 KiB base64 pieces (a 768 KiB piece would pass the relay's 1 MiB cap once encoded), reassembled in
  order by `id` and index, capped at the daemon's 16 MiB frame limit.
- A known device keeps the kind it paired as: a phone key saying `desktop`, or a computer key with no kind, is refused
  with `reason: "kind"`. With confined phone access (`allowedRoot`, the review demo) the Mac never hosts desktops.
- The deny set filters events too: a paired desktop never receives `phone:*` events (`phone:status` carries the
  pairing link and token).
- A desktop learns the Mac's LAN addresses with a new `peer:routes` method, since `phone:routes` lives in the phone
  bridge and `phone:*` is denied.
- The channel opens a virtual connection with `acceptConnection` and the desktop policy, and closes it when the channel
  closes.
- Pairing still happens only through the relay inside the 10-minute window; the LAN still refuses unknown keys.

### Devices store

Replace `relay-phones.json` with `devices.json`: `{ devices: [{ key, kind: "phone" | "computer", name, pairedAt,
lastSeen }], removed: [{ key, removedAt }] }`, mode 0600. On first read, existing phone keys migrate as `{ kind: "phone",
name: null }` and show as "Phone", and the old file is deleted. `MAX_DEVICES` stays 32. `isKnown` and `add` keep their
shapes; every accepted hello updates the name (so migrated phones pick theirs up) and `lastSeen` (written at most once
a minute). The hello says `kind: "desktop"`; the store records that device as `kind: "computer"`.

A phone also gets `isNew: true` and `announced: false` when it pairs (#382), since nobody at this Mac saw it pair. The
desktop takes the "New phone paired" notice with `devices:take-notices`, at launch, after a reconnect and on each
`phone:paired` event, and confirms it with `devices:confirm-notices(claim)` once shown. A taken notice is only claimed,
in memory: no other window gets it meanwhile, and it is offered again if the connection closes first, the claim times
out (60 s) or the daemon restarts. So a phone that paired while Milagre was closed is announced when it opens, a lost
reply never loses it, and two windows never both show it. Settings › Devices marks `isNew` phones New and clears it with
`devices:acknowledge(keys)` once shown. A computer pairs after Allow at this Mac, so it is neither.

The pairing check becomes per device: a key in `removed` cannot pair again inside a pairing window that was already
open when it was removed. Without this, a removed phone redials and re-pairs within seconds, because showing the QR in
Settings opens the window.

New methods, socket only (they are in the deny set): `devices:list` and `devices:remove(key)`. Remove deletes the entry,
adds it to `removed` and closes that device's open channels on the relay and the LAN. Known limits: push registrations
are keyed by an id the phone makes, not its pairing key, so a removed phone keeps receiving push until Reset; phones on
a Cloudflare tunnel use the bearer token and are not listed. "Reset all" stays as the existing rotate-identity action.

### Remote-only helpers

- `fs:list-dirs({ path })`: folder names, whether each is a git repo and its branch, and whether it is already a
  Project. Starts at the home folder; refuses paths outside it. Feeds the remote folder picker.
- `media:read({ scope, path })`: the bytes of an image or file a chat references, limited to the files the daemon
  already serves to the phone (`serveMedia` in `mobile-bridge.cjs`, moved to a shared `media-access.cjs`). The scope
  names the Project or Link whose folders are allowed. Replaces `milagre-media://` for remote chats.

### Allowing a new computer

A desktop hello from a key the Mac doesn't know yet, inside the pairing window, no longer opens a daemon connection
right away. The daemon holds the channel open, records a pending request `{ key, name, at }` and broadcasts
`devices:pending` to its own window (never to desktops: `devices:*` is denied). The Mac's window shows a prompt:
"studio wants to drive this Mac's chats. Allow / Deny", with the name from the hello. Allow stores the device as a
computer and opens its connection on the held channel; Deny refuses it with `reason: "denied"` and saves nothing. A
request that gets no answer within the pairing window it arrived in, or whose channel closes, is dropped. While it
waits, the Mac sends the desktop a pending notice every 20 s so the 15 s hello timer and idle relay sockets don't drop
it. Deny, expiry and a full queue (at most 4 waiting) answer `code: "unknown-phone"` with `reason: "denied"` or
`"busy"`. Once allowed, the "New computer paired" notification is not shown (the owner just clicked Allow). Known computers reconnect
without asking. The desktop shows "Waiting for studio to allow this Mac…" until then.

## This Mac (Electron main)

### Computers

A new `apps/desktop/electron/computers.cjs`:

- `computers.json` in userData: `[{ id, hostId, name, relay, lanRoutes, addedAt, lastSeen }]`. The pinned host key,
  the pairing token (every hello carries it, even from known devices) and the desktop's own keypair are sealed with
  `safeStorage`.
- One transport per computer: a desktop client (`peer-client.cjs`) that speaks `rpc`/`evt`/`part` over the relay
  crypto, with the handshake timing of the phone's `relay-transport.ts` (which stays on the phone: it speaks
  HTTP-over-channel), plus the pure route supervisor from `apps/mobile/src/routes.ts`, moved to `packages/shared`. LAN first, relay otherwise, re-checked on connect, every 60 s and on
  network change.
- One remote runtime per computer, reusing `daemon-runtime.cjs` with the channel in place of the socket: the same
  reconnect, `eventSeq` watermark, paged snapshot and state-patch resync.
- Pairing: Add computer parses the link with `parsePairing` (`apps/mobile/src/pairing.ts`, moved to `packages/shared`
  with the transport), accepts only relay links, opens the relay channel with a hello carrying `kind: "desktop"` and
  the Mac's name, and saves the computer once `hostAccept` answers.

### Routing

- Renderer calls name their computer: `window.milagre.on(computerId).invoke(method, args)`. The existing flat
  `window.milagre.*` calls stay as shorthands for `local`, so untouched screens keep working.
- Events reach the renderer tagged `{ computerId, channel, payload }`.
- Local-only handlers stay local and are hidden for remote chats: `editor:open`, `project:reveal`, `skills:open`,
  `skills:reveal`, the `project:open` folder dialog (replaced by the remote folder picker), image copy/save menus that
  read local paths (they fetch through `media:read` first), notifications settings, updates.
- OS notifications for a remote computer's chats go through the existing `AttentionNotifier`, labeled with the
  computer.
- Routines run on the Mac that owns them, and the window lists and manages every computer's (`routines:*` is routed
  like any other call). A Routine's id and its Runs' ids come back qualified like chat keys (`${computerId}|${id}`), so
  `bridgeForKey(routine.id)` reaches its computer.

### Offline cache

Each computer's last sidebar state and the transcripts of its last 20 opened chats are written to
`userData/computers/<id>/cache.sqlite` when they arrive, and read when the computer is offline. Its Routines list, its
Routines switch and its Routine targets are kept the same way; webhook URLs never are. Removing a computer deletes its
folder.

## Renderer

- A chat's identity becomes `{ computerId, key }`. `local` is this Mac, and local keys are unchanged, so drafts,
  pinned chats and settings keep their stored keys. Remote keys qualify the scope: `${computerId}|${path}#${id}` for a Project and `milagre-link:${computerId}|${linkId}#${id}` for a Link (the prefix stays first because renderer code slices it).
- Central changes: `@milagre/shared/agent-runs` (key helpers take an optional computer), `state-events.ts` (one state
  per computer and scope), `sidebar-scopes.ts` (scopes from every computer, merged by Project name order), and
  `chat-messages.ts`, `draft-store.ts`. `App.tsx` reads the selected chat's computer and routes through it.
- Sidebar (`SidebarNav.tsx`, `sidebar/ChatRow.tsx`): with two or more computers, every chat row is two lines and the
  second line starts with a laptop icon and the computer name, then the PR chips. An offline computer's Projects and
  rows are dimmed and its rows read "studio, offline".
- Footer: a laptop button (beside Add project and Link projects) opens the computers popover. The gear opens Computer
  settings, a new Settings section per computer.
- Add project asks for the computer first when there is more than one.
- A denied or local-only action is hidden on remote chats rather than shown disabled.

## Phone

- The phone's hello sends `name`: `Device.deviceName` from `expo-device` (already linked at `~57.0.2` and used by
  `push-native.ts`, so the fingerprint does not change; confirm with the fingerprint check). iOS 16 and later return a
  generic "iPhone" without an entitlement that needs a native build, so the phone falls back to `Device.modelName`
  ("iPhone 16 Pro"). JS only, shipped as an OTA.
- Copy that says "Settings → Phone" (`relay-transport.ts`, `pairing.ts`, `client.ts`, `app/index.tsx`,
  `add-computer.tsx`) becomes "Settings → Devices", as do `notifications.cjs`, the docs and the help skill.
- Nothing else changes on the phone in this work.

## Errors

- A computer that stops answering: its dot turns amber ("Reconnecting…"), then grey ("Offline, seen 2h ago") after 30 s.
  Its rows dim and read-only mode starts; the composer is disabled and sends are refused with "studio is offline";
  nothing is queued.
- Removed on the other Mac: `hostAccept` refuses with `unknown-phone`; the computer shows "Removed on studio. Pair
  again with a new link." and its cache stays until removed here.
- A pairing link past its 10 minutes: "This link expired. Copy a new one on studio."
- Version skew: a daemon from before PR 1 ignores `kind`, accepts a desktop hello as a phone and closes the channel on
  the first `rpc` message. PR 1's daemons refuse a desktop hello with `reason: "kind"`. Either way the window shows
  "Update Milagre on studio to connect." Only daemons with `desktop-peer-v1` (PR 2) accept desktops.
- Relay room full (16 devices): "studio has too many devices connected. Remove one in its Settings › Devices."

## Testing

- Unit: frame splitting and reassembly (order, gaps, the 16 MiB cap), the deny set, the devices store migration and
  remove, hello `kind` handling (missing kind is a phone).
- Daemon: the existing socket tests unchanged; a virtual connection gets events, patches and result pages the same way.
- End to end: a throwaway daemon and a local relay (as in the relay e2e), with a raw desktop client from the test kit
  until PR 3 brings the real one: it pairs, reads `daemon:status`, gets a state change as an event, round-trips a
  frame large enough to travel in parts, uses the LAN route, and is refused `devices:remove`.
- Electron checks: `test-sidebar-computers.cjs` (merged list, second line only with two computers, offline dimming,
  popover and gear) and `test-add-computer.cjs` (paste, found computer, errors), against a fake remote runtime.
- Manual: this Mac and a second Mac (or a second user account) on the same network and apart, with the phone still
  paired to both.

## Order of work

Each step is its own PR, behind the Experimental flag until step 4 lands.

1. `acceptConnection` refactor, the devices store with migration, `devices:list`/`devices:remove`, Settings › Devices
   on desktop, the phone sending its name (OTA).
2. The paired-desktop channel: hello `kind`, `rpc`/`evt`/`part` messages, the deny set, `desktop-peer-v1`, end-to-end
   test.
3. `computers.cjs`, the shared transport move, Add computer, the footer popover, Computer settings.
4. The multi-computer renderer: identity, routing, the sidebar's second line, remote limits, the offline cache.
5. `fs:list-dirs` with the remote folder picker, and `media:read` for remote images and files.

## Out of scope

- A merged multi-computer list on the phone.
- Direct `host:port` or SSH connections (Paseo's Direct and SSH methods).
- Sharing Accounts between computers; Accounts stay on their own computer (ADR-0005).
- Links that span Projects on different computers.
