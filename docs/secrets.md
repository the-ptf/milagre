# Secrets

Named secrets a person saves once on a computer and agents use without the value passing through a prompt (issue #1239). `request_secret` stays for one-off asks: a file that lives 24 hours.

## What it protects

Distribution and hygiene, not a boundary against the agent. Keys leave hand-made files and stay out of prompts, Git, transcripts, the phone and bug reports, and every use is logged. An agent that can use a secret can print it, and the provider CLI reads that output before Milagre redacts it; same-user processes can read a running command's environment. On a headless computer the master key file sits on the same disk as the vault.

## Storage

`<dataDir>/secrets-vault.json`, AES-256-GCM with the computer vault's master key (`masterKey()` in `apps/daemon/src/computer-vault.cjs`: OS keychain on desktop, the `setup-key` file headless) and its own AAD. Locked until that key loads: lists and sets refuse, agents start without secrets, redaction has nothing to match. Values are write-only to every client; `secrets:list` returns summaries with a last-4 hint for values of 12+ characters.

Names are environment variable names. `secretNameProblem` (`@milagre/shared/secrets`) refuses variables that change how programs, Git, proxies or agents run (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `GIT_*`, `SSH_*`, provider prefixes, `*_BASE_URL`), so a pushed or imported secret can't take over a command. Sync (PR 3) must check names on receive too.

Every change bumps `version` and records `changedOn`; a delete leaves a versioned tombstone. Sync between computers resolves by version, not by clock.

## Who gets what

A secret is scoped to Project origins (`originId`, so SSH and HTTPS remotes match on every computer) or `all`. The origin is read from Git on every check, not from the Project list's cache, so a checkout pointed at another remote stops getting the old one's secrets at once. Link Chats and Project-less Chats have no origin and only get `all`.

Unattended turns (hidden Routine and Orchestrator Chats, Heartbeat turns, babysit and wake turns: `isUnattended` in `runtime/secrets-wiring.cjs`) get only secrets with `unattended: true`. They read untrusted text with network access, so that is the person's choice per secret.

## Delivery

- **On demand** (default). Each agent's PATH starts with `<dataDir>/secrets-bin`, holding a `milagre-secrets` shim that runs `secrets-run.cjs` with the host's own Node or Electron. `MILAGRE_SECRETS_URL` carries a per-Chat token for `/secrets/<token>` on the local MCP loopback server. `milagre-secrets run --with A,B -- cmd` asks the host, which checks scope and unattended, logs the use and returns the values; the command alone gets them, file secrets as a temporary 0600 file removed on exit. A missing name, or more than 50, refuses the whole command. Each file secret gets its own temporary folder. The command runs without a shell (on Windows a `.cmd` needs `cmd /c`), so its arguments reach it as the agent wrote them. The token ties a call to its Chat's scope; it isn't a defence against a same-user process. Retiring the Chat (archive, delete, Worktree removal) revokes it, and an archived Chat's token is refused even before that.
- **Ambient** (per-secret opt-in, text only). Added to the agent's environment when its session starts, so MCP servers, hooks and every child see it. `MILAGRE_SECRETS_AMBIENT` fingerprints which ambient secrets (name and version) the turn may hold; when it differs from the running session's, the session manager starts a fresh process that resumes the Chat. That is how a replaced value arrives, and how a Heartbeat or Routine turn never inherits a session holding secrets it may not use. A session busy with background work keeps its process, as for any other restart.

Agents learn names from `secrets_list` (names, kinds, notes; never values), pointed to by one line in the system prompt.

## Use log

`<dataDir>/secrets-log.jsonl`, 0600: time, names, Chat, computer, the program's file name only, sent apart from its arguments (they arrive expanded and may hold a credential), delivery. Kept 30 days. Ambient secrets are logged once per Chat per host run.

## Redaction

Provider events are redacted where they enter the host (`send` in `runtime.cjs` through `secrets-stream.cjs`, before `ChatHost.receive`), so storage, the phone, Delegation reports and shares see `[secret NAME]`. It matches values of 8+ characters, each line of a file secret, their base64 and every Chat's secrets token. Streamed text and step output arrive in 50 ms chunks, so the end of a chunk that could begin a secret waits for that stream's next chunk; pauses and other events don't release it. A tail held when a new message starts moves into that message, since the run's text joins them. When the stream ends (its step completes, the turn ends) a held tail of 8+ characters is masked as `[secret]` and a shorter one shows as is. Values stay in the matcher for 24 hours after they are replaced or deleted, since a running command may still print the old one; tokens are matched while their Chat lives. Bug reports add every value as a known token. Not covered: a person's own typed messages, the Terminal panel, screenshots, advisor result delivery and subagent recovery read from provider files.

## Commands

`secrets:status`, `secrets:list`, `secrets:set` (`value`, or `file`: an absolute path the host reads, 64 KB at most), `secrets:import` (a `.env` file; reserved and empty names are skipped and reported), `secrets:delete`, `secrets:log`. The CLI exposes them as `milagre secrets <action>`; pass values with `--input -` on stdin, never on the command line. Paired computers can't call any `secrets:` method, and the phone's allowlist doesn't include them.
