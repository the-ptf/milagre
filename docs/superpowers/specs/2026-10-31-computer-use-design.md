# Computer use (Experimental)

Agents see and operate desktop apps on the computer their Chat runs on, through
[agent-desktop](https://github.com/vercel-labs/agent-desktop) (Vercel Labs, Apache-2.0, 1.0.2). The user watches the
app's window live inside the Chat, on desktop and phone, as in agentes.chat.

## Decisions (Victor, 2026-10-30)

- **Milagre tools, not Bash.** Milagre wraps a pinned agent-desktop CLI in its own `desktop_*` tools, so it can gate
  apps, force headless delivery, log each action and drive the live screen.
- **Ask once per app per Chat.** The first action on an app shows the existing approval card (`agents.askApproval`):
  Allow, Allow for this Chat, Deny. Milagre, Terminal, iTerm, System Settings and password managers are refused
  outright in this round.
- **Live screen in the message.** While desktop tools run, the Chat shows a card streaming the target window; when the
  turn ends it keeps the last frame. No takeover, no exact-action approvals, no cursor overlay in this round.
- **Experimental.** Settings › Experimental › Computer use, off by default, on desktop and phone (the phone switches
  the Mac's setting, as Simlock does).

## Host (packages/core)

- `agent-desktop` 1.0.2 pinned in `packages/core`. Electron packaging keeps only the host platform's binary and macOS
  helper, unpacked from the asar (the npm package carries every platform, ~60 MB).
- `computer-use.cjs`: settings in `<dataDir>/computer-use.json` (`enabled`), `status()` (agent-desktop `permissions`:
  accessibility, screen recording), `guide()` (`permissions --guide`), `run(args)` (spawn the pinned binary, parse the
  JSON envelope, timeout, never `--headed`, never `--force`), and per-Chat app grants in memory.
- Permissions belong to the app that launches agent-desktop: Milagre.app (or the daemon's launcher on a headless
  computer). Settings shows each state with a Grant button that runs the guide.

## Agent tools (only while the switch is on)

| Tool | Wraps |
|---|---|
| `desktop_apps` | `list-apps`, `list-windows` |
| `desktop_snapshot` | `snapshot --app … -i --compact` (+ `--skeleton`, `--root`, `--surface`, `--window-id`) |
| `desktop_find` | `find` |
| `desktop_act` | `click`, `type`, `set-value`, `clear`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll`, `scroll-to`, `press`, `focus` on a qualified ref |
| `desktop_launch` | `launch`, `focus-window` |
| `desktop_wait` | `wait` |
| `desktop_screenshot` | `screenshot --window-id`, returned as an image |

Every call names its app (from the ref's snapshot when it acts on a ref). The app gate runs first: a refused app or a
Deny answers `POLICY_DENIED` with the reason. Errors pass agent-desktop's `code`, `disposition` and `suggestion`
through so the agent follows its retry rules. Sessions use `--session <chatId>` so two Chats never share refs.

A bundled skill `bundled-skills/desktop/SKILL.md` carries the loop (observe, act on a qualified ref, verify), the retry
rule (retry only `not_delivered`), and Milagre's rules (ask before anything that sends, pays, deletes or publishes; never
type secrets: use request_secret). The system prompt only points at it, to stay inside the prompt size budget.

## Live screen

- Host keeps one capture loop per Chat while a desktop tool ran in the last 20 s: `screenshot --window-id` of the last
  window acted on, about 2 frames a second, JPEG-scaled, deduplicated by hash.
- Frames go out as `computer-use:frame` events (chatId, app, window title, image, at) through the same daemon channel as
  browser screencast frames; the phone gets them over the relay, throttled to 1 fps.
- Desktop: a card in the Chat under the latest desktop tool rows ("Using Finder · Downloads", live dot), click opens a
  larger viewer. When the loop stops it keeps the last frame, labelled with its time.
- Phone: the same card in the transcript, tap opens full screen with pinch zoom (existing image viewer).
- Without Screen Recording permission the card says so with a Grant button instead of frames; the tools still work.

## PRs

1. Host + Settings + tools + skill (desktop + phone switch and permission states). Agents can drive apps; no live card.
2. Live screen: capture loop, events, desktop card + viewer, phone card.

## Not in this round

Take over and hand back, exact-action approvals with hold-to-approve, cursor overlay, headed input, Windows/Linux
QA (the code stays platform-neutral; only macOS is tested).
