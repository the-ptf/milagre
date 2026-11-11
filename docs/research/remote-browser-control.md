# Viewing and controlling agent browsers

October 6, 2026. Implements [issue #220](https://github.com/the-ptf/milagre-ade/issues/220). Ownership is decided in [ADR-0016](../adr/0016-browser-page-ownership.md).

The Browser pill streams the agent's real page, with its signed-in state, using the Chrome DevTools Protocol screencast. Frames travel as JPEG over the existing authenticated RPC, so the phone works wherever its Chats work, including through the public relay, with no TURN service and no native build.

## Supported targets

Chromium-family browsers (Chrome, Chromium, Edge, headless Chrome) whose browser process was started with `--remote-debugging-port` and listens on loopback. Discovery reads `ps` and `lsof` and probes `/json/version` and `/json/list` on that browser's own listener; it starts no capture. Only `page` targets are listed; DevTools and extension pages are hidden. macOS and Linux are supported; Windows reports the feature unsupported. Firefox, Safari and pipe-only browsers are out of scope.

## Capture path

| Option                              | Result                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CDP `Page.startScreencast` (chosen) | Chromium encodes JPEG frames only when the page changes. Pure Node in the daemon, no helper binary to pin, sign or download. Works for headless browsers.                              |
| WebRTC, as for simulators           | Needs an encoder on the host: a native addon or a hidden Chromium window per stream, plus TURN for remote phones. Browser pages are mostly still, so its continuous video buys little. |
| Opening the URL in a phone WebView  | Rejected by the issue: a separate copy has neither the session nor the page state.                                                                                                     |

Frames are pulled. A viewer asks for a frame newer than the last it showed; the host keeps only the newest frame and holds the request up to 2.5 seconds. A slow link skips intermediate frames instead of queuing them, so latency stays bounded. Frames are capped at 1280 pixels on the longer side, JPEG quality 60, and frames over 1.5 MiB are dropped.

On the phone, frame bytes still pass through React Native: they arrive from the relay as base64 in the RPC reply and are written to a cache file. Only the file address crosses into the DOM WebView, so injected script never carries image bytes. This keeps frames out of the WebView message bridge, not out of React Native's JavaScript; the pull model bounds that load to one frame in flight. The two newest files are kept and all are deleted when the viewer closes. Desktop passes the base64 frame to its sandboxed iframe as a data URL.

## Input

The receiver normalizes pointer positions to the displayed, letterboxed page. The host maps them to CSS pixels using the viewport from the latest frame and rejects input from an older viewport generation, so a resize cannot misplace a click.

- Mouse: press, move, release and wheel, with click count and modifiers. Moves collapse to the newest and wheels add up while a request is in flight; presses and releases are never merged.
- Touch: a tap clicks, moving scrolls the page by the finger's travel, and holding still for 450 ms presses the mouse for a drag (selection, sliders). A second finger is ignored; pinch zoom is not supported.
- Keyboard: a hidden text field receives keys. Named keys and ordinary characters are sent as key events; IME composition, dictation, predictions and paste are inserted as text. Cmd or Ctrl with A, C, X, V, Z and Y run the page's editing commands. On the phone the Keyboard icon raises the system keyboard; on desktop clicking the page directs typing to it. Escape reaches the page while typing into it and otherwise closes the viewer.
- Back, Forward and Reload use the page's own history.

The host validates every field, copies only admitted fields into DevTools commands, rate-limits input, and releases a held button or key on takeover, resize, expiry, disconnect and close.

## Security boundaries

- The phone and renderer never see a DevTools URL, port or browser process ID. Targets are opaque `browserGuid:pageId` identifiers resolved again through ownership on every open.
- DevTools connections are made only to loopback listeners owned by the discovered browser process.
- Capabilities belong to the server-assigned connection identity; a disconnected client loses its viewers. Confined demo connections are refused every browser command.
- Closing a viewer stops Milagre's screencast only. Nothing calls `Target.closeTarget` or `Browser.close`.

## Evidence

Automated: core service and adapter (21 tests), shared receiver (13), daemon transport (2), mobile UI (3). Full suites: shared, core, desktop agent and UI, and mobile pass; one daemon test (`mobile-bridge.test.cjs`, a named Link counting 8 projects instead of 2) fails identically on the unmodified base commit because it reads this machine's project registry. Desktop and mobile typechecks, mobile lint and the production desktop build pass; the built bundle keeps the receiver byte-identical to its CSP hash. The iOS fingerprint is unchanged at `64b0bb9aecd3e78a5aab6ea06a990fb26b4c293a`. A real Electron check, `npm run test:browsers`, runs the actual composer and core service against two headless Chrome instances. It covers pill order and count, capture only on open, direct open of a sole page, the live frame, title and URL in the header, click, typing, Backspace, wheel, live theme changes without reconnecting, expand and collapse, takeover and retaking control, explicit attach, close leaving both browsers running, and a page closing while viewed. It passed three consecutive runs.

The mobile app ran in Expo Go on an iOS 26.5 simulator against the real daemon. The attached page streamed through the file-backed path; a tap focused its input, the Keyboard icon raised the system keyboard, typed text and Backspace reached the page, a swipe scrolled it, and switching the simulator to dark mode restyled the controls without reconnecting. Closing the sheet left no DevTools connection open and the browser running. That run covered one attached page, the empty state and attach; it did not exercise the phone picker with several pages, takeover, Retry, backgrounding or disconnect on the phone (those paths run in the shared receiver tests and the desktop check). Expo Go is not the TestFlight runtime, although the WebView and file APIs used are the ones the simulator viewer already ships.

## Remaining gaps

- Lineage is sampled every five seconds while agents run. A browser that leaves the agent's process tree sooner is offered for attachment instead of shown as the agent's.
- A debugging browser that no Chat started shows the Browser pill, with 0 pages, in every Chat, so it can be attached. No page is attributed without that action.

- Physical phones and cellular networks were not tested. Frames ride the existing relay, so no TURN is involved, but frame rate over a slow link was not measured.
- Real agent tools: lineage was verified with browsers started under the host process, not with each MCP server. chrome-devtools-mcp and Playwright default to pipe transports unless given a port.
- A background tab in a headed browser produces no screencast frames; the viewer then shows "Connecting to the page" until its 30-second deadline. Milagre does not bring the tab to the front, since that would change the agent's browser.
- Pinch zoom, file pickers, native dialogs (alert, print) and drag-and-drop between apps are not forwarded.
- The agent is not paused while a person controls the page.
