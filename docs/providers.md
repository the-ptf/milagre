# Providers

How Milagre runs agents other than Claude and Codex (over the Agent Client Protocol, or Pi's RPC mode for local models), and how the host owns provider Accounts.

## ACP client

Antigravity and Kiro run over the Agent Client Protocol: JSON-RPC over stdio. `acp-session.cjs` is a generic client; each agent supplies its command, environment, modes, model ids, sign-in and login errors (`antigravity-acp.cjs`, `kiro-acp.cjs`). Another ACP agent is configuration, not a new client.

- A Chat starts with `session/new` and resumes from its saved id without replaying history as new output. Milagre's instructions and the `milagre` MCP server attach when a session is created.
- `session/request_permission` goes to the approval cards; requests that are really questions use the question card.
- Stop sends `session/cancel`. A session that doesn't confirm within a few seconds is killed (with the process group below it) and replaced on the next turn.
- ACP can't steer a running turn. A message sent while the agent works becomes the next turn; Stop drops it, as it drops a steered message on Claude and Codex.
- Before the first Chat, a short-lived empty session discovers the model list, without prompting, authenticating or attaching tools. Concurrent lookups share one per Account; Account changes invalidate it; failures retry on the next read. A static catalog stands in for a missing or signed-out agent.
- Model ids carry a provider prefix (`antigravity:`, `kiro:`), so a Claude or GPT model run through these agents never resolves to the same model on its own provider through a saved default.

## Antigravity

Google's Antigravity agent (`agy_acp_server`) runs the Gemini and partner models the Google Account offers.

Rejected: the Gemini CLI (`gemini --acp`). Google refuses its sign-in for personal Google accounts and points them to Antigravity, so it works only with Workspace or Code Assist accounts or API keys. The costs of Antigravity are a large separate download, a sign-in URL printed on stdout, and upstream hang and cancel bugs the session must survive.

- **Install.** Milagre installs and updates the agent itself. The ACP registry lists URLs without hashes, so each release is pinned in `antigravity-install.cjs`; a platform without a pin is unsupported, never guessed.
- **Modes.** Ask is `default`, Auto is `auto_edit`, Full is `yolo`. Antigravity holds a cancel until its background commands finish, and starts each command in its own process group, which is why Stop kills the group.
- **Models.** The agent reports one model per thinking level, `<Family> (<Level>)`. Milagre groups them into one model per family with the levels as efforts, and keeps a per-family table to the agent's own ids because they are irregular. `(Thinking)` is part of a label, not an effort.
- **Subagents.** ACP says nothing about them, so `antigravity-subagents.cjs` reads the transcripts the agent writes under its home's `brain/` while children run. These are undocumented internals: every read is best effort, and without them a launch stays a plain step.
- **Usage.** The agent reports none. `antigravity-usage.cjs` refreshes an access token from the profile's `acp_token.json` in memory (the agent owns that file; Milagre never writes it) and calls Cloud Code's undocumented quota endpoint. Every failure becomes the ordinary unavailable state, keeps the last good numbers and never logs a token.

## Kiro

AWS's Kiro agent runs on a Kiro license's credits.

- **Install.** Milagre doesn't install Kiro; the user installs kiro-cli and signs in with it. Milagre runs `kiro-cli-chat`, found beside the real path of the `kiro-cli` launcher, else in the app bundle, or `MILAGRE_KIRO_PATH`. Never the launcher: `kiro-cli acp` fails until the CLI's own setup has linked `kiro-cli-chat`.
- **Engine.** It starts as `kiro-cli-chat acp --agent-engine v3`. Rejected: v2, the default. v3 reports each model's credit multiplier and efforts, sets effort through an option that appears after each model switch, lets read-only commands run without asking (v2 asks for every command), and can delete sessions.
- **Models.** Auto is recommended. The picker shows the credit multiplier where others show the context window. Discovery and helper sessions are deleted afterwards because Kiro keeps every session in its history. GPT's `none` effort is left out: Milagre's efforts are thinking levels.
- **Approvals.** Kiro's `mode` names its agents (Default, Spec, Plan), not approvals, so Milagre never sets it. `autopilot` stays on in every mode; supervised mode would ask again after every edit Ask already approved. Milagre's mode decides what reaches a card: Ask shows every request; Auto runs edits inside the Chat's folders and sends commands through `command-risk.cjs`, which parses chained and nested commands and asks only for risky ones (reaching outside the Worktree or hard to undo), saying why; Full asks nothing. The filter can't see inside a script, so it trusts a script in the Worktree as it trusts the Worktree's files.
- **Account.** One, whoever kiro-cli is signed in to. Identity Center sign-in needs an org start URL and region, so it happens in a terminal. Milagre reads `kiro-cli whoami` (method and email only), adds no Kiro Accounts and starts no sign-in; `addAccounts` is false.
- **Helpers.** Titles, handover briefs, dictation cleanup and commit messages on a Kiro Chat use one small-model turn in a throwaway session.
- **Cost.** Each turn's credits come from the `session_info_update` Kiro sends before the turn ends. The month's credits come from `kiro-cli chat --no-interactive /usage`, which is free but slow and leaves a session record, so it runs rarely, in a temp folder, and never holds up other providers' numbers. Calling the backend directly would need kiro-cli's token store.
- Kiro's subagents stay plain steps.

## Ollama

Local models from the computer's Ollama server, run by the Pi coding agent (`@earendil-works/pi-coding-agent`) in RPC mode: one JSON record per line on stdio (`pi-rpc.cjs`, `pi-session.cjs`). Pi is the harness because Ollama serves models, not an agent loop.

Rejected: Claude Code against Ollama's Anthropic-compatible API (works, but Claude's account, usage and limit logic would apply to models that have none) and a Milagre-owned agent loop (weeks to reach tools, edits and approvals).

- **Install.** The user installs Pi (`npm install -g @earendil-works/pi-coding-agent`, 1.5.0 or later) and Ollama. Milagre finds `pi` on the PATH; `cli-update.cjs` refuses to update it. Ollama not answering on `OLLAMA_HOST` (default `127.0.0.1:11434`) is the provider's signed-out state, with a message that says to start it. Only this computer's server is used.
- **Profile.** Pi runs from a Milagre-owned profile, `accounts/ollama-pi` (`PI_CODING_AGENT_DIR`), never `~/.pi`, with `PI_OFFLINE=1` and `PI_TELEMETRY=0`, so the user's own Pi settings and extensions don't load.
- **Prompt size.** A local model reads the whole prompt on every cold start (about 280 tokens/s for a 27B model on this class of Mac), so the prompt is kept near 3K tokens: Pi runs with `--no-skills` (Pi would otherwise list every skill in `~/.agents/skills`, 18K tokens on a typical machine), and Ollama Chats get `localModelInstructions` in `events.cjs`, the rules that shape every reply plus one line pointing at tool search for Designs, artifacts, browsers and the rest. One Account, "This computer"; `addAccounts` is false.
- **Models.** Read from Ollama on every model list (`/api/tags`, `/api/show`, `/api/ps`), so a model pulled a moment ago shows at once, and written to the profile's `models.json` as one `ollama` provider over Ollama's OpenAI-compatible API. Only models Ollama says can call tools are listed; ones that can think get Low, Medium and High. Ids carry an `ollama:` prefix. The context window is the loaded model's, else its `num_ctx`, else 32K: Ollama picks 4K, 32K or 256K by VRAM for a model without `num_ctx`.
- **Approvals.** Pi asks nothing on its own. Milagre writes a small extension into the profile (`pi-extension.cjs`) that sends every tool call except reads through Pi's extension UI as a `select`, which the session answers. Pi's tools are mapped to their Claude Code names, so cards and steps look the same, and Ask, Auto (edits in the Chat's folders run, commands through `command-risk.cjs`) and Full behave as on Kiro. Always allow in this Chat is kept in the session.
- **MCP.** The same extension registers the Chat's servers (passed in `MILAGRE_PI_MCP`) with `deferred` exposure: a local model's context is small, so tools load through Pi's tool search instead of being declared up front.
- **Context.** The composer always shows the context meter on an Ollama Chat (0% of the model's window before the first turn). Pi's own automatic compaction is switched on for every session, and Compact (and Milagre's automatic compaction) becomes Pi's `compact` command, which reports through the same `compaction_start` and `compaction_end` events.
- **Metrics.** Pi reports tokens per model call but no timings, so `createTurnMetrics` in `pi-events.cjs` times them: prefill from a call's start to its first streamed event, generation from there to the call's end. The completed turn carries `metrics` (time to first token, output and prefill tokens per second, prompt and output tokens, turn length), saved on the session's `contextUsage`, and desktop and phone show them in one line under the composer.
- **Steering** works: a message sent mid-turn is Pi's `steer`, delivered before the next model call. Stop sends `clear_queue` and `abort`, and kills the process if it doesn't settle.
- **Helpers.** Commit text and handover briefs use the loaded local model (else the newest) through one `pi -p` call with no tools, and never fall back to a cloud provider. Titles and dictation cleanup are off for Ollama Chats.
- No usage or cost: Ollama has no limits, so its usage row is always unavailable and hidden.

## Accounts

An Account is a saved provider sign-in on one computer. Each provider has a computer default. A Project or Named Link can pick an Account per provider or inherit the default; an omitted assignment inherits dynamically, an explicit `default` pins the connected CLI profile. Desktop and paired phones manage these host-local selections through the daemon.

- **Profiles.** Added Accounts get private directories under the data directory's `accounts/`, selected per process with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_HOME`. The provider CLI owns login, credentials and refresh. `accounts/accounts.json` holds only ids, names, defaults and assignments. Responses carry identity and status, never credentials or raw login output.
- **Sharing.** History directories are shared between profiles (Codex also shares its SQLite directory). Settings and instruction files are copied at creation; skills and plugins are shared. Changing a selection never writes over the terminal's own login.
- **Antigravity** has no terminal login to inherit, so its default is a Milagre-owned profile, `accounts/antigravity-default`, never `~/.gemini`. Every Antigravity process gets its profile as `GEMINI_HOME`, file token storage (so profiles never share a keychain entry), and no ambient `GEMINI_*`, `GOOGLE_*` or `BROWSER`. Nothing is ever written to `~/.gemini`. Signed-in means the profile holds `acp_token.json`, so checking starts no process.
- **Sign-in** runs on the computer and opens its browser. For Antigravity, Milagre runs the agent's `authenticate`, checks the printed link is Google's OAuth page with a loopback redirect, and opens it itself; the agent's own browser launch is stubbed. No probe ever starts a sign-in. Accounts are added on desktop; a phone can re-authenticate or cancel, but the callback finishes on the computer. Finishing sign-in doesn't change the selection.
- **Switching** replaces an idle provider process on its next turn, resuming the saved session. Running turns and active subagents keep their process and credentials. After a usage limit, switching closes the limited process even with background work, marks its subagents cancelled, and tells the next agent to check saved progress.
- **Routing.** Everything a Chat runs, helpers included (titles, Worktree names, handovers, Git text), uses the owning Project or Link's Account. Viewing another Project never changes routing.
- **Caches.** Model, status and usage caches are keyed by the effective Account, so a failed read never shows another Account's numbers, and usage never falls back to the default credentials.
- **Remove** takes a profile out of the chooser but leaves its directory and credentials, so an in-flight reply finishes and history stays. It is not revocation, and there is no sign-out. Removing the computer default falls back to the CLI account (Antigravity: its default profile). Explicit assignments keep the removed id and show it unavailable; new turns fail until the user picks another or restores inheritance, never a silent fallback.
- **Paired computers** can read a remote Project's usage and pick one of its owning computer's Accounts. Everything else (adding, removing, sign-in, defaults, limit switching) stays on the owning computer. A confined demo phone sees no Accounts.
