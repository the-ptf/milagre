# Phone pairing and connectivity

1. On desktop, open Settings > Phone & sharing and enable Allow devices to connect.
2. In the installed phone app, add a computer and scan the pairing code.
3. Open a Project and its Chat. The computer runs agents; the phone follows the same saved and live work.

The computer must stay awake and online. The default encrypted public relay needs no Cloudflare account or tunnel. A configured named Cloudflare tunnel is also supported. Opening desktop alone does not install a login service, and closing the laptop lid can suspend access.

Pairing permits new phones for 10 minutes after the code is shown. Existing paired phones continue working after that window. Allow pairing again opens another window. Reset access forgets paired phones and creates new access; every phone must pair again. Use it only when authorized. Pairing codes, QR contents, tokens and links grant access and must stay private.

## Narrow diagnosis

Confirm desktop can open the affected Chat and Settings > Phone & sharing shows access enabled. If desktop works but the phone fails, inspect the selected computer and redacted connection error. Check whether pairing expired, the computer went offline/asleep, or a configured tunnel is unavailable. Confirm the phone selected the same computer/profile as desktop. Avoid restarting a healthy host while it has active agents.

A lost send acknowledgement does not prove failure. Reconnect and inspect messages before sending again; drafts remain when sending fails. Forget this computer removes the remembered phone connection. It does not stop the computer's host.

Development demo/build instructions are unnecessary for an installed phone app. Phones receive JS/TS updates over the existing runtime; a new native dependency or permission requires an approved new build. Do not start a build or publish an update during help diagnosis.
