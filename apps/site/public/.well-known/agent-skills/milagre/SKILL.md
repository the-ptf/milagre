---
name: milagre
description: Install Milagre and run Claude Code, Codex, Antigravity or Kiro agents in parallel Chats, each in its own Git worktree, then answer them from an iPhone or Android phone. Use when someone asks how to get Milagre, what it needs, or how to pair the phone app.
---

# Milagre

Milagre is a free, open-source (MIT) desktop app for macOS and Linux. It runs coding agents on your computer, one Chat per Git worktree, so several changes move at once without mixing files. When an agent needs an approval or an answer, it shows up on the desktop and in the Milagre phone app.

## What it needs

- A computer running macOS (Apple silicon or Intel) or Linux. Windows is in progress.
- At least one coding agent installed and signed in on that computer: Claude Code, Codex, Antigravity or Kiro. Milagre uses that agent's own login and subscription; there is no Milagre account.
- For the phone app: an iPhone (TestFlight beta) or an Android phone (APK beta).

## Install

| Platform             | Download                                      |
| -------------------- | --------------------------------------------- |
| macOS, Apple silicon | https://milagre.cloud/download/mac-arm64      |
| macOS, Intel         | https://milagre.cloud/download/mac-x64        |
| Linux AppImage       | https://milagre.cloud/download/linux-appimage |
| Linux .deb           | https://milagre.cloud/download/linux-deb      |
| Linux .rpm           | https://milagre.cloud/download/linux-rpm      |
| iPhone beta          | https://testflight.apple.com/join/K9ExV7bV    |
| Android beta         | https://milagre.cloud/download/android        |

Each `/download/...` link redirects to the matching file of the latest GitHub release.

## Pair the phone

1. On the computer, open Milagre's Settings › Devices and turn it on. A QR code appears.
2. Scan it with the Milagre phone app.

On the same network the phone talks to the computer directly. Away from it, the two connect through Milagre's relay, and Chat content and files are encrypted between the devices. The computer runs the agents, so it has to stay awake, online and running Milagre.

## More

- Source, issues and releases: https://github.com/the-ptf/milagre-ade
- Site: https://milagre.cloud
