# Desktop, Chats and Accounts

Milagre coordinates Claude and Codex on a computer. Open a Git Project and start a Chat in a Worktree. A Named Link selects multiple Projects; each shared Chat owns an isolated Worktree in every member. Canvas Links provide read-only context and Delegation between existing Chats. Switching the viewed Project leaves running agents active.

## Accounts and models

Settings > Accounts manages saved provider sign-ins and computer defaults. Settings > Project Accounts assigns a provider Account to a Project or Named Link, or inherits the computer default. Viewing another Project never changes the assignment. A removed explicitly assigned Account stays unavailable until another Account is chosen or inheritance restored. Running replies and advisors retain their pinned Account.

Install and sign in to the desired Claude or Codex CLI on the computer. Model menus use the provider's reported catalog. A missing, outdated or logged-out CLI reports a picker error. Re-authenticate the affected Account on the computer; completing sign-in does not select it automatically. Phones can select Accounts and re-authenticate existing added Accounts; adding Accounts happens on desktop, and browser sign-in completes on the computer.

## Working in Chats

Ask approval shows commands/changes needing approval. Auto allows work within the provider's workspace rules. Full removes ordinary Chat approval barriers. Advisors remain analysis-only in every mode. Questions can appear in all modes. A message typed while a question waits dismisses it and becomes the answer; automatic advisor results wait instead.

The model picker can switch Claude/Codex in the same Chat. Milagre prepares a handoff and retains provider history. Stop cancels a preparing handoff. Subagents displays provider-native children and host advisors. Advisor rows identify their provider, show output, offer Stop while active and Retry when interrupted/failed. Archive hides finished rows.

Type `/` to search bundled, workspace and user skills. `/milagre-advisor` asks the other provider for advice; `/milagre-committee` asks one Claude and one Codex member; `/milagre` explains tools; `/milagre-help` answers product questions; `/qa-fleet` picks the first-time-user personas a feature needs (impatient, skeptic, mobile, literal, breaker), runs them in real browsers, fixes what they hit and reruns them; the Subagents panel shows each persona with its own avatar. Asking for QA or to test a feature starts it too. Workspace skills override user skills; both override bundled skills with the same name. `/tldr` controls writing instructions, and Settings > General > Agents > TLDR writing controls their default.

Attach photos/files with the composer. The computer supplies file paths to the agent. Chat Stop cancels the current parent turn and its active advisors. Closing desktop leaves its host and agents running.
