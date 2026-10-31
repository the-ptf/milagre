# Milagre: your agents keep working. Answer them from anywhere.

Milagre is a free, open-source (MIT) app for macOS and Linux that runs Claude Code, Codex, Antigravity and Kiro coding agents on your computer, each Chat in its own Git worktree. When an agent needs an approval or an answer, it shows up on your desktop and in the Milagre app for iPhone and Android.

## Bring your own subscription

Milagre uses the coding agents you already have, signed in with your own account: Claude Code (Anthropic), Codex (OpenAI), Antigravity (Google) and Kiro (AWS). Milagre is free and open source; your provider's subscription or usage charges still apply. Want another agent? Milagre is open source: send a pull request at https://github.com/the-ptf/milagre-ade/pulls.

## Design in the app

Agents can show designs right in the Chat. Compare them side by side on a canvas, pin comments on the exact spot to change, choose one, and send it all back to the agent.

## Link your Projects

Link Projects on a canvas so their agents share context. An agent can read the other side and ask its agent to make a change, so a frontend and an API can agree on a contract before either one builds it.

## The agent needs you. Your desk doesn't.

The same Chats follow you to iPhone and Android: answer a question, approve a command or send the next prompt from your phone. Your computer runs the agents, so it needs to stay awake, online and running Milagre.

- iPhone beta (TestFlight): https://testflight.apple.com/join/K9ExV7bV
- Android beta (APK): https://milagre.cloud/download/android

## Questions

**What do I need installed?** Milagre and at least one coding agent you are signed in to: Claude Code, Codex, Antigravity or Kiro. Milagre uses that agent's login, so there is no Milagre account to create.

**How does my phone reach my computer?** Pair the phone app with your computer once. On the same network the two talk directly. Away from it they connect through Milagre's relay on Cloudflare, and Chat content and files are encrypted between your devices on the way.

**Where does my work live?** On your computer. Milagre stores Chat history and Project files there, and your agents send context to their model providers using your own account.

**Which computers does it run on?** macOS on Apple silicon and Intel, and Linux as an AppImage, .deb or .rpm. Windows is in progress. The phone app is in beta for iPhone and Android.

**Do I need the phone app?** No. Everything works on desktop. Pair the phone when you want to follow your agents and reply away from your desk.

## Download

- macOS, Apple silicon: https://milagre.cloud/download/mac-arm64
- macOS, Intel: https://milagre.cloud/download/mac-x64
- Linux: https://milagre.cloud/download/linux-appimage (also .deb: https://milagre.cloud/download/linux-deb and .rpm: https://milagre.cloud/download/linux-rpm)

Source, issues and releases: https://github.com/the-ptf/milagre-ade
