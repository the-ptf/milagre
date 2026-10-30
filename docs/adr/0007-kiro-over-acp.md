# Kiro runs over the Agent Client Protocol

Kiro is the fourth provider, after Claude, Codex and Antigravity. It runs on the credits of a Kiro license (Pro, Power, or an organization's Enterprise license through IAM Identity Center). Milagre drives AWS's Kiro agent over the Agent Client Protocol with the same client as Antigravity (ADR-0006): `acp-session.cjs`, with Kiro's command, modes, model ids and login errors in `kiro-acp.cjs`.

Milagre doesn't install Kiro. The user installs kiro-cli (`brew install --cask kiro-cli` on macOS) and signs in with it. Milagre runs the agent binary, `kiro-cli-chat`, found beside the real path of the `kiro-cli` launcher on PATH, else in `/Applications/Kiro CLI.app` (or `MILAGRE_KIRO_PATH`). `kiro-cli acp` itself fails until the CLI's own setup has linked `~/.local/bin/kiro-cli-chat`, so the launcher is never the command. The oldest supported release is 2.34.2, the one this was verified against.

The agent starts as `kiro-cli-chat acp --agent-engine v3`. The v3 engine was chosen over v2 (the default) after both were probed on 2026-10-30:

- v3's `model` option reports each model's credit multiplier and efforts in `_meta.kiro` (`rateMultiplier`, `rateUnit: "Credit"`, `effortLevels`, `defaultEffortLevel`). v2 reports neither.
- v3 sets the effort through an `effortLevel` option that appears after each model switch, at that model's default. Auto and the older models have none.
- v3 lets read-only commands run without asking (`git status` ran, `rm` asked). v2 asks for every command, which is what makes Kiro's own UI a stream of approvals.
- v3 has session list, close, delete and fork, checkpoints and compaction methods. Milagre uses delete only, for throwaway sessions.

Models keep Kiro's ids behind a `kiro:` prefix (`kiro:claude-opus-5.5`), so a Claude or GPT model run on Kiro's credits never turns into the same model on its own provider through a saved default. Auto is the recommended model. The picker shows each model's multiplier where other providers show the context window. The list comes from a short-lived ACP session before the first Chat (`kiro-model-list.cjs`), which is deleted afterwards because Kiro keeps every session in its history. A short catalog in `@milagre/shared/kiro-models` stands in when kiro-cli is missing or signed out. GPT's `none` effort is left out: Milagre's efforts are thinking levels.

Kiro's `mode` option names its agents (Default, Spec, Plan…), not its approvals, so Milagre never sets it. Approvals are its `autopilot` option: Ask and Bot rules turn it off, so edits ask too and reach Milagre's card or the bot; Auto and Full turn it on, and Full answers what still asks without a card. Every permission request goes through `session/request_permission` and Milagre's approval cards, as for Antigravity.

There is one Account, the one kiro-cli is signed in to. An Identity Center sign-in needs the organization's start URL and region (`kiro-cli login --license pro --identity-provider <url> --region <region>`), so it happens in a terminal. Milagre reads who is signed in with `kiro-cli whoami` (the method and email, never raw output), adds no Kiro Accounts and starts no Kiro sign-in. The `addAccounts` capability is false for Kiro, which hides Add account on both platforms.

Chat titles, handover briefs, dictation cleanup and commit messages on a Kiro Chat use one Claude Haiku 4.5 turn in a throwaway session, which is deleted afterwards. These cost a fraction of a credit each.

Not in this change: the credit usage card and per-turn credits, and a risk filter for Auto beyond Kiro's own. Kiro reports credits per turn in a `session_info_update` with `_meta.kiro.kind: "turn_completion"` and `promptTurnSummaries[].usage`. v2's `/usage` command answers the month's credits in text, and the CLI reads them from CodeWhisperer's `GetUsageLimits`. Kiro's subagents (`context-gatherer`, `general-task-execution`) stay plain steps.
