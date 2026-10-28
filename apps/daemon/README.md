# Milagre CLI

Run agents on a computer without opening a desktop UI. Requires Node.js 24+, Git, and at least one installed, signed-in agent CLI (Claude Code or Codex).

Start the server with npm:

```sh
npx milagre serve
```

Or install the command globally:

```sh
npm install --global milagre
milagre serve
```

## Triage a problem

When the desktop app won't start, or its own **Triage an issue** entry doesn't work, run:

```sh
npx milagre triage
```

It starts Claude Code or Codex in your terminal (`--agent claude|codex` picks one) with a triage playbook and a file of machine facts: OS, Node, agent CLIs, and each Milagre profile's host status, log and lock. The agent reads the logs and the Milagre source for your version, searches known issues, and can help you write a GitHub issue. It asks before it changes anything or posts. The files go in `triage/` inside the profile, so you can paste them into another agent when neither CLI is installed. The playbook itself is `packages/core/src/triage-playbook.md`; sessions fetch the newest copy from `main`.

`milagre help` lists the commands. Use `milagre help serve` or `milagre serve --help` for a command's flags and examples. Help uses color in interactive terminals and plain text when piped; `NO_COLOR` disables color.

`serve` runs in the foreground and uses `~/.milagre/server` for its persistent profile. It prints a private pairing link and, in an interactive terminal, a phone QR code. In another desktop's Settings > Devices > Add computer, paste the link. Approve the computer from another terminal on the server:

```sh
milagre devices pending
milagre devices allow KEY
```

Phones scan the QR with Milagre's pairing screen. The existing encrypted relay connects devices across networks; no public daemon port is needed. Pairing links expire after 10 minutes. Previously paired devices reconnect after a server restart. Run `milagre pair` to open another pairing window. Keep links private: they grant access to your agents.

```sh
milagre serve --project /absolute/path/to/project
milagre status
milagre devices list
milagre devices deny KEY
milagre devices remove KEY
milagre request project:open '["/absolute/path/to/project"]'
milagre stop
```

Use `MILAGRE_DATA_DIR` or an absolute `--data-dir` to select another profile. Use that same profile for every command. The CLI profile is separate from the desktop profile; do not open the same Projects in two hosts at once. The server runs with your account's permissions and uses the agent credentials on that computer.

Product commands come from the running host's registry. `milagre command list` discovers its operations. RPC names become words: `project:registry` becomes `milagre project registry`. `milagre help project` and `milagre project --help` list that family's operations. Inputs and help are generated from the UI's types. Use named flags or JSON:

```sh
milagre project registry
milagre project open --folder /absolute/path/to/project
milagre chat patch --project-path /absolute/path/to/project --session-id 1 --patch '{"title":"Review"}'
milagre help chat patch
milagre command describe chat:send --json
```

`--input` accepts inline JSON, `@/path/to/input.json`, or `-` for standard input. An object uses the named schema printed by `milagre command describe`; legacy positional arrays still work. Numbers, booleans, arrays and objects use JSON values in flags. Reserved field names use `--arg-input`, `--arg-chat`, `--arg-channel` or `--arg-version` so global switches remain unambiguous. Unknown flags and invalid inputs fail before execution. Owner help works without starting a server. Results are JSON. `--json` also prints structured errors and exits with a nonzero status on failure. A timeout can leave a mutation running; check state before retrying.

Scoped commands use the exact definitions and dispatcher used by MCP, including strict object validation, Chat identity, Project grants, Bot rules, approvals and mutation journals. Select an existing Chat by its full `projectPath#id` identity (or its Link scope):

```sh
milagre command list --chat '/absolute/path/to/project#1'
milagre command describe tasks_set --chat '/absolute/path/to/project#1'
milagre command run tasks_read --chat '/absolute/path/to/project#1'
milagre tasks read --chat '/absolute/path/to/project#1'
```

`milagre watch` emits a snapshot followed by live events as newline-delimited JSON. It subscribes before reading the snapshot and excludes events at or before that snapshot's watermark. `--chat` and repeatable `--channel` filter events. Ctrl+C disconnects the viewer and leaves agents running. Reconnect after a dropped connection for a fresh snapshot.

`milagre session` keeps one owner connection open for scripts and browser or simulator viewer controls. Send newline-delimited requests such as `{"id":1,"method":"project:registry","args":[]}`. It emits `{id,result}`, `{id,error}` and `{type:"event",...}` records. EOF waits for accepted commands. Viewer capabilities end when the connection closes. Agents must not use this owner transport to access user Terminals.

The daemon owns saved computer connections, reconnects, relay/LAN routing and the offline cache. Desktop and CLI use that same manager. Closing desktop leaves the connections running; stopping the daemon closes them. Connection enablement persists across daemon restarts.

For unattended access, configure a private key file outside the profile directory:

```sh
milagre computers setup-key "$HOME/.config/milagre-secrets/computer.key"
milagre computers enable
milagre computers add 'milagre://pair?...' --name Studio
milagre computers list
milagre computers rename COMPUTER_ID 'Build server'
milagre computers invoke --input '["COMPUTER_ID","project:registry",[]]'
milagre computers disable
```

`add` waits for the other computer's owner to approve it. `computers cancel-add` cancels a pending pairing; `computers remove COMPUTER_ID` removes its saved connection and disconnects it. Results and events retain computer-qualified identities, and remote calls keep the same restrictions as the desktop. Computer management, credential setup and migration require a local owner connection; paired peers and the phone bridge cannot invoke them.

`setup-key` generates 32 random bytes if the file does not exist, or verifies an existing 32-byte key. The file and its parent directory must be private to your OS account (0600 and 0700 on Unix, protected ACLs on Windows). Keep this file separate from profile backups. Credentials are authenticated and encrypted with AES-256-GCM in `computer-vault.json`; no credential values are printed. `MILAGRE_COMPUTER_KEY_FILE` can select a pre-provisioned private key file instead of the saved key-file setting. Missing or wrong keys fail without replacing existing pairings.

Existing desktop pairings migrate once the updated desktop opens and unlocks its OS keychain. The daemon preserves their identity and pinned keys, and retains the old encrypted `computer-keys.json` file. Desktop seals its vault master key in `computer-vault-key.json`; this is not a plaintext fallback. To use that profile unattended after a restart, run `computers setup-key /absolute/private/directory/computer.key` while the desktop has unlocked it. This exports the same master key to your chosen private file. Once configured, the daemon can reconnect without Electron or an unlocked desktop keychain. A missing keychain or Linux's `basic_text` backend does not silently weaken credential storage.

When a desktop using the same profile is connected, `milagre command list` also advertises native actions such as `milagre desktop editor list` and `milagre desktop update state`. Use `--data-dir` to select that desktop's profile. A missing desktop returns `CAPABILITY_UNAVAILABLE` for these native actions. Native actions are never replayed after disconnects.

`milagre mcp serve --stdio` uses the existing scoped connection specified by `MILAGRE_MCP_URL` and `MILAGRE_MCP_TOKEN`. It connects only to the existing loopback host and grants no owner access. MCP's HTTP adapters and the CLI share the command dispatcher directly; they do not spawn `npx` per call. Owner commands expose typed schemas too. The parity check covers every desktop bridge action, every phone RPC and all registered owner commands; it fails when the generated contracts drift from UI types. Run `node scripts/generate-command-contracts.cjs` after changing bridge inputs.

Ctrl+C and SIGTERM save and stop the server. Use `milagre serve --no-pair` for unattended restarts without printing links or opening a new pairing window. It retains access for devices already paired. `--no-qr` prints links without QR codes. No startup service is installed automatically; run the foreground command through your service manager for an always-on computer.

From the repository, `npm run cli -- serve` runs the same command. `npm run package:cli` produces the installable tarball in `release/cli/`; it bundles the private Milagre packages, without Electron. npm installs registry dependencies and sets up native dependencies for the computer where you install it. You can also install that tarball with `npm install --global ./milagre-0.3.0.tgz`.
