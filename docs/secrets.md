# Secrets

Named secrets a person saves once on a computer and agents use without the value passing through a prompt (issue #1239). `request_secret` stays for one-off asks: a file that lives 24 hours.

## What it protects

Distribution and hygiene, not a boundary against the agent. Keys leave hand-made files and stay out of prompts, Git, transcripts, the phone and bug reports, and every use is logged. An agent that can use a secret can print it, and the provider CLI reads that output before Milagre redacts it; same-user processes can read a running command's environment. On a headless computer the master key file sits on the same disk as the vault.

## Storage

`<dataDir>/secrets-vault.json`, AES-256-GCM with the computer vault's master key (`masterKey()` in `apps/daemon/src/computer-vault.cjs`: OS keychain on desktop, the `setup-key` file headless) and its own AAD. Locked until that key loads: lists and sets refuse, agents start without secrets, redaction has nothing to match. Values are write-only to every client; `secrets:list` returns summaries with a last-4 hint for values of 12+ characters.

Names are environment variable names. `secretNameProblem` (`@milagre/shared/secrets`) refuses variables that change how programs, Git, proxies or agents run (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `GIT_*`, `SSH_*`, provider prefixes, `*_BASE_URL`), so a pushed or imported secret can't take over a command. Sync (PR 3) must check names on receive too.

Every change bumps `version` and records `changedOn`; a delete leaves a versioned tombstone. Sync between computers resolves by version, not by clock.

## Who gets what

A secret is scoped to Project origins (`originId`, so SSH and HTTPS remotes match on every computer) or `all`. Link Chats and Project-less Chats have no origin and only get `all`.

Unattended turns (hidden Routine and Orchestrator Chats, Heartbeat turns, babysit and wake turns: `isUnattended` in `runtime/secrets-wiring.cjs`) get only secrets with `unattended: true`. They read untrusted text with network access, so that is the person's choice per secret.

## Delivery

- **On demand** (default). Each agent's PATH starts with `<dataDir>/secrets-bin`, holding a `milagre-secrets` shim that runs `secrets-run.cjs` with the host's own Node or Electron. `MILAGRE_SECRETS_URL` carries a per-Chat token for `/secrets/<token>` on the local MCP loopback server. `milagre-secrets run --with A,B -- cmd` asks the host, which checks scope and unattended, logs the use and returns the values; the command alone gets them, file secrets as a temporary 0600 file removed on exit. A missing name refuses the whole command. The token ties a call to its Chat's scope; it isn't a defence against a same-user process.
- **Ambient** (per-secret opt-in). Added to the agent's environment when its session starts, so MCP servers, hooks and every child see it. A replaced value reaches a running agent only after its session restarts.

Agents learn names from `secrets_list` (names, kinds, notes; never values), pointed to by one line in the system prompt.

## Use log

`<dataDir>/secrets-log.jsonl`, 0600: time, names, Chat, computer, the command's first 80 characters, delivery. Kept 30 days. Ambient secrets are logged once per Chat per host run.

## Redaction

Provider events are redacted where they enter the host (`send` in `runtime.cjs`, before `ChatHost.receive`), so storage, the phone, Delegation reports and shares see `[secret NAME]`. It matches values of 8+ characters, each line of a file secret and their base64. Bug reports add every value as a known token. Not covered: a person's own typed messages, the Terminal panel, screenshots, advisor result delivery and subagent recovery read from provider files.

## Commands

`secrets:status`, `secrets:list`, `secrets:set` (`value`, or `file`: an absolute path the host reads, 64 KB at most), `secrets:import` (a `.env` file; reserved and empty names are skipped and reported), `secrets:delete`, `secrets:log`. The CLI exposes them as `milagre secrets <action>`; pass values with `--input -` on stdin, never on the command line. Paired computers can't call any `secrets:` method, and the phone's allowlist doesn't include them.
