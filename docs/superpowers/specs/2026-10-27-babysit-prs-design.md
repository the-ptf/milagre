# Babysit PRs

Date: 2026-10-27. Designs on the Chat's canvas, group Babysit PRs: the page (`babysit-settings`) and its entry row in
Settings › Experimental (`babysit-experimental-entry`).

## Intent

When a Chat opens a PR, the work isn't done: reviewers comment, checks fail, main moves. Today Victor either watches the
PR himself or asks the agent to set a Heartbeat by hand ("Babysit PR #473"). This makes that automatic and configurable:
one setting, and every PR a Chat opens gets a **Heartbeat** in that Chat that watches it until it's done.

Success: Victor opens a PR from a Chat, walks away, and comes back to review threads answered and checks green, without
spending tokens while nothing happened on the PR.

## Goals

- A **Babysit new PRs** setting. When it is on and a Chat opens a PR, Milagre creates a Heartbeat in that Chat named
  `Babysit PR #<n>`.
- Milagre checks the PR itself on an interval (default 1 minute). The agent only gets a turn when something it is set to
  care about changed. An idle PR costs no tokens.
- The user chooses what the agent does about a problem (five levels, below), and Milagre holds the agent to it.
- The user chooses when babysitting stops (rules, below).
- The user adds their own instructions to Milagre's prompt. Edits save as they type.
- Every setting has a Milagre default and the user can choose something else. One global set of values.
- Ships under Settings › Experimental first (Victor, 2026-10-27), on desktop and phone.

## Non-goals

- Per-Project overrides (later, if ever).
- Showing Milagre's own babysit prompt to the user.
- PRs opened outside a Chat (github.com, a terminal). Only a Chat's own successful `gh pr create` starts babysitting.
- Hosts other than GitHub.
- Merging the PR. Babysitting never merges.

## Anti-goals

- An agent turn every minute on a quiet PR.
- The agent waking itself: its own replies must never count as new review comments.
- Two babysitters on one PR.
- Pushing, replying, re-requesting review or resolving threads beyond what the user chose. The user's instructions can't
  widen it.

## Settings

| Setting | Values | Default |
|---|---|---|
| Babysit new PRs | on / off | **off** |
| Check every | 1, 2, 5, 10, 15, 30 minutes | 1 minute |
| Wake the agent for | any of: Review comments, Failed checks, Merge conflicts, Branch behind base | first three on |
| When something needs fixing | one of the five levels | **Fix and push** |
| Resolve threads it answered | on / off (only matters at levels 4 and 5) | **on** |
| Stop when: merged or closed | always on, not editable | on |
| Stop when: checks pass and the PR is approved | on / off | on |
| Stop when: it has watched the PR for | on / off + 1, 3, 7, 14, 30 days | on, 7 days |
| Stop when: it failed to fix the same problem | on / off + 2, 3, 5 times | off, 3 times |
| Stop when: your own rule | on / off + one line of text | off, empty |
| Your instructions | free text | empty |

The five levels, each including everything above it:

1. **Report only**: posts what's wrong in the Chat and changes nothing.
2. **Fix, don't push**: fixes in the Worktree and stops for the user to look.
3. **Fix and push**: commits and pushes the PR's branch. (Default.)
4. **Fix, push and reply**: also replies on each review thread it addressed, with the commit that fixed it.
5. **Fix, push, reply and re-request review**: then re-requests review from reviewers who asked for changes.

Skills per problem: failed checks `milagre-fix-ci`, review comments `milagre-address-review`, conflicts
`milagre-resolve-conflicts`, branch behind `milagre-update-branch`. The level decides how far each goes.

**Reset all to defaults** restores every value above, including clearing the instructions and own rule.

**Your instructions** autosave about 500 ms after typing stops and on blur, with only a "Saved" mark under the field. The
text goes after Milagre's prompt in a labelled section; it adds to the prompt, never replaces it.

**When settings change.** A babysit Heartbeat takes a copy of the settings when it is created. Changes apply to PRs
opened afterwards. Turning **Babysit new PRs** off stops new ones; running ones carry on and can be deleted from their
Routine page like any Heartbeat.

## How it behaves

1. **Detect.** A Chat's shell step runs `gh pr create` and it succeeds. The daemon finds the PR URL from that step, the
   same way `packages/shared/src/chat-pull-requests.mjs` does today, so it works with no window open.
2. **Create.** If the setting is on and no babysit Heartbeat exists for that PR (keyed by repo + number, across all
   Chats), Milagre creates one: target that Chat, name `Babysit PR #<n>`, a new trigger kind for a pull request carrying
   the copied settings. The store today only lets schedule triggers target an existing Chat (`routines/store.cjs:689`);
   the PR trigger kind is allowed too. The name is reserved: `heartbeat_create` / `upsertHeartbeat`
   (`store.cjs:643`) must not replace a PR-triggered Heartbeat with a plain timed one of the same name.
3. **Poll.** A PR poller, shaped like `routines/linear-poller.cjs`, checks each watched PR on its interval with `gh`,
   reading what `pull-request.cjs` and `pull-request-review.cjs` already read: state, review decision, merge state,
   check rollup, review threads and comments (top-level PR comments too; bot reviewers count).
4. **Diff.** It compares against the last snapshot it stored. New means: a review or PR comment it hasn't handed over
   yet, a check that turned failed, a new conflict, or the branch falling behind (`mergeStateStatus` `BEHIND` where the
   repo reports it; otherwise compare the base branch head against the PR's merge base). Nothing new: no Run, nothing in
   the Chat.
5. **Agent's own comments.** Every reply the agent posts while babysitting ends with a hidden marker
   (`<!-- milagre-babysit -->`). The poller ignores comments carrying it. Comments the user posts as themselves, without
   the marker, still wake the agent, so the user can steer from GitHub.
6. **Run.** A Run sends a turn into the Chat: Milagre's prompt for the chosen level, a short summary of what changed,
   then the user's instructions. It uses the Chat's own permission mode (Victor's call): in Ask mode the user approves
   from desktop or phone. If the Chat is busy, the Run waits and retries like Linear comment Runs do
   (`scheduler.cjs:263-299`), not skipped like timed Heartbeats, so no change is dropped.
7. **Level is enforced.** During a babysit Run, Milagre denies commands the level doesn't allow, whatever the prompt or
   the user's instructions say: `git push` at levels 1 and 2; `gh` comment/reply writes below level 4; re-request review
   below level 5; resolving threads unless that switch is on; `gh pr merge` always. A denied command shows in the Chat as
   denied with the reason.
8. **Wrong branch.** If the Chat's Worktree isn't on the PR's head branch when a Run starts (the Chat moved on, or
   opened stacked PRs), that Run drops to **Report only** and says why. It never switches branches.
9. **Stop.** The poller ends the Heartbeat when merged/closed, green and approved, the time limit, or the attempt cap
   holds. "Approved" means `reviewDecision` is `APPROVED`, or null because the repo requires no review. With the time
   limit off, the Heartbeat's 30-day maximum still applies (GLOSSARY: every Heartbeat ends). The user's own rule is
   checked by the agent on each Run; when it holds, the agent ends the Heartbeat and says why. "Failed to fix the same
   problem" counts Runs handed the same failing check name, or the same review thread, that still fail or stay
   unresolved on the next poll.

## UI

- **Entry:** Settings › Experimental, Beta group, gets a **Babysit PRs** row: label, one-line description, "Off" or
  "On", and a chevron. Clicking it opens the Babysit PRs page inside Settings with an "Experimental › Babysit PRs"
  header and a back button. Graduating later moves the row to Settings › Routines (which already exists,
  `Settings.tsx:150, 851`).
- **Desktop page:** as in the design, four groups built from the existing Settings `Group` / `Row` pieces: Babysit PRs;
  When something needs fixing (the five levels, each with one pill of its steps joined by small arrows (fix → push → reply → re-request), a **Default** tag on Fix and push, then the
  Resolve threads switch); Stop babysitting when; Your instructions. **Reset all to defaults** sits on the first group's
  header.
- **Phone:** a Babysit PRs row in the phone's Experimental settings that pushes a Babysit PRs screen with the same
  groups, built from the app's own components (Victor rejects phone mockups that aren't).
- In the Chat, a babysit Heartbeat shows with the existing Heartbeat card; quiet polls leave nothing.

## Constraints

- Uses the user's own `gh` login on that Mac. No new credentials.
- Babysit Heartbeats are per Mac, like all Routines, and need Routines consent on that Mac.
- Copy follows GLOSSARY.md (Heartbeat, Run, Chat). Add a "Babysit" entry.

## Left to the builder

- Where the setting is stored (daemon settings next to the other Routine settings) and how desktop and phone read it.
- Trigger shape and poller internals: batching per repo, backoff, rate limits, snapshot format.
- Exact prompt wording per level.
- How the per-Run command guard plugs into each provider's tool approval path.
