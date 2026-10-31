# A remote Chat's Browser pages draw where they are viewed and reach the web from its computer

A Chat on another computer opens its Browser panel pages as webviews on the desktop the person is looking at, not in that computer's window. Every connection such a page makes is opened from the Chat's computer, so `localhost`, `127.0.0.1` and the computer's internal names resolve there, and a dev server bound to loopback only still works. This is Orca's model (#832). Streaming a page from the other computer's window made its size, quality and input depend on a window nobody was looking at.

**Network.** This Mac's host runs one SOCKS5 proxy per paired computer, on loopback, started the first time a page needs it. Each connection becomes a byte stream on the computer link (`peer-streams.cjs`), and the computer dials the target. The page's session uses that proxy with the `<-loopback>` bypass rule, so loopback goes to the proxy too. A session is never attached until its proxy is set: a page can't fall back to this Mac's network without a word. A computer that can't connect answers with the SOCKS reason, and the page says that its computer couldn't reach the address. Chromium's SOCKS5 has no authentication, so a random loopback port is what keeps the proxy to this Mac. A remote Chat's Ports and reply links open in the panel at the address the Chat wrote (`localhost:4317`), even where the link shows the computer's LAN address.

**Routes.** The same on LAN, Tailscale and the relay, with no cap on relay traffic. Checked on all three with two copies of the app on one Mac.

**Sessions.** One session per Chat (`persist:milagre-browser-chat-<hash of the Chat key>`), so a sign-in stays with its Chat. Shared sign-ins between a computer's Chats are a later, opt-in decision.

**Ownership.** The page belongs to the Chat's host, as every other Chat page does (ADR-0006), but it lives on the desktop that draws it. That desktop registers it with the Chat's host (`browser:panel-pages`, over the computer link, `via: "peer"`). The host reaches it through a stream back over the same link to the desktop's DevTools proxy (`cdp-proxy.cjs`): the host opens a loopback forwarder per desktop (`panel-forwarders.cjs`), and the desktop accepts reverse streams only to that proxy's port on 127.0.0.1. Opening the page in the panel is the ownership evidence, like process lineage is for agent browsers; the desktop disconnecting takes its pages away. So the agent's `browser_*` tools, the phone's viewer and comments from the page all act on the one page the person sees, never on a copy. When several desktops hold pages for a Chat, tools act on the panel page registered most recently. When none is connected, the Chat has no panel page and the agent opens its own.

**Duplicates.** When this Mac has its own tab at an address, the streamed copy of the same address from the computer's own panel is hidden.

**Reload.** `Page.reload` sent through a webview's debugger reloads the window that holds it, Milagre's own. The desktop answers it by reloading the guest itself; it never reaches the guest's debugger. This holds for every Browser panel page, local Chats included.

**Compatibility.** The link offers `peer-tcp-v1` and `peer-panel-pages-v1` to paired desktops only; phone connections never get them. A host without them is never sent pages, and its Chats' pages keep streaming from its own window as before. Agent-started and attached browsers keep streaming; this record covers Browser panel pages only.

Considered and rejected:

- **Stream the computer's own webview** (T3 Code's model, and ours before #832): quality, size and occlusion depend on a window on the other computer.
- **Point the webview at the computer's IP** (Paseo's model): fails over the relay and for servers bound to loopback, unless the person runs their own proxy and DNS.
