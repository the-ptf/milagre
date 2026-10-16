# Desktop guide

[Back to the README](../README.md)

## Attachments and file mentions

Use **+ > Add files**, or drop files onto the chat, to attach local files. Images and videos have previews in the draft and sent message. Click a preview to open it; videos have playback controls. Escape closes the viewer without stopping the agent. Other files appear as removable filename chips before sending.

File paths reach the agent while the visible message keeps your prompt text. Disk previews require the original files to remain in place. Picked or dropped PNG, JPEG, WebP, and GIF images up to 5 MB are also sent as image content, up to four per message. Larger images and other files are sent by path. Video playback depends on the format supported by Electron.

Paste an image with Cmd+V (Ctrl+V on other platforms) to send image content without a disk path. Pasted images keep the four-image and 5 MB limits and remain in local conversation history. Claude receives structured image content; Codex receives temporary image files removed when its request finishes.

Type `@` to find tracked and untracked, non-ignored files in the chat's worktree. Search by filename or path and select with Enter or Tab. Images and videos appear as previews in the composer; other files appear as removable chips. The selected path is sent to the agent without inserting it into your message text. Results are limited and cached for five seconds. Switching chats clears attachment drafts.

Restart Electron after updating to register the media protocol and file-search IPC. Run `npm test -- --only chat-attachments` for the Chromium integration checks, including video playback, attachment delivery and file selection without calling an agent.

## Notifications

Milagre can notify when a turn completes or fails while its chat is not focused, with a preview of the result. Clicking the notification opens that chat, including switching projects through the usual confirmation flow. The focused chat stays quiet; cancelled turns do not send completion alerts. A turn that ends while a subagent the chat runs in the background is still at work is not announced either: the turn that subagent's result wakes is, once nothing runs in the background. The same rule applies to the phone's push notifications.

The Dock badge counts chats with unread replies or pending approvals/questions, counting each chat once. Reading a chat clears its unread status. **Settings > General** has separate switches for completion notifications, waiting notifications and the Dock badge.

## Workspace image

The sidebar uses the project's main image first, then the GitHub organization avatar for organization-owned repositories, then the profile authenticated in GitHub CLI (`gh`). If `gh` is not authenticated, a personal repository's owner avatar is used. If no image is available, the workspace keeps its default icon.

To explicitly choose a project image, add `.milagre/icon.png` (SVG, JPEG, WebP, GIF and ICO are also supported). Otherwise Milagre checks `package.json` (`build.mac.icon`, `build.icon`, or `expo.icon`), followed by common logo/icon files in the project root, `public/`, `app/public/`, and `assets/icon.*`. Next it checks `favicon.*` in the project root, `public/`, `app/public/`, `app/`, `src/app/`, and `static/`, plus `app/icon.*` and `src/app/icon.*`. Local images must be inside the project and at most 5 MB. Image lookup runs in the background when opening or switching projects; GitHub credentials stay in the main process. Restart Electron after updating the backend.

## Slash skills

Type `/` in the prompt to search commands and installed skills by name or description. Built-in commands appear first under **Milagre skills**, followed by **Workspace skills** and **User skills**. Select a skill with a click, Enter, or Tab, add your request, and send. Milagre reads the selected `SKILL.md` and includes its instructions and reference directory in the agent request.

Milagre bundles `/tldr` and its checklist. Its writing rules apply by default to Claude and Codex progress updates and final replies through their shared instructions. Toggle **Settings > General > Agents > TLDR writing** to enable or disable this default. The preference is saved across app restarts and applies when the next turn starts after any running reply finishes, including in existing chats. The `/tldr` skill remains available when the toggle is off. Say `stop tldr` or `normal mode` to ask the agent to disable them for the current chat; `/tldr` enables them again. `/tldr <text or file>` rewrites one input, and `/tldr is this slop? <text>` audits it. These are agent instructions, so compliance depends on the model. Streaming replies are displayed directly without a second rewrite request.

Skills are discovered recursively in `.agents/skills`, `.claude/skills`, `.gemini/skills`, and `.codex/skills`, under both the active worktree and your home directory. Symlinked skill directories are supported. Workspace skills take precedence over user skills with the same name; within each scope, directories are checked in the order above. A skill with the same name as a built-in command takes precedence over that command.

Bundled skills are the fallback after workspace and user skills. An installed `/tldr` overrides the bundled slash command; the default writing rules still come from Milagre's bundled copy. Bundled skill files are unpacked in the desktop build so agents can read their references.

The menu refreshes when reopened and when switching worktrees. Skill names and descriptions come from YAML frontmatter, with the folder name as a fallback. Unreadable or invalid skills are reported without blocking the rest of the list. Discovery is limited to eight nested levels and 2,000 directories; individual skill files and the combined skill context are limited to 256 KiB. Only standalone slash tokens outside inline and fenced code invoke skills.

## Permission modes

- **Ask approval**: the agent stops before a file edit or command it isn't already allowed to run, and shows the exact command or change. Claude asks before edits and before commands outside its allow rules; Codex asks before any command it doesn't already trust.
- **Auto**: file edits inside the workspace go ahead. Claude still asks before commands outside its allow rules; Codex works inside its workspace sandbox and asks only to go beyond it.
- **Full**: no agent tool approvals, and Codex runs without its sandbox. Use only when you trust the prompt and the workspace.

Escape denies an open approval card and dismisses an open question card. "Always allow in this chat" lasts while the chat's agent stays open, which ends after 10 idle minutes or when Milagre quits, and never changes your Claude or Codex settings files.

Setup commands from a Project's `.milagre/worktree.json` require a separate review before the first agent turn in each new Worktree, including Named Link members and Full permission mode. Desktop and phone show the full command, source file, Project, target folder and Computer. **Run once** approves that Worktree; **Trust this version** remembers the exact command for that Project on that Computer; **Skip setup** continues the Chat without running it. Changing the command requires another review. Pending setup survives a host restart, and a setup interrupted by a crash requires review before retrying.

Question cards appear in every mode, Full included. A message you send while a question is open dismisses it and reaches the agent as your reply. Codex asks with a card through a Codex feature that is still under development; without it, Codex asks in its reply.

The approval boundary is enforced by the shared core runtime in the local daemon. The renderer can request work, but it should not receive arbitrary filesystem or process privileges.

## Advisors and committee

Use `/milagre-advisor` to ask the other provider for a second opinion. `/milagre-committee` launches one Claude and one Codex analysis, compares their evidence and can send one comparison follow-up per member. `/milagre` explains the tool contract, and `/milagre-help` answers product questions from references shipped with the app. These bundled skills also appear on paired phones; workspace and user skills retain precedence.

Advisors use the owning Project or Named Link's Account and reported models. They can read its owned Worktrees, supplied skill references and read-only canvas context. They cannot edit, run shell commands, delegate or launch agents, including with parent Full permissions. At most two advisors run per Chat; each accepts four queued follow-ups.

Subagents identifies the advisor's provider and shows its activity/output. Stop cancels its work; Retry restarts an interrupted or failed advisor with its pinned Account and history. Results return as labeled app context for synthesis. Human questions, approvals and preparing handoffs defer delivery. Parent Stop cancels active advisors and prevents late results from resuming the Chat. Completed output survives restart; uncertain delivery remains available for manual inspection.
