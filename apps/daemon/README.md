# milagre

Run [Milagre](https://milagre.dev)'s coding agents on a computer without the desktop app. Keep agents working on a server or a spare Mac, pair your phone from a terminal, and script every Chat, Project and Worktree with the same operations the app uses.

```sh
npx milagre serve
```

**Full docs: [milagre.dev/docs/cli](https://milagre.dev/docs/cli)**

## Requirements

- Node.js 24 or newer, and Git.
- At least one coding agent CLI, installed and signed in on the same computer: Claude Code (`claude auth login`) or Codex (`codex login`). Milagre uses that login; there is no Milagre account.

## Install

```sh
npm install --global milagre
milagre --version
```

## Quick start

1. Start the server. It stays in the foreground and prints a pairing link, plus a QR code in an interactive terminal.

   ```sh
   milagre serve --project /absolute/path/to/project
   ```

2. Pair a device. On a phone, scan the QR from Milagre's pairing screen. On another desktop, open Settings › Devices › Add computer and paste the link.
3. Approve a desktop from a second terminal on the server:

   ```sh
   milagre devices pending
   milagre devices allow KEY
   ```

4. Check on it, and stop it when you're done. Stopping saves running work.

   ```sh
   milagre status
   milagre stop
   ```

Pairing links grant access to your agents: keep them private. They expire after 10 minutes; `milagre pair` opens a new window. Devices reach the server through Milagre's encrypted relay, so no public port is needed.

## Commands

| Command             | What it does                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `serve`             | Run the server and print pairing details. `--project PATH` (repeatable), `--no-pair`, `--no-qr`. |
| `pair`              | Open a new 10-minute pairing window.                                                             |
| `status` / `stop`   | Show the running server's status as JSON / save work and stop it.                                |
| `devices`           | `list`, `pending`, `allow KEY`, `deny KEY`, `remove KEY`.                                        |
| `computers`         | Pair with and call other Milagre computers, with credentials sealed by a private key file.       |
| `command`           | `list`, `describe NAME`, `run NAME`: discover and run the app's operations.                      |
| `request`           | Call a daemon method with a raw JSON argument array.                                             |
| `watch`             | Stream a snapshot, then live events, as newline-delimited JSON.                                  |
| `session`           | Keep one owner connection open for scripts (newline-delimited requests on stdin).                |
| `mcp serve --stdio` | Connect an MCP client to a scoped connection made in the desktop's MCP settings.                 |
| `desktop`           | Run native actions in a desktop app connected to the same profile.                               |
| `triage`            | Investigate a Milagre problem with Claude Code or Codex and help file an issue.                  |
| `help`              | `milagre help`, `milagre help COMMAND`, or `milagre COMMAND --help`.                             |

Global flags: `--data-dir PATH`, `--input JSON|@file|-`, `--chat CHAT`, `--json`, `--help`, `--version`.

## Profiles

The server keeps its Projects, Chats and paired devices in `~/.milagre/server`. Choose another with `--data-dir /absolute/path` or `MILAGRE_DATA_DIR`, and use the same profile for every command. The CLI profile is separate from the desktop app's; don't open the same Project in two hosts at once.

## Run it always on

`serve` installs no startup service. Run it from launchd, systemd or tmux with `--no-pair`, so restarts keep paired devices without printing links:

```sh
milagre serve --no-pair --project /srv/code/api
```

Ctrl+C or SIGTERM saves and stops it.

## Script the app

Every operation the desktop and phone use is a command. `project:registry` becomes `milagre project registry`:

```sh
milagre command list                       # what the running host offers
milagre help chat send                     # flags and types, works offline
milagre project open --folder /absolute/path/to/project
milagre watch --chat '/absolute/path/to/project#1'
```

Name a Chat with `--chat projectPath#id` to run the same commands its agent calls (`tasks_set`, `delegate`, `chat_start` and the rest), with that Chat's permissions:

```sh
milagre command run tasks_read --chat '/absolute/path/to/project#1'
```

Results print as JSON. With `--json`, errors do too, and any failure exits with status 1.

## Triage a problem

When the desktop app won't start:

```sh
npx milagre triage
```

It starts Claude Code or Codex (`--agent claude|codex`) with a triage playbook and your machine's facts, reads the logs and the source for your version, and can help write a GitHub issue. It asks before it changes anything or posts.

## From source

In the [repository](https://github.com/the-ptf/milagre-ade), `npm run cli -- serve` runs this command. `npm run package:cli` builds the installable tarball in `release/cli/`, bundling Milagre's private packages without Electron. After changing bridge inputs, run `node scripts/generate-command-contracts.cjs`; the parity check fails when the generated contracts drift from the UI's types.

MIT licensed.
