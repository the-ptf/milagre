# Milagre

Your coding agents keep working. Answer them from anywhere.

![Milagre on desktop and iPhone, with mock Chats based on recent work](https://raw.githubusercontent.com/the-ptf/milagre-ade/c7a950a3d4c89adab90fca43117f8865aa1343b7/readme/desktop-and-mobile.png)

[Website](https://milagre.dev) · [Download](https://github.com/the-ptf/milagre-ade/releases/latest) · [CLI docs](https://milagre.dev/docs/cli) · [Phone setup](docs/mobile-local.md) · [Contributing](CONTRIBUTING.md)

Milagre is a free, open-source desktop app that runs Claude Code, Codex, Kiro and Antigravity on your own computer, each Chat in its own Git Worktree. When an agent needs an approval or an answer, it shows up on your desktop and in the Milagre app on your phone. Your computer runs the agents and keeps their state; there is no Milagre account or hosted inference.

## What you get

- **Parallel work without collisions.** Projects hold your Chats, and each Chat gets its own Worktree, so several changes run at once. Pull request status, checks and review sit beside each Chat.
- **Every agent you already pay for.** Pick a provider and model per Chat, keep history across restarts, queue a follow-up while the agent works, and open any tool call for its output or diff.
- **You stay in control.** Answer questions and approve commands in the Chat. Choose Ask, Auto or Full permissions per Chat, and undo to a checkpoint.
- **Agents that work together.** Link Projects on the canvas: an agent reads the other side, delegates a change to its agent, or negotiates an API contract before either one builds it.
- **Designs in the app.** Agents show screens on a Designs canvas. Compare variants, pin comments on the spot to change, and send them back.
- **Your phone, paired once.** Follow running agents, reply, approve, attach files and review changes from iPhone or Android. Same network: direct. Away: an encrypted relay.

## Install

| Where                        | How                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon, Intel) | [DMG from the latest release](https://github.com/the-ptf/milagre-ade/releases/latest), or `brew install --cask the-ptf/tap/milagre` |
| Linux x64                    | AppImage, DEB or RPM from the [latest release](https://github.com/the-ptf/milagre-ade/releases/latest)                              |
| Windows x64                  | Unsigned installer on the [beta releases](https://github.com/the-ptf/milagre-ade/releases); signed stable release pending           |
| iPhone                       | [TestFlight beta](https://testflight.apple.com/join/K9ExV7bV)                                                                       |
| Android                      | [APK beta](https://milagre.dev/download/android)                                                                                    |
| Any computer, no UI          | `npx milagre serve` (see [the CLI](#run-it-without-the-desktop))                                                                    |

Then sign in to at least one agent on the same computer:

| Agent       | Minimum version      | Sign in             |
| ----------- | -------------------- | ------------------- |
| Claude Code | 2.1.288              | `claude auth login` |
| Codex CLI   | 0.160.0              | `codex login`       |
| Kiro CLI    | 2.34.2               | `kiro-cli login`    |
| Antigravity | installed by Milagre | Settings › Accounts |

Milagre reads your login shell's environment, so agents find `node`, `git`, `gh` and your other tools even when you open the app from Finder.

> Milagre is alpha software. Use Full permission mode only in a Project you can recover.

To pair a phone, open desktop Settings › Devices and scan the code with the app; see [mobile setup](docs/mobile-local.md). The computer must stay awake, online and running Milagre for the phone to reach its agents.

## Run it without the desktop

The `milagre` CLI runs the same host on a server or a spare Mac, with pairing and device approval in the terminal. It needs Node.js 24+ and a signed-in agent CLI on that computer.

```sh
npx milagre serve --project /absolute/path/to/project
milagre devices pending
milagre devices allow KEY
```

Every operation the app uses is also a command (`milagre project registry`, `milagre chat send`, `milagre watch`), and `milagre mcp serve --stdio` connects MCP clients. Read the [CLI docs](https://milagre.dev/docs/cli) for the full reference.

## Develop locally

Requires macOS or Windows with Node.js 24 or newer and npm. Development and CI use Node.js 26 LTS; the packaged app uses its bundled Electron runtime. See [developing on Windows](docs/development.md#developing-on-windows).

```sh
npm ci
npm run dev          # Vite on http://127.0.0.1:5180 and Electron
```

```sh
npm run typecheck
npm run lint
npm test -- --unit
```

Try the phone app without a provider account with `npm run mobile:demo`: an isolated temporary Project and a deterministic demo agent. See [simulator instructions](docs/mobile-local.md) and [development, packaging and releases](docs/development.md).

## Docs

| Guide                                               | Covers                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [CLI docs](https://milagre.dev/docs/cli)            | Headless servers, pairing, scripting, MCP clients and every command                          |
| [Desktop guide](docs/desktop-guide.md)              | Attachments, file mentions, notifications, Project images, slash skills and permission modes |
| [Mobile setup](docs/mobile-local.md)                | Pairing, simulators, remote access and phone notifications                                   |
| [Local daemon](docs/local-daemon.md)                | The shared desktop/mobile host, ownership and recovery                                       |
| [Local MCP](docs/local-mcp.md)                      | Connecting outside MCP clients to Milagre                                                    |
| [Development and releases](docs/development.md)     | Checks, packaging, automatic updates and signed releases                                     |
| [Desktop distribution](docs/agents/distribution.md) | Installers per platform, signing and publishing                                              |
| [Domain glossary](GLOSSARY.md)                      | Projects, Worktrees, Chats, Links, Delegation and Negotiation                                |

Unfinished audit work is in [maintenance follow-ups](docs/maintenance.md). Feature requests live in [GitHub Issues](https://github.com/the-ptf/milagre-ade/issues).

## Repository

```text
apps/desktop/       React renderer and Electron host
apps/mobile/        Expo app for iPhone and Android
apps/daemon/        Local Node host, mobile bridge and the milagre CLI
apps/relay/         Cloudflare relay for phones and computers
apps/site/          milagre.dev, including /docs
apps/design-share/  Public pages for shared Designs and Artifacts
packages/core/      Agent runtime, providers, persistence and Worktrees
packages/shared/    Models, Chat operations and state reducers
scripts/            Development, integration checks and releases
docs/               Product and engineering documentation
```

npm workspaces with one root lockfile. The desktop, phone and CLI connect to one local daemon per computer; agent commands run there. Coordination state lives in `.milagre/coordination.json` in each Project.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security issues through [SECURITY.md](SECURITY.md).

Released under the [MIT License](LICENSE).
