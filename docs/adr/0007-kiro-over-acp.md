# Kiro runs over the Agent Client Protocol

Kiro is the fourth provider, after Claude, Codex and Antigravity. It runs on the credits of a Kiro license (Pro, Power, or an organization's Enterprise license through IAM Identity Center). Milagre drives AWS's Kiro agent over the Agent Client Protocol with the same client as Antigravity (ADR-0006): `acp-session.cjs`, with Kiro's command, modes, model ids and login errors in `kiro-acp.cjs`.

Milagre doesn't install Kiro. The user installs kiro-cli (`brew install --cask kiro-cli` on macOS) and signs in with it. Milagre runs the agent binary, `kiro-cli-chat`, found beside the real path of the `kiro-cli` launcher on PATH, else in `/Applications/Kiro CLI.app` (or `MILAGRE_KIRO_PATH`). `kiro-cli acp` itself fails until the CLI's own setup has linked `~/.local/bin/kiro-cli-chat`, so the launcher is never the command. The oldest supported release is 2.34.2, the one this was verified against.

The agent starts as `kiro-cli-chat acp --agent-engine v3`. The v3 engine was chosen over v2 (the default) after both were probed on 2026-10-30:

- v3's `model` option reports each model's credit multiplier and efforts in `_meta.kiro` (`rateMultiplier`, `rateUnit: "Credit"`, `effortLevels`, `defaultEffortLevel`). v2 reports neither.
- v3 sets the effort through an `effortLevel` option that appears after each model switch, at that model's default. Auto and the older models have none.
- v3 lets read-only commands run without asking (`git status` ran, `rm` asked). v2 asks for every command, which is what makes Kiro's own UI a stream of approvals.
- v3 has session list, close, delete and fork, checkpoints and compaction methods. Milagre uses delete only, for throwaway sessions.

Models keep Kiro's ids behind a `kiro:` prefix (`kiro:claude-opus-5.5`), so a Claude or GPT model run on Kiro's credits never turns into the same model on its own provider through a saved default. Auto is the recommended model. The picker shows each model's multiplier where other providers show the context window. The list comes from a short-lived ACP session before the first Chat (`kiro-model-list.cjs`), which is deleted afterwards because Kiro keeps every session in its history. A short catalog in `@milagre/shared/kiro-models` stands in when kiro-cli is missing or signed out. GPT's `none` effort is left out: Milagre's efforts are thinking levels.

Kiro's `mode` option names its agents (Default, Spec, Plan…), not its approvals, so Milagre never sets it. Its `autopilot` option stays on in every mode. With autopilot on, Kiro asks before each edit and before each command it doesn't consider read-only. With it off (supervised), Kiro also asks for every command, and after each edit it asks again to review it: a second card for what Ask already approved. Every request goes through `session/request_permission`, and Milagre's mode decides what reaches a card:

- Ask: every request Kiro makes gets a card.
- Auto: edits inside the Chat's folders run. Commands go through a risk filter (`command-risk.cjs`). A command that stays inside the worktree runs without a card. A risky one gets a card whose reason says why: it writes or deletes outside the worktree, discards uncommitted work (`git reset --hard`, `git clean`), writes to GitHub (push, `gh pr create`…), runs as an administrator, installs software for the whole computer, runs a script from the internet, sends data over the network, connects to another machine, touches saved credentials, stops processes, or changes containers, a cloud service or the computer's settings. The filter reads the command's words with the babysit guard's shell parser, chained and nested commands included. It can't see what a script does, so it trusts a script inside the worktree as it trusts the worktree's own files.
- Full: nothing asks. Bot rules: the bot answers, as for the other providers.

There is one Account, the one kiro-cli is signed in to. An Identity Center sign-in needs the organization's start URL and region (`kiro-cli login --license pro --identity-provider <url> --region <region>`), so it happens in a terminal. Milagre reads who is signed in with `kiro-cli whoami` (the method and email, never raw output), adds no Kiro Accounts and starts no Kiro sign-in. The `addAccounts` capability is false for Kiro, which hides Add account on both platforms.

Chat titles, handover briefs, dictation cleanup and commit messages on a Kiro Chat use one Claude Haiku 4.5 turn in a throwaway session, which is deleted afterwards. These cost a fraction of a credit each.

Each turn's cost comes from the `session_info_update` Kiro sends just before the turn ends (`_meta.kiro.kind: "turn_completion"`, `promptTurnSummaries[].usage` in credits). The cost rides on `turn-completed` as `credits`, is saved on the reply, and closes the activity summary on both platforms ("Ran 1 command · 0.04 credits").

The month's credits come from `kiro-cli chat --no-interactive /usage`, which answers without a model turn and costs nothing ("Credits (452.97 of 10000 covered in plan), 4.5%", "resets on 2026-11-01"). The sidebar shows a "Kiro credits" window, and the usage card adds "452.97 of 10,000 credits". The read takes about ten seconds and leaves a session record, so it runs in a temporary folder whose records are removed afterwards, at most every five minutes. It never holds up the other providers' numbers: before its first answer, Kiro shows as still loading. The CLI reads the same numbers from CodeWhisperer's `GetUsageLimits`; calling that directly would need Kiro's token store, which belongs to kiro-cli.

Kiro's subagents (`context-gatherer`, `general-task-execution`) stay plain steps.
