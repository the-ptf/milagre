---
name: simulator
description: Attach or detach an iOS simulator or Android emulator to the current Milagre Chat so the user can view it on desktop or phone, or lease one of the Chat's own from a Simlock pool. Use when choosing a device for mobile app work or changing which device the Chat uses.
---

# Chat simulators

1. Call Milagre's `simulator_list`. `devices` contains running devices attached to this Chat, `attached` also includes stopped attachments, and `available` contains other running devices on this Mac.
2. Choose the exact device you will use. Call `simulator_attach` with its `deviceId` before interacting with it. The tool supplies the current Chat identity; do not pass a Chat id or edit association files.
3. Use your existing device automation tools with that same device id. Attaching makes the device available in this Chat's Simulators pill on desktop and phone. It does not boot, stream, install or launch an app.
4. Keep the device attached when finishing work so the user can inspect it. Call `simulator_detach` with its `deviceId` when the user asks to remove it or you replace it. Detach closes this Chat's viewers, preserves other Chats' attachments and leaves the device running.

If no suitable device is running, use the available iOS/Android setup tools, list again and attach the chosen device. Do not attach every discovered device or infer ownership from its name, a device listing, or the fact it is running. Never stop another Chat's device to clean up this Chat.

The same device may be explicitly attached to multiple Chats. Attachment is an association, not an exclusive control lease. Use the viewer's takeover controls for human control; external automation tools have their own control behavior.

## Simlock leases (when offered)

When the user turned on Simlock devices, you also have `simulator_lease`, `simulator_lease_models` and `simulator_release`. A lease is a device of this Chat's own: no other agent touches it, Simlock boots it and wipes it when it comes back. Whether it is slimmed depends on the worker's own slim mode (`ios.defaultMode`), which can fail on some iOS runtimes; Milagre doesn't slim or verify leased devices, and simslim can't reach them in Simlock's device set. Prefer it to sharing a running simulator when several agents test at once.

1. Call `simulator_lease` with `platform` (`ios` or `android`) and, if the task needs one, a `model` from `simulator_lease_models`. It can wait in Simlock's queue. The device is attached to this Chat for the user to watch.
2. Drive it only with the `launcher` the tool returns: the agent-device CLI already bound to the lease. Run `<launcher> --help` for its commands. simctl, adb, argent and Xcode cannot reach it, because it may run on another computer. Install apps only from the returned `installDirectory` or below, and point the app at addresses its machine can reach, not this Mac's localhost.
3. Call `simulator_release` with the `deviceId` when you are done, or when you replace it. The launcher refuses `close`; releasing is what returns it.

