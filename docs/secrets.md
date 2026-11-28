# Secrets

Named secrets a person saves once on a computer and agents use without the value passing through a prompt (issue #1239). `request_secret` stays for one-off asks: a file that lives 24 hours.

## What it protects

Distribution and hygiene, not a boundary against the agent. Keys leave hand-made files and stay out of prompts, Git, transcripts, the phone and bug reports, and every use is logged. An agent that can use a secret can print it, and the provider CLI reads that output before Milagre redacts it; same-user processes can read a running command's environment. On a headless computer the master key file sits on the same disk as the vault.

## Who can see a value

Only this computer and the person. Milagre's operator (the relay, share pages, push, the site) never gets one:

- **Phone to computer.** A value typed on the phone travels inside the end-to-end channel (`relay-crypto.mjs`); the relay, LAN and Tailscale carry only ciphertext. A Cloudflare tunnel or another HTTPS proxy ends TLS before the bridge and could read it, so the daemon's encrypted channel stamps each request it forwards (`sealed-channel.cjs`) and the daemon's bridge refuses `secrets:set` and secret answers without that mark. The phone shows why; the person types the value on the computer or connects through the relay.
- **Push.** A secret request's notification says only that a secret is wanted (`attentionNotice`), never its name or the command, since it leaves through Expo, Apple and Google.
- **The phone** gets names and notes, never a value or its last four characters.
- **Model providers** (Anthropic, OpenAI) see whatever an agent prints, before Milagre redacts it. On-demand delivery keeps values out of the agent's context unless the command prints them.

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

## Commands and Settings

`secrets:status`, `secrets:list`, `secrets:set` (`value`, or `file`: an absolute path the host reads, 64 KB at most), `secrets:update` (scope, delivery, ask-each-use, unattended and note, never the value), `secrets:import` (a `.env` file; reserved and empty names are skipped and reported), `secrets:delete`, `secrets:log`. The CLI exposes them as `milagre secrets <action>`; pass values with `--input -` on stdin, never on the command line.

- **Desktop:** Settings › Secrets (Agents group, after Connectors; palette "Open Secrets" and "Add secret") calls them through the preload bridge (`window.milagre.secrets`, local only), so their contracts are generated from it. A file secret or `.env` import is picked with a file input and sent as its absolute path.
- **Phone:** Settings › Agents on the computer › Secrets. Its allowlist has every method but `secrets:import`; `mobile-routes.cjs` refuses `secrets:set` with a `file` (the phone can't make the host read one of its files), and drops every `hint`. File secrets show but are replaced on the computer.
- **Paired computers** can't call any `secrets:` method.

## Asking the person

- **Ask each use** (per secret): before `milagre-secrets run` hands it over, the Chat shows an Allow / Deny question naming the secrets and the command (`approveUse` in `chat-secrets.cjs`). No answer in five minutes, a dismiss or an ended turn is Deny. Its request id carries the secret prefix, so no agent, Subchat escalation or Orchestrator autopilot can answer it.
- **Save as:** `request_secret` takes an optional `name`. The card then offers This Project (when the Chat's Project has an origin), All Projects or Don't save, and says when it replaces a saved secret; the answer carries `save`. When it's saved, no one-off file is written: the agent is told to use the saved name. Otherwise the one-off file lives 24 hours in `chat-secrets/`, which is excluded from Time Machine, and its value is redacted for those 24 hours.
