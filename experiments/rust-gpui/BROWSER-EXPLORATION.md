# Browser panel exploration (WP-35)

The Browser panel and the agent's browser tools were out of scope for the GPUI port (PORT-MAP WP-35, D2). This note
maps today's stack, compares the ways GPUI could host it, and reports a spike of the recommended option. Written
2026-11-11 on `milagre/chat-tie0`. The spike runs only with `MILAGRE_GPUI_BROWSER_SPIKE=1`.

## 1. Today's browser stack

Paths are relative to the repository root. "Core" means `packages/core/src`, which runs in the Node daemon.

| Part                               | Where it runs                                                                                                                                                                                                                                                 | Protocol                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs, address bar, start page      | Renderer: `BrowserPanel.tsx`, `lib/browser-panel.ts` (state in localStorage)                                                                                                                                                                                  | none                                                                                                                                                |
| The pages                          | Renderer: one Electron `<webview>` per tab, laid over the panel (`lib/browser-webviews.ts`, at most 8 alive). Main locks them down (`electron/browser-guests.cjs`: no preload, http(s) only, popups become tabs)                                              | Electron IPC `browser-panel:*`                                                                                                                      |
| CDP for the pages                  | Main: `guest.debugger.attach` (`electron/browser-panel-pages.cjs`) behind core's `cdp-proxy.cjs`, a loopback HTTP and WebSocket DevTools endpoint behind a 48-hex token. It refuses `Target.*`, `Browser.*`, `Storage.*`, cookies                             | Main tells the daemon `{port, prefix, pages}` with RPC `browser:panel-pages`                                                                        |
| Agent tools                        | Daemon (core): `chat-browser-tools.cjs` (snapshot, click, fill, upload, screenshot, console, evaluate, ...) and `chat-browsers.cjs` (list, attach, detach)                                                                                                    | CDP JSON over WebSocket to whatever endpoint owns the page (`browsers-cdp.cjs` `session`). Refs like `@e12` come from `Accessibility.getFullAXTree` |
| `browser_open`                     | Daemon emits `browser-panel:open`; main forwards it to the renderer, which opens a tab; the tool polls `browser:list` until the page shows                                                                                                                    | daemon event, then IPC                                                                                                                              |
| Agent-started and attached Chromes | Daemon (core): `browsers-cdp.cjs` `discover` finds `--remote-debugging-port` processes with `ps` and `lsof`; ownership by process lineage (`browsers.cjs`)                                                                                                    | HTTP `/json/*`, CDP over WebSocket                                                                                                                  |
| Streamed viewer                    | Daemon (core): `browser:open/frame/status/control/input/close` (`browsers.cjs:390-532`, `browsers-cdp.cjs` `connect`). `Page.startScreencast` JPEG q60, max 1280 px, newest frame only, `frame` long-polls 2.5 s; `Input.dispatch*`; token-bucket input limit | Daemon RPC. **Nothing calls it today**: the phone moved to its own webview (`browser:page-url`, a tunnel) and the desktop to `<webview>` (ADR-0013) |
| Shared sign-ins                    | Main: Electron partitions, `persist:milagre-browser` for this Mac, `persist:milagre-browser-computer-<hash>` per paired computer; clearing in `browser-remote-sessions.cjs`                                                                                   | IPC `browser-panel:clear-sign-ins`; daemon RPC `browser:sign-ins`, `browser:sign-ins:clear` for the phone                                           |
| Remote Chats' pages (ADR-0013)     | Network: daemon SOCKS5 per paired computer (`apps/daemon/src/browser-proxy.cjs`), set on the partition. Driving: the Chat's host reaches this desktop's cdp-proxy through a forwarder over the computer link (`panel-forwarders.cjs`)                         | SOCKS5, then peer TCP streams; CDP over those                                                                                                       |
| Attach a browser                   | Daemon: `browser:attach` on a `discover`ed Chrome (explicit user action, up to 16 per Chat)                                                                                                                                                                   | Daemon RPC                                                                                                                                          |
| Page comments                      | Renderer: picker script injected in the page (`shared/page-picker.mjs`), pins, `browser-panel:capture` for element shots                                                                                                                                      | IPC, daemon `browser-comments:*`                                                                                                                    |
| `html_preview`                     | Daemon: the only Chromium the product launches itself (`html-render.cjs`, headless, `--remote-debugging-port=0`, throwaway profile)                                                                                                                           | CDP                                                                                                                                                 |

So the daemon already owns every browser except the panel's, and it already drives every page, the panel's included,
over plain CDP. Electron's part is hosting `<webview>`s, their partitions and proxy, and fronting their debuggers.
That part is what GPUI would have to replace.

## 2. Options

| Option                                   | Fidelity                                                                                                                                                                                                           | Performance (measured where marked)                                                                                                                                                | Agent tools unchanged?                                                                                                                                                                                                                    | Shared sign-ins                                                                                                                                                | Licence, size                                                                                                                                                                  | Fit with the daemon and client                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. WKWebView child view** (WP-34 host) | Native: video, momentum scroll, IME, cursor, menus all real. DevTools only through Safari's Web Inspector                                                                                                          | Native, best of all. The WP-34 host already places, clips and focuses it                                                                                                           | **No.** WebKit has no CDP: no `Accessibility.getFullAXTree`, no trusted `Input.dispatch*`, no `DOM.setFileInputFiles`. Every tool would need a WebKit rewrite (injected JS, synthetic events pages can tell apart) with GPUI as its owner | `WKWebsiteDataStore(forIdentifier:)` and per-store SOCKS5 proxies need macOS 14. Separate engine from the agents' Chromes                                      | System framework: no size, no licence issue                                                                                                                                    | Poor: the page lives in the GPUI process, so GPUI becomes a second browser owner and the daemon needs a new protocol into it. Phone and remote desktops lose it |
| **B. Daemon-owned Chromium, streamed**   | Good for documents and apps. JPEG frames (q60 artefacts on video), no local momentum (it is the page's), no cursor shape over CDP, IME needs `Input.imeSetComposition`. DevTools: the browser's own frontend works | Spike, 800×600 page: 60 fps scrolling and animation, click→frame p50 7 ms (1x) and 13 ms (2x), key→frame 15 ms, decode 1 to 4.5 ms. Chrome 31 to 50% CPU at 1x, 90% at 2x, ~0 idle | **Yes.** The panel's pages become CDP targets of a Chromium the daemon launched; `chat-browser-tools.cjs` drives them as it drives attached browsers today                                                                                | One persistent profile per computer (as today's partitions), `--proxy-server=socks5://…` for a paired computer's. Existing Electron sign-ins do not carry over | Installed Chrome: nothing to ship (`html_preview` already relies on it). Shipping Chromium (BSD-3) or Chrome for Testing is 150 to 300 MB, downloaded on first use             | Best: the daemon already has the viewer (`browser:open/frame/input`), the CDP sessions and the proxies. GPUI is only a viewer, like the phone was               |
| **C. CEF embedded in GPUI**              | Full Chromium. Off-screen rendering gives BGRA buffers or shared IOSurface textures GPUI can draw; IME, cursor and popups need CEF's handlers wired to GPUI                                                        | Accelerated OSR avoids JPEG entirely: lower latency and CPU than B                                                                                                                 | Yes, with `remote_debugging_port` registered as panel pages (as cdp-proxy is)                                                                                                                                                             | CEF request contexts with cache paths and proxies                                                                                                              | BSD-3. The framework is ~250 MB per arch, a new release with every Chromium (four weeks); Rust bindings (`cef` crate) young; helper-process bundle layout and signing on macOS | Poor: Chromium in the GPUI process makes GPUI a browser owner and couples app updates to Chromium security releases                                             |
| **D1. Default browser for user tabs**    | Perfect, outside Milagre                                                                                                                                                                                           | n/a                                                                                                                                                                                | Agent pages only (PORT-MAP's v1)                                                                                                                                                                                                          | The user's own                                                                                                                                                 | none                                                                                                                                                                           | Trivial, but no panel: the person can't watch the agent's page                                                                                                  |
| **D2. A hidden Electron helper**         | Today's exactly                                                                                                                                                                                                    | As today, plus streaming                                                                                                                                                           | Yes                                                                                                                                                                                                                                       | Today's partitions, kept                                                                                                                                       | Ships Electron next to GPUI (~250 MB), the thing the port removes                                                                                                              | Keeps a Node and Electron runtime alive for one panel                                                                                                           |

**Recommendation: B.** It is the only option where the agent tools keep working unchanged and GPUI does not become a
second browser owner, and most of it exists: the daemon's streamed viewer is exactly what the spike calls. Use the
streamed panel for agent and attached pages and for user tabs; offer "Open in browser" for anything that needs native
fidelity (video calls, heavy video). Revisit C only if the streamed panel's fidelity is not good enough after the
items in section 4.

ADR-0013 rejected streaming for remote pages because the stream followed "a window nobody was looking at". Here the
browser is headless and each viewer sets the page's size and scale, so that objection does not apply; the network
still goes through the Chat's computer by the same SOCKS proxy.

## 3. The spike

`MILAGRE_GPUI_BROWSER_SPIKE=1` adds a Browser tab to the side panel. It shows a page from a headless Chrome and
forwards clicks, drags, the wheel and typing.

| File                                    | What                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/cdp.rs`                   | Launches the installed Chrome `--headless=new --remote-debugging-pipe` on a `/tmp` profile (removed on close). CDP is NUL-delimited JSON on fds 3 and 4: no port, no WebSocket, nothing else can connect |
| `src/workspace/panel/browser/bridge.rs` | `BrowserBridge`: the daemon's `BrowserApi` (`packages/shared/src/browser.ts`) in Rust. The seam the shared client fills                                                                                  |
| `src/workspace/panel/browser/spike.rs`  | The spike's bridge: `Page.startScreencast` and `Input.dispatch*`, as `browsers-cdp.cjs` `connect` does                                                                                                   |
| `src/workspace/panel/browser/mod.rs`    | The view: toolbar (back, forward, reload, address), the picture, input, and a numbers overlay                                                                                                            |
| `src/workspace/panel/browser/keys.rs`   | GPUI keystrokes as DOM key events, ⌘A/C/X/V/Z as editing commands                                                                                                                                        |
| `src/workspace/panel/browser/tests.rs`  | Key and geometry tests, a GPUI test of the input path over a fake bridge, and the bench                                                                                                                  |

Run it: `MILAGRE_GPUI_BROWSER_SPIKE=1 MILAGRE_GPUI_PANEL_TAB=Browser cargo run`. `MILAGRE_GPUI_BROWSER_SPIKE_URL`
picks the page (default: a built-in test page), `_CHROME` the binary, `_SCALE` the browser's scale (2), `_QUALITY`
the JPEG quality (60).

### Numbers

`cargo test --release browser_spike_bench -- --ignored --nocapture` drives the same bridge the view uses, against
Chrome 157 on this Mac (Apple silicon), on an 800×600 CSS-pixel page. Latency is from sending the input to receiving
the first frame that shows it: the bench reads a corner flag the page recolours on every press, out of the decoded
frame. The view then adds the decode and one GPUI frame (up to 16.7 ms) before it is on screen.

| Measure                      | Page at 1x (800×600 JPEG, ~16 KB) | Page at 2x (1600×1200 JPEG, ~42 KB) |
| ---------------------------- | --------------------------------- | ----------------------------------- |
| Click → frame, p50 / p90     | 7.3 / 8.9 ms                      | 13.1 / 16.4 ms                      |
| Key → frame, p50 / p90       | 14.5 / 15.6 ms                    | 13.1 / 13.2 ms                      |
| Scrolling (wheel every 8 ms) | 60.4 fps, Chrome 44% CPU          | 60.0 fps, Chrome 90% CPU            |
| Canvas animation             | 60.8 fps, Chrome 51% CPU          | 60.3 fps, Chrome 92% CPU            |
| JPEG decode to BGRA          | 0.9 to 1.3 ms                     | 3.2 to 4.5 ms                       |
| Viewer CPU (decode, bench)   | 7 to 8%                           | 20 to 24%                           |
| Idle                         | 0.1 to 0.2 fps, Chrome 1 to 5%    | 0.1 fps                             |

Input to photon is about 25 to 45 ms, against 16 to 33 ms for a native view: a frame or two behind, at a steady
60 fps. The cost is CPU at 2x: encoding 1600×1200 JPEGs at 60 fps keeps Chrome near one core while the page moves,
and nothing while it is still. The daemon's 1280 px cap would halve that and blur text on a 2x screen; a panel is
usually narrower than 800 px, which helps.

Verified in the bench: 31 clicks counted, "hello gpui" typed into a field, the page scrolled 3,000 px. Not measured:
GPUI's own paint and atlas upload on a visible window (the window must not come to the front during this work; a
snapshot never activates it).

### Snapshots and frames

- `/tmp/milagre-browser-spike/gpui-browser-dark.png`, `gpui-browser-light.png`: the GPUI window with the Browser tab
  (headless snapshot, the page's first frame; the overlay's 435 ms decode is the unoptimised debug build).
- `/tmp/milagre-browser-spike/typed-2x.jpg`, `scrolled-2x.jpg`, `animation-2x.jpg` (and `-1x`): frames from the bench
  after typing, scrolling and during the animation.

### What the spike leaves out

IME composition, cursor shapes, `<select>` popups and JavaScript dialogs, file choosers, downloads, drag and drop, new
windows becoming tabs, the start page, an editable address bar, page comments and the token-bucket input limit. Each
has a CDP route (`Input.imeSetComposition`, `Page.javascriptDialogOpening`, `Page.setInterceptFileChooserDialog`,
`Browser.setDownloadBehavior`, `Input.dispatchDragEvent`, `Target.targetCreated`); cursor shape has none and needs a
small injected script reporting the hovered element's cursor.

## 4. What the shared client needs from the backend team

GPUI keeps `BrowserBridge` and swaps `spike.rs` for a client-backed implementation; `platform/cdp.rs` is deleted.

Typed client methods, one per existing daemon RPC, scoped to a Chat like the rest of the client:

- `browser_list(chat)`, `browser_attach(chat, browser)`, `browser_detach(chat, browser)` → `BrowserList`.
- `browser_open(chat, target)` → `{viewer, target}`; `browser_status(viewer)`; `browser_control(viewer, take_over)`;
  `browser_close(viewer)`.
- `browser_frame(viewer, after)` → `Option<{sequence, jpeg: Vec<u8>, viewport, generation}>`, with the base64 decoded
  in the client.
- `browser_input(viewer, sequence, generation, event)` → `accepted`, with the event kinds of `shared/browser.ts`.
- `browser_sign_ins()`, `browser_sign_ins_clear(computer)`; `browser_comments_add/list`.
- A typed notification for `browser-panel:open` (the agent asked to show a page), so GPUI can open the tab.

Daemon changes behind them:

1. **A panel browser the daemon owns.** Today panel pages exist only inside Electron. The daemon launches a headless
   Chromium per computer profile (this Mac's, and one per paired computer with `--proxy-server` at its SOCKS proxy),
   on demand, and registers its pages as `source: "panel"` exactly as `browser:panel-pages` registers cdp-proxy's.
   Keep it unreachable by other local processes: `--remote-debugging-pipe` (as the spike) or a token-prefixed proxy
   like cdp-proxy. Then `browser_open` opens a target there itself instead of asking a renderer.
2. **Page lifecycle for the panel:** `browser:open-page(chat, url)` (exists, but goes through the desktop today),
   `browser:close-page(target)`, and a list notification so tabs follow pages the agent opens or closes.
3. **Viewport scale.** `viewport` input gains `scale`; the daemon emulates that device scale and raises the
   screencast cap to the viewer's device pixels (the browser launched with `--force-device-scale-factor=2`: screencast
   frames follow the browser's own scale, not the emulated one, as the spike found). Without it, text is blurry.
4. **Frames without the poll and base64**, when there is time: a frame notification on the socket (binary or at least
   not re-encoded), so each frame does not wait for a round trip. The long poll works; this saves 33% of the bytes.
5. **The rest of a browser's chrome over the viewer:** status gains `cursor`; events for dialogs, file choosers and
   new windows; input gains `ime` (composition) and `drag`. Clearing sign-ins becomes `Storage.clearCookies` and
   storage on that profile's browser.
6. Electron partitions' sign-ins do not move to the new profiles; people sign in again once.
