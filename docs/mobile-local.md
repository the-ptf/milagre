# Phone setup and local mobile development

This preview connects an Expo mobile app to the Node daemon on your Mac. It groups Chats by Worktree, creates Worktrees, shows transcripts and live text, sends text, photos and files, stops or continues a turn, and answers approvals and questions. It also supports model, effort, fast-mode and permission settings, Chat rename/archive/restore, and read-only changes and file diffs. The daemon owns the state and keeps running when the app disconnects.

## Pair with your Mac

1. In the desktop app, open **Settings > Devices** and turn on **Allow devices to connect**.
2. In the installed phone app, add a computer and scan the pairing code.
3. Open a Project from the sidebar to follow its Chats, or create a new Chat.

Your Mac runs the agents and must stay awake and online. Desktop and phone share the same daemon, Chats and Worktrees. Automatic pairing tries the addresses in the link in order: LAN, then Tailscale, then the public encrypted relay at `relay.milagre.cloud`. No Cloudflare account or tunnel is needed. A configured named Cloudflare tunnel remains supported.

For private access, join both devices to the same LAN or Tailscale tailnet and leave **Allow on local network** on. In desktop Settings > Devices > Pair a device, choose **LAN or Tailscale only**, then scan the QR code or copy the link to another Mac. The receiving desktop and phone also offer **LAN or Tailscale only** when adding a computer. Private pairing uses the pinned encryption key and the same ten-minute pairing window; a new desktop still needs the owner's Allow. Its saved link has no public relay fallback.

Tailscale must already be installed and connected on both devices. Milagre uses its existing network interface; it does not install Tailscale or change the user's tailnet. Older pairing codes keep working; create a new code to include private addresses before the first connection.

Repository-provided Worktree setup commands pause for review on desktop or phone, even with Full permissions. **Run once**, **Trust this version** and **Skip setup** have the same [scope and behavior on both clients](desktop-guide.md#permission-modes). Reconnecting the phone restores a pending review.

For the Ultracode announcer, enable **Settings > Experimental > Ultracode Fatality**, then turn on **Ultracode** in a Chat's model sheet. The phone plays the same clip as desktop at the same volume. It respects the phone's silent switch and stops when the overlay closes.

The pairing code grants access to your agents. Keep it private. New phones can pair for 10 minutes after the code is shown; existing paired phones continue to work. **Reset access** forgets paired phones and creates a new token.

## View a running simulator or emulator

1. Start an iOS simulator in Xcode or an Android emulator on an Apple silicon Mac. For Android, install Android SDK Platform Tools; Milagre finds `adb` through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the standard macOS SDK directory, or `PATH`.
2. Open a Chat on desktop or the paired phone and select the phone-icon **Simulators** pill beside Subagents.
3. Choose a device if more than one is running. Tap or drag its live screen; use the **Home** and **Rotate** icons and the device's onscreen keyboard. Android also has **Back**.

The list is machine-wide, labeled **On this Mac**. Opening the viewer starts capture; closing it stops capture without shutting down the simulator. One viewer controls each device. **Take control** transfers control from another viewer. Hiding the app closes the stream; returning reopens it. Dropped connections retry automatically up to five times with increasing delays. **Retry** starts another attempt.

This version supports iOS simulators and Android emulators hosted on Apple silicon Macs. Physical Android devices are excluded. It uses the existing mobile WebView and requires no new mobile runtime. Hardware keyboard injection remains outside this version. The controls follow the app theme, including changes while viewing. If the picture updates but controls do not respond, More offers an explicit input reset with confirmation before it closes the simulator's apps. Xcode can report successful input delivery while the guest ignores it, especially around startup; Milagre does not restart devices automatically. Android capture can also fail when ADB stalls after a saved emulator snapshot; retry, or cold-boot that emulator manually if it persists.

Current hosts relay simulator frames over the existing authenticated phone connection, including its encrypted public relay. iOS uses the helper's MJPEG capture; Android uses bounded, shared snapshots at a lower frame rate. Detailed Android PNGs over 2 MiB are resized and encoded as JPEG on the Mac before relaying. Failed capture channels are replaced on reconnect even when another viewer still holds the old channel. Slow links skip old frames instead of building a replay queue. Closing a viewer stops its frame requests and closing the last viewer stops capture. The private helper address and token never reach clients.

The captured display owns its hardware cutouts. The viewer adds the outside bezel but never paints a second Dynamic Island, notch or camera over the image. Model names and rotation cannot move or reshape a cutout in the stream. Desktop and mobile use the same renderer and grouped control rail; More expands additional controls inline without covering the captured display.

On iOS, the Device Hub input-mode flag is a diagnostic hint rather than confirmation that touches are blocked. The viewer stays Live and offers **Reset input** if touches stop responding. Resetting requires confirmation because it restarts the simulator's home screen and closes its apps. Older hosts' `inputBlocked` hint is treated the same way.

For iPhone Duo, hosts whose helper reports hinge support expose **Closed**, **Book** and **Open** in one group and **Laptop** and **Tent** in another. More offers a custom hinge angle from 0 to 180 degrees. Desktop and mobile share these controls. Only the current controller can change the pose. A helper acknowledgement alone does not mean the panel has changed: input stays disabled until native observation, panel geometry and fresh captured pixels agree. A change that fails or cannot settle reconnects with fresh input ownership. The viewer follows the helper's active framebuffer rather than drawing a simulated fold. Running the Duo device requires Xcode 27.1 and the iOS 27.1 runtime. The bundled host helper is pinned to Expo Device Hub 0.18.0, which fixes Tent dispatch on that runtime. Older hosts and ordinary simulators keep their existing controls.

Older hosts still use direct WebRTC video. For that compatibility path, remote connections may need a TURN service configured with `MILAGRE_SIMULATOR_TURN_URLS` (comma-separated `turn:` or `turns:` URLs), `MILAGRE_SIMULATOR_TURN_USERNAME`, and `MILAGRE_SIMULATOR_TURN_CREDENTIAL`. Use issued, time-limited client credentials, not the service's administrative key. TURN is not needed by the relayed frame path. Physical-phone and separate-network verification remain release gates.

## Lease a device from Simlock (Experimental)

[Simlock](https://github.com/callstackincubator/simlock) leases one simulator or emulator per agent from a worker on your Mac or a gateway in front of several machines. Milagre doesn't install or run it. The integration follows T3 Code's Simlock host and needs simlock 0.4.0 or later with `capabilities.stream.enabled` and `capabilities.input.enabled` on the worker (and on the gateway, if there is one).

1. In **Settings › Experimental**, turn on **Simlock devices**. Leave **Gateway** empty to use a worker on this Mac: Milagre reads its address and agent token from `~/.simlock/agent-device-profile.json`, or from `AGENT_DEVICE_DAEMON_BASE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`. For a gateway, enter its origin and an agent token from `simlock --gateway token create --role agent`, then **Save and check**.
2. New Chats get `simulator_lease`, `simulator_lease_models` and `simulator_release`. A lease is opened through Milagre's pinned agent-device (`connect proxy`, then `open`), attached to the Chat, and handed to the agent as a launcher bound to that session. Installs are accepted only from the Chat's folder.
3. Watch it from the **Simulators** pill on desktop or phone. **Attach simulator** also lists the pool's models to lease by hand, and the device's ✕ returns it to the pool, wiped.

The host renews each lease every two minutes with a ten-minute TTL and ends it at **Return a device after**; a lease Milagre stops renewing (a crash, a quit or a host restart) ends on its own one TTL later and leaves its Chat. Returning a frozen device waits at most 20 seconds for agent-device before Milagre ends the lease over HTTP. **Devices at once** caps leases per Mac; Simlock separately caps leases per token (`lease.maxPerRequester`). The token stays in a private file in the host's data folder and goes only to its gateway; clients never receive it. Video is the lease's H.264 stream relayed as serve-sim envelopes and decoded with WebCodecs in the viewer, so it needs Electron or iOS 17+ WebKit. Hinge controls and input repair are not offered for Simlock devices. Milagre doesn't boot, slim or verify leased devices: slimming is the worker's `ios.defaultMode`, and simlock 0.4.0's slim step fails on the iOS 27.0 runtime, so those leases run full.

## View the agent's browser

1. Have the Chat's agent open a Chromium browser with a DevTools port, for example `--remote-debugging-port=0`, or tools such as chrome-devtools-mcp or agent-browser configured with one.
2. Select the **Browser** pill left of Simulators. A single page opens directly; with several, choose one by its title and URL.
3. Tap or click the page, swipe or scroll it, and use **Back**, **Forward**, **Reload** and **Keyboard**. Holding still for a moment before moving drags instead of scrolling.

The pill appears once this Chat has a page: one of a browser its agent started, or of a browser attached to the Chat by the agent (`browser_attach`) or by you. Another browser on the computer appears under **Other browsers on this computer** and joins the Chat only after **Attach**; **Detach** removes it again and leaves it running. Opening a page starts its capture; closing the viewer stops the capture and leaves the page and browser open. One viewer controls a page at a time; **Take control** moves control, but the agent can still act on the page. Frames travel over the existing phone connection, so no TURN service is needed. See [the design notes](research/remote-browser-control.md) for supported browsers and limits.

## Try the demo

From the repository root:

```sh
npm ci
npm run mobile:demo
```

Press **Shift+i** in that terminal and select **Milagre Local** (or your chosen iOS simulator). Expo installs its matching Expo Go app if needed. On Expo Go's first launch, dismiss its developer-menu tutorial.

1. Tap **Connect to computer**. The temporary demo connection is filled in.
2. Open **Mobile playground**, then **Hello from your Mac**.
3. Send a message. The labeled demo agent replies through the real core, socket and HTTP bridge.
4. Send `approval`, `question`, or `slow` to try approval controls, answers or Stop. Disconnect and reconnect to see saved messages and pending requests.
5. Press **Ctrl+C** in the demo terminal to stop Metro, the bridge and the demo daemon. The command prints the temporary Project location; its saved Chat remains there for inspection. A later demo run creates a fresh Project.

The demo is deterministic and uses no provider account. It never opens your development repository. Do not mistake its replies for model-generated output.

## Use an installed provider

The persistent host starts the real providers installed and logged in on your Mac:

```sh
npm run mobile:host -- --project /absolute/path/to/a/Project --stay-awake
```

Omit `--project` to choose a Project in the app. The separate profile defaults to `~/.milagre-mobile`; use `--data-dir /absolute/profile` to choose another. The command prints the private connection-file path, then a QR code and the same pairing link. In the app, choose the scan option and point the camera at the QR code; the app fills in the address, token and computer name. Pass `--no-qr` to print only the link. The QR code and link contain the token, so do not share or screenshot them. To pair by hand instead, enter the address and the token from the connection file. Leave **Remember this computer** selected to save the connection in platform secure storage. **Forget this computer** removes the saved connection. Tokens remain stable across host restarts; to rotate one, stop the host, remove its `mobile-connection.json`, restart and connect again.

Ctrl+C stops the host cleanly. On macOS, `--stay-awake` keeps the computer awake while the host runs; it does not keep a closed laptop lid awake. The separate daemon/bridge commands below remain available.

### Share the desktop's Chats

The current desktop starts or attaches to the persistent daemon using its Electron userData profile. The mobile bridge can attach to that same daemon, so both clients see the same saved Chats and provider sessions. First launch the current desktop, then use its actual profile path below. The path can differ between development, packaged and explicitly configured launches; the host's `daemon:status` response identifies it. Do not point `mobile:host` at an already owned desktop profile: that command starts its own daemon.

```sh
# Replace this with the profile used by the running current desktop.
MILAGRE_DESKTOP_PROFILE="/absolute/path/to/desktop/userData"
npm run daemon -- status --data-dir "$MILAGRE_DESKTOP_PROFILE"

# Attach only the HTTP bridge. The connection file must not exist yet.
npm run daemon -- bridge --data-dir "$MILAGRE_DESKTOP_PROFILE" --connection-file /tmp/milagre-desktop-mobile-connection.json
```

In another terminal, run `npm run mobile`, choose the simulator with Shift+i, and enter `http://127.0.0.1:8787` plus the token from that connection file. Open the same absolute Project path as desktop. Closing desktop leaves its daemon running; Ctrl+C in the bridge terminal disconnects mobile without stopping the daemon. If the daemon stops or an update restarts it, restart the bridge and pair using a new connection file.

This attaches clients without copying or migrating state. A desktop from before the shared-daemon change still owns an embedded runtime: close that older app cleanly before launching the current build with its existing profile. No command here replaces a running app or steals its locks. See [daemon recovery](local-daemon.md) if ownership fails.

### Separate daemon and bridge processes

For an isolated trial, close the chosen Project in other Milagre hosts first, or use a temporary Project. The separate daemon has its own profile and cannot open a Project already owned by desktop.

Run each command in a separate terminal, from this repository root:

```sh
# Terminal 1: use a separate profile, not desktop userData.
npm run daemon -- serve --data-dir /tmp/milagre-local-profile

# Terminal 2: connection-file must be a new file.
npm run daemon -- bridge --data-dir /tmp/milagre-local-profile --connection-file /tmp/milagre-local-connection.json

# Terminal 3: start the mobile app without demo defaults.
npm run mobile
```

Press Shift+i and choose your simulator. Enter `http://127.0.0.1:8787` and the token from `/tmp/milagre-local-connection.json`. Open an absolute Git Project folder on your Mac. Start a Chat with your installed, logged-in Codex or Claude provider; the model menu uses the provider's reported models and capabilities. Permissions default to **Ask approval**.

Stop Metro and the bridge with Ctrl+C. Stop the daemon cleanly with:

```sh
npm run daemon -- stop --data-dir /tmp/milagre-local-profile
```

The connection token is regenerated on each bridge launch. Use a new connection-file path or remove the old file after its bridge has stopped. With Remember this computer selected, the mobile app keeps the token in platform secure storage. Turn it off for a connection held only in memory. Failed sends retain the draft and are never automatically retried; check the Chat after reconnecting before sending again.

## Connect from any network (Cloudflare)

A named Cloudflare tunnel gives the Mac a fixed HTTPS address, and Cloudflare Access drops every request that lacks the phone's service token before it reaches the Mac. The bridge still checks its own token on top.

One-time setup, with a domain whose DNS is on Cloudflare and Zero Trust enabled on the account (the Free plan is enough):

1. Create an API token (My Profile → API Tokens → Custom token) with Account → Cloudflare Tunnel: Edit, Access: Apps and Policies: Edit, Access: Service Tokens: Edit, and Zone → DNS: Edit for that domain.
2. Run `CLOUDFLARE_API_TOKEN=... npm run mobile:cloudflare -- --domain example.com`. It creates `mac.example.com`, the tunnel pointing at `127.0.0.1:8797`, the Access app and its service token, and saves them to `~/.milagre-mobile/cloudflare.json` (0600). Running it again reuses everything; `--name` picks another subdomain for a second Mac.

Then start the host with `npm run mobile:host -- --cloudflare --desktop` and scan the QR code. `--desktop` shares the Milagre app's daemon, so the phone lists the app's recent Projects and its running Chats; without it the host runs its own profile in `--data-dir`. Use `--desktop` only with a Milagre app new enough to run the daemon, never next to an older build that runs Projects in its own process. The pairing link carries the Access service token, which the app keeps in secure storage with the bridge token. Anyone holding the QR code can reach the Mac, so treat it like a password. To revoke every paired phone, delete the service token in Zero Trust → Access → Service credentials and run `mobile:cloudflare` again.

**From the app.** Settings › Devices runs the same bridge inside the daemon, so no `mobile:host` is needed: turn on "Allow devices to connect" and scan the QR code. If `cloudflare.json` exists in the app's data directory (`mobile:cloudflare --data-dir <userData>`), the daemon also runs the named tunnel; otherwise the daemon reaches the phone through the public relay (`relay.milagre.cloud`) and the QR carries the relay address, this Mac's id and public key. New phones can pair for 10 minutes after the QR is shown (Settings shows the countdown and offers "Allow pairing again"); a phone that already paired is not affected. The bridge itself still listens on `127.0.0.1:8797` only. "Reset access" makes a new token and forgets every relay phone, so paired phones scan again. The setting lives in `mobile.json` in the data directory and survives restarts; the commands `phone:status`, `phone:set-enabled`, `phone:reset` and `phone:open-pairing` are not available through the bridge itself. Settings › Devices also lists each phone that paired through the relay or the local network, with its name and when it was last seen, and removes one; a removed phone can pair again only once the code is shown again. `devices:list` and `devices:remove` are not available through the bridge either.

`npm run mobile:host -- --tunnel` opens a temporary Cloudflare Quick Tunnel instead: no account, a random `trycloudflare.com` address that changes on every start, and no Access in front.

For a named Cloudflare tunnel, TLS ends at Cloudflare's edge and Cloudflare can see the traffic. The default public relay forwards encrypted frames and cannot read Chat traffic.

Webhook Routines are the exception: their payloads are not end-to-end encrypted. A webhook Routine's URL (`https://relay.milagre.cloud/hook/<secret>`) is public so services such as Sentry can POST to it. The relay stores each delivery (body, headers and query, up to 256 KiB) before it answers 202, forwards it over the Mac's relay connection, and deletes it once the Mac acknowledges it. A Mac that is offline gets the delivery when it reconnects; the relay holds it for up to 24 hours, then deletes it unread. The relay never sees the optional signing secret: the Mac checks signatures. On the Mac, a payload waits in `routine-hooks.json` (readable only by you) until its Run's first message is sent, and goes at once when its Routine is gone, its signature doesn't match, or it is a repeat of one already handled. One whose Run fails goes too; anything left over is deleted after 48 hours. While any webhook Routine is on, the daemon keeps its relay connection open even with phone access off. Rotating the URL in the Routines form stops the old one at once. After Reset access, the Mac keeps the old relay identity only to collect the webhook deliveries the relay still holds for it, whether phone access is on or off, and drops it once that room is empty or after 25 hours.

## Connect through your own HTTPS endpoint

Use an HTTPS endpoint from your own reverse proxy, VPN or configured tunnel. It must forward to the loopback bridge and rewrite the Host header to that bridge's address. For an already configured ngrok account:

```sh
ngrok http http://127.0.0.1:8787 --host-header=rewrite --inspect=false
```

Enter the HTTPS endpoint and the host's connection token in the app. `--public-url https://your-endpoint` makes `mobile:host` write that address into its connection file. The token is still required for every request. Browser Origins are rejected. Remote plaintext HTTP and redirected endpoints are rejected by the client; use the endpoint's direct HTTPS origin.

TLS terminates at the proxy or tunnel provider, which can see traffic. This is not Paseo's encrypted relay. Keep HTTP request inspection off so connection tokens and Chat content are not recorded there. No remote endpoint starts automatically. Stop a test tunnel with Ctrl+C. Physical devices also need an installed build or access to the development bundler; the standalone simulator build does not need Metro.

### Temporary HTTPS test without an account

A [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) can test the same path using only a temporary Project:

```sh
cloudflared tunnel --url http://127.0.0.1:8787 --http-host-header 127.0.0.1:8787 --loglevel info --no-autoupdate
```

Use the printed HTTPS origin in the app. Keep logging at info or higher; debug logging can include request headers. The random URL lasts only while that process runs. Stop it with Ctrl+C. The same TLS-provider trust boundary applies. For regular remote use, configure a stable private endpoint; the test does not install a background tunnel service.

## Standalone iOS simulator build

With Xcode 26.4 or newer and its simulator runtime installed:

```sh
cd apps/mobile
CI=1 npx expo prebuild --platform ios --clean
CI=1 npx expo run:ios --configuration Release --device generic --output /tmp/milagre-mobile-release --no-bundler
```

The clean prebuild regenerates only the ignored iOS project. Expo 58 generates the `SceneDelegate` that Xcode 27 builds need to launch on iOS 27, so app config no longer opts into it. Keep native configuration in app config so it survives regeneration.

This generates the ignored native project and produces `/tmp/milagre-mobile-release/MilagreLocal.app`. Install that app on the chosen iOS simulator and launch **Milagre Local**. Metro and Expo Go are not needed. Run `mobile:host`, enter its connection, and keep that host running. A physical-device build needs signing and a reachable HTTPS host; this simulator artifact cannot be installed on a phone.

## Boundaries

- The HTTP bridge binds only to `127.0.0.1`. Every request needs its token; browser Origins and unexpected Hosts are rejected. Only the mobile command allowlist is available. RPC bodies are capped at 1 MiB and concurrent requests at 16. File uploads use a separate authenticated 7 MiB envelope for at most 5 MiB of decoded content.
- A live WebSocket signals snapshot changes. While it is unavailable, foreground snapshots poll every second during activity and every four seconds while idle. PR status refreshes every 30 seconds on the focused, foreground screen with at most two requests in flight. Chat renders Markdown, expandable tool output, live activity, agent counts and PR blockers. The composer opens native model/effort/permission controls and Photo Library/Files pickers and **Paste image**. With the native image-paste module installed, copying a screenshot and choosing Paste in the message field attaches it without using the + menu. Text paste keeps its normal behavior. Up to four attachments fit per message; photos are resized to 1024 pixels and capped at 160 KiB each, files at 5 MiB each. Persisted and agent-generated images are fetched through the bridge (see Images below). Chat initially mounts its newest 40 messages. Scrolling up loads older history while keeping the same message in view; **Show earlier messages** remains available, with Retry when a read fails.
- Uploaded files stay in the host profile for Chat history. Failed sends preserve drafts. Completed file uploads are verified and reused on retry for the same Computer, Project, filename and bytes. Reconnecting or restarting the host also reuses matching content; a lost upload response may transfer the bytes again but creates no duplicate file. Missing or changed remote files upload afresh. An unknown message-delivery outcome is checked against its settled receipt, without automatically resending an unconfirmed message. New managed uploads unused for 30 days are removed during startup and daily cleanup; a file submitted to a Chat is retained permanently, including archived Chats. Legacy uploads, originals, symlinks, unexpected directory contents and unreadable records are left alone.
- Local simulator and direct HTTPS host access are supported. Optional mobile push notifications use Expo Push Service (see below). The default encrypted relay is implemented; desktop startup does not install a login service.
- iOS works in Expo Go and a standalone simulator Release build. Android uses the same client; its host address is `http://10.0.2.2:8787`. Android runtime behavior still needs emulator validation.
- Demo connection defaults are injected into a local development bundle. Never publish that bundle or use this mechanism for a real remote token. The real workflow enters the token in the app.

## Push notifications

On an installed phone build, open **Settings > Notifications > Enable notifications** and allow notifications. Open Settings with the gear button on Computers. Waiting alerts cover approvals and questions; finished alerts cover completed and failed turns. Each has its own toggle. Notifications register for remembered computers, and the daemon sends them even when the mobile app and desktop window are closed. The Mac must be awake, online and running the daemon. Tapping an alert reconnects to its saved computer and opens the current Chat state. Alerts for the Chat being viewed are suppressed; a 15-second focus lease expires after the phone stops reporting activity.

Expo Go and simulator push registration are unsupported. They can still use the rest of the app and adjust notification preferences. Push requires an installed native build configured for notifications. Native changes and new builds require approval under [the mobile release rules](../apps/mobile/AGENTS.md). The existing EAS project ID is used. Configure iOS APNs credentials with `npx eas-cli@latest credentials --platform ios` (or during EAS Build), and configure Android FCM v1 credentials plus the matching `google-services.json` in a private build environment. If configuring that file, set its path with `android.googleServicesFile` in the app config. Never commit private credentials. Build with the existing `testflight` profile for iOS; Android needs its own signed development or release build profile. See [Expo setup](https://docs.expo.dev/push-notifications/push-notifications-setup/) and [sending/receipts](https://docs.expo.dev/push-notifications/sending-notifications/).

Delivery is best effort. The daemon caps its outgoing queue at 256 notices and its pending receipt registry at 1000. Requests time out after 10 seconds; transient errors retry after 1 and 3 seconds. Expo tickets and receipts remove tokens reported as `DeviceNotRegistered`. The first receipt check runs after 15 minutes; missing receipts get two more checks. Alerts expire after 5 minutes. Logs report generic delivery/configuration failures without push tokens or notification content. If enhanced push security is enabled in the EAS dashboard, provide `EXPO_PUSH_ACCESS_TOKEN` in the daemon's launch environment (including the Electron-launched daemon), never in mobile app config.

Chat titles, previews and navigation identifiers pass through Expo and Apple or Google; push is not end-to-end encrypted. No bridge token or Cloudflare Access credentials are included in notification payloads. Registrations live in `mobile-push.json` in the daemon's profile, written atomically with mode 0600. Turning off desktop Phone access or resetting access clears registrations. Turning off mobile notifications or forgetting a computer unregisters that device. When that computer is offline, the app keeps a private unregister retry in secure storage, including the credentials needed for removal. Those credentials are deleted after the removal succeeds. The forgotten computer is immediately excluded from notification navigation. Reopen Milagre while the computer is online to finish removal; until then, it can still send alerts.

Simulator notification injection bypasses Expo/APNs transport. Live APNs/FCM delivery and Android runtime behavior require signed physical-device validation.

## Images

`GET /media?projectPath=<abs>&path=<abs>` streams an image file to the paired app through the same authenticated bridge (token, Host and Origin rules). It serves only png, jpeg, gif, webp and heic files (checked by extension and file header) up to 15 MiB, and only from inside the Project's Worktrees, the Project's `.milagre/images` folder, the host profile's `mobile-attachments` folder and the folders where agents save generated images. Paths are resolved through symlinks first. Anything else returns 403, a non-image returns 415 and a relative path returns 400.

## Development checks

```sh
npm run typecheck:mobile
npm run lint --workspace @milagre/mobile
npm test -- --workspace mobile
npm test -- --workspace daemon
npm run export:ios --workspace @milagre/mobile
```

`apps/mobile` uses Expo Router and the default Expo monorepo Metro configuration. `scripts/start-mobile.cjs` selects IPv4-first DNS for Metro because Expo advertises `127.0.0.1`, while Node can otherwise bind only `::1` for localhost on macOS. Desktop React and mobile React resolve independently; existing desktop dependency versions are retained. The native UI's scrolling and choice controls live in `apps/mobile/src/ui.tsx`.

### Opt-in real-provider check

```sh
node scripts/check-mobile-providers.cjs --run
```

This uses the installed Codex and Claude accounts for one short no-tool prompt each in an isolated temporary Project. It checks the full mobile HTTP/socket/core path, restarts the host and verifies the token, saved Chats, provider session IDs and replies. It is excluded from normal tests and CI because it consumes provider quota. The saved temporary Project path is printed for inspection.

### Android capture packaging

`npm run build` prepares the pinned scrcpy 4.0 server used by Expo Device Hub 0.18.0. It verifies SHA-256 `84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a` before packaging. The helper package and server remain outside ASAR so the installed app does not download into its signed bundle. A clean desktop build needs GitHub access once; later builds reuse the verified artifact. Run `node scripts/prepare-simulator-helper.cjs` before invoking electron-builder directly.

Android has a separate helper process per viewed device. Closing the last viewer for one emulator ends that capture without affecting another emulator or shutting either emulator down. Current viewers use the relayed snapshots described above. Older viewers use WebRTC; typed input and signaling still use the authenticated Milagre connection. For that legacy path, TURN credentials are passed privately to the helper environment and configured on its host, not accepted from viewer offers.
