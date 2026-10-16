# Phone setup and local mobile development

This preview connects an Expo mobile app to the Node daemon on your Mac. It groups Chats by Worktree, creates Worktrees, shows transcripts and live text, sends text, photos and files, stops or continues a turn, and answers approvals and questions. It also supports model, effort, fast-mode and permission settings, Chat rename/archive/restore, and read-only changes and file diffs. The daemon owns the state and keeps running when the app disconnects.

## Pair with your Mac

1. In the desktop app, open **Settings > Devices** and turn on **Allow devices to connect**.
2. In the installed phone app, add a computer and scan the pairing code.
3. Open a Project from the sidebar to follow its Chats, or create a new Chat.

Your Mac runs the agents and must stay awake and online. Desktop and phone share the same daemon, Chats and Worktrees. By default, the daemon uses the public encrypted relay at `relay.milagre.cloud`; no Cloudflare account or tunnel is needed. A configured named Cloudflare tunnel remains supported.

Repository-provided Worktree setup commands pause for review on desktop or phone, even with Full permissions. **Run once**, **Trust this version** and **Skip setup** have the same [scope and behavior on both clients](desktop-guide.md#permission-modes). Reconnecting the phone restores a pending review.

For the Ultracode announcer, enable **Settings > Experimental > Ultracode Fatality**, then turn on **Ultracode** in a Chat's model sheet. The phone plays the same clip as desktop at the same volume. It respects the phone's silent switch and stops when the overlay closes.

The pairing code grants access to your agents. Keep it private. New phones can pair for 10 minutes after the code is shown; existing paired phones continue to work. **Reset access** forgets paired phones and creates a new token.

## View a running simulator or emulator

1. Start an iOS simulator in Xcode or an Android emulator on an Apple silicon Mac. For Android, install Android SDK Platform Tools; Milagre finds `adb` through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the standard macOS SDK directory, or `PATH`.
2. Open a Chat on desktop or the paired phone and select the phone-icon **Simulators** pill beside Subagents.
3. Choose a device if more than one is running. Tap or drag its live screen; use the **Home** and **Rotate** icons and the device's onscreen keyboard. Android also has **Back**.

The list is machine-wide, labeled **On this Mac**. Opening the viewer starts capture; closing it stops capture without shutting down the simulator. One viewer controls each device. **Take control** transfers control from another viewer. Hiding the app closes the stream; use **Retry** after returning.

This version supports iOS simulators and Android emulators hosted on Apple silicon Macs. Physical Android devices are excluded. It uses the existing mobile WebView and requires no new mobile runtime. Hardware keyboard injection remains outside this version. The controls bar follows the app theme, including changes while viewing. If the picture updates but controls do not respond, restart that simulator in Xcode and reopen the viewer. Xcode can report successful input delivery while the guest ignores it, especially around startup; Milagre does not restart devices automatically. Android capture can also fail when ADB stalls after a saved emulator snapshot; retry, or cold-boot that emulator manually if it persists.

Video uses WebRTC directly between the Mac and viewer. The existing authenticated phone connection carries signaling and input. Connecting Chats through the public relay does not, by itself, relay video across restrictive networks. Local connections work without TURN; remote connections may need a TURN service.

For a configured TURN service, start the daemon with `MILAGRE_SIMULATOR_TURN_URLS` (comma-separated `turn:` or `turns:` URLs), `MILAGRE_SIMULATOR_TURN_USERNAME`, and `MILAGRE_SIMULATOR_TURN_CREDENTIAL`. Use issued, time-limited client credentials, not the service's administrative key. Milagre passes these credentials only to authenticated viewers and its private helper. Automatic TURN provisioning and credential renewal are not implemented. Physical-phone, cellular and forced-TURN verification remain release gates.

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
- Uploaded files stay in the host profile for Chat history. Failed sends preserve drafts; retrying may upload a file again. Abandoned-upload cleanup and upload reuse are pending.
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

`npm run build` prepares the pinned scrcpy 4.0 server used by Expo Device Hub 0.15.1. It verifies SHA-256 `84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a` before packaging. The helper package and server remain outside ASAR so the installed app does not download into its signed bundle. A clean desktop build needs GitHub access once; later builds reuse the verified artifact. Run `node scripts/prepare-simulator-helper.cjs` before invoking electron-builder directly.

Android has a separate helper process per viewed device. Closing the last viewer for one emulator ends that capture without affecting another emulator or shutting either emulator down. Video uses WebRTC; typed input and signaling use the existing authenticated Milagre connection. TURN credentials are passed privately to the helper environment and configured on its host, not accepted from viewer offers.
