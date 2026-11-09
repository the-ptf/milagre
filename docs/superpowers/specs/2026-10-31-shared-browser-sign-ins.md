# Shared browser sign-ins for another computer's Chats

Status: decided by Victor 2026-10-31 (per computer, on with no switch, old per-Chat sessions deleted, no in-app
disclosure). Follows #832 and ADR-0013.

## Problem

A Chat on another computer draws its Browser panel pages on this Mac, in a session of its own:
`persist:milagre-browser-chat-<sha256(chatKey)[:24]>` (`apps/desktop/electron/browser-remote-sessions.cjs`). Milagre makes
a new Chat per task, so every task on that computer starts signed out: GitHub, Vercel, Supabase, the app under
development. Local Chats don't have this problem: every page of every Chat on this Mac shares `persist:milagre-browser`
(`browser-guests.cjs`).

Victor (2026-10-30): "explore the idea of a shared state between chats, like a login would be kept".

## What exists today

| Pages of | Session on the desktop that draws them | Network leaves from |
| --- | --- | --- |
| Chats on this Mac | `persist:milagre-browser`, one for all | this Mac |
| A Chat on computer X | `persist:milagre-browser-chat-<hash>`, one per Chat | X, through X's SOCKS5 proxy on this Mac's host |

- The proxy is set on the session (`session.setProxy`), so a session can only ever reach the web from one computer.
- Nothing deletes a per-Chat partition. Every remote Chat that opened a page leaves its cookies, cache and IndexedDB in
  `~/Library/Application Support/Milagre/Partitions/` forever.
- There is no control anywhere to sign out of, or clear, a Browser panel session.

## Proposal

### On by default, no switch

Decided: every computer's Chats share, as this Mac's do. No setting on desktop or phone; Clear sign-ins is the only
control.

### Scope: one session per computer

All of computer X's Chats share one session on this Mac: `persist:milagre-browser-computer-<sha256(computerId)[:24]>`.

Why per computer:

- **It's the boundary the network already draws.** One proxy per computer, set on the session. A session wider than a
  computer can't exist without breaking "every connection leaves from the Chat's computer". So this Mac's own sign-ins
  can never reach another computer's agents, and X's never reach Y's.
- **Parity with local Chats.** This Mac's Chats already share one session across every Project. X's Chats sharing one
  session on this Mac is the same rule.
- Per Project or per Worktree is possible (`hash(computerId + projectPath)`), but it brings back the sign-in-per-task
  problem for Worktree scope, and Project scope splits sign-ins for third-party sites (GitHub, Vercel) that are the
  same person in every Project.

Known cost, shared with local Chats today: cookies ignore ports, so two Projects running dev servers on `localhost`
with the same cookie name sign each other out.

### Mechanism: a shared partition, not copied cookies

Point the computer's Chats at one partition. `prepare(chatKey)` returns `computerPartition(computerId)`; `route()` and
`refresh()` work per partition already, so they don't change. `CHAT_PARTITION` in `isReady` widens to the new name.

Copying cookies between per-Chat sessions (`session.cookies.on("changed")` + `cookies.set`) was considered and
rejected:

- Many sign-ins live outside cookies: Supabase and Auth0 SPA keep tokens in localStorage, Firebase in IndexedDB.
  Electron has no API to copy those between partitions short of copying files on disk while the session is closed.
- Two-way sync between N live sessions races (sign out in one Chat, sign in in another).
- It would be a per-site allowlist the person maintains, for no gain over the per-computer boundary above.

### Existing per-Chat sessions

Decided: the shared session starts empty, and every `milagre-browser-chat-*` partition is removed on the next launch
(`session.fromPartition(p).clearStorageData()`, then delete the folder). The per-Chat model shipped days ago; few exist.

Rejected: copying their cookies into the shared session once (newest wins; localStorage tokens still lost), and keeping
them for the Chats that made them (two models to maintain).

### Clearing sign-ins

New action, since none exists: **Sign out** for this Mac's session and for each computer's. `session.clearStorageData()`,
`clearAuthCache()`, `clearCache()`, then `closeAllConnections()`; open pages in that session reload signed out.

- Desktop: Settings › Browser, a Sign-ins group with a row for this Mac and one per paired computer.
- Phone: Settings › Browser, "Sign-ins on <Mac>", the same rows. The phone draws no pages: `browser:sign-ins` lists the
  Mac's sessions and `browser:sign-ins:clear` forwards to the desktop app's `browser-panel:clear-sign-ins`
  (`apps/daemon/src/host-browser-sign-ins.cjs`). A confined phone can list but not sign out.

### Security

A shared sign-in reaches every Chat's agent on that computer through the `browser_*` tools: an agent can open the
signed-in site and act as the person, and `browser_evaluate` reads non-httpOnly cookies and localStorage of any origin
it navigates to. Local Chats have had exactly this since the Browser panel shipped.

What stays true:

- This Mac's sign-ins never reach another computer's agents (different session, and its proxy is the other computer).
- Computer X's sign-ins never reach computer Y's agents.
- The CDP proxy refuses `Storage.*` already. Add `Network.getCookies`, `Network.getAllCookies` and
  `Network.setCookie(s)` to its refused list (`packages/core/src/cdp-proxy.cjs`, `OUT_OF_PAGE`): no tool uses them, and
  they read httpOnly cookies for every site in the session.

What shows it: nothing in the app (decided), the same as local Chats today. The ADR records it.

### Local Chats

No change: `persist:milagre-browser` stays the one session for this Mac's Chats. It gets the Clear sign-ins action.

## Out of scope

- Carrying a computer's own sign-ins (its own desktop's `persist:milagre-browser`) to this Mac. That moves cookies
  across machines over the link; a separate decision.
- Agent-started and attached browsers: they have their own profiles.

## Changes

1. `browser-remote-sessions.cjs`: `computerPartition(computerId)`, `prepare` returns it and re-routes only when the
   proxy port changes (so a new page doesn't drop its siblings' connections), `isReady` accepts it,
   `removeChatPartitions`, `clearSignIns`. Tests.
2. `main.cjs`: removes `milagre-browser-chat-*` partitions on launch; `browser-panel:clear-sign-ins`.
3. `cdp-proxy.cjs`: refuses the `Network` cookie methods. Test.
4. Sign out: shared copy (`@milagre/shared/browser-sign-ins`), desktop Settings › Browser, host methods + phone
   Settings › Browser, mobile bridge allowlist, confinement, contracts.
5. ADR-0013 "Sessions" paragraph updated.

Checks: unit tests above, `npm test -- --only test-desktop`, a two-copy QA as in #832 (sign in from Chat A on the
remote copy, open Chat B, still signed in; Clear signs both out; this Mac's local session untouched).
