# Linear integration

Date: 2026-10-08. Status: approved design, awaiting spec review.

## Goal

A Linear issue can be the start of a Chat and stays visible on the Worktree that works on it. Pick an issue and
Milagre makes the Worktree on Linear's own branch name and sends the issue as the first message. Every Worktree
whose branch names an issue shows that issue's key and status next to its PR chip. An existing Worktree can be
linked to an issue by hand.

Milagre never writes to Linear. Status changes come from Linear's GitHub integration, which links a branch and
its PR to an issue when the branch name contains the issue key and moves the issue on push, PR open and merge.
Using Linear's `branchName` is what makes that work, so the branch name is the link.

## Decisions

| Question | Decision |
| --- | --- |
| First features | Start a Chat from an issue, show the issue on its Worktree, link an existing Worktree. No agent tools for Linear yet. |
| Status sync | Left to Linear's GitHub integration. Milagre only reads. |
| Link mechanism | The branch name. A stored link only when the branch can't be renamed (PR already open). |
| Auth | OAuth app with PKCE, no client secret. Scope `read`. |
| Where you connect | On the Mac only. The daemon holds the token; phones use it through the daemon. |
| Picker contents | Issues assigned to me in started or unstarted states, newest first; typing searches the workspace. |
| Picking an issue | Starts the Chat at once: creates the Worktree and sends the issue as the first message. |
| Audience | All users, behind Settings › Experimental › Linear (off by default) until it settles. |
| Platforms | Desktop and mobile in each PR. Mobile is JS only and ships over the air. |

## Domain

"Linear issue" joins `GLOSSARY.md`: an issue in the Linear workspace connected on a Computer, named by its key
(`ENG-123`). A Worktree has at most one; it is the stored link when there is one, else the first key in the
Worktree's branch name that matches one of the workspace's team keys. The issue belongs to Linear; Milagre
only shows it.

## Connection

New folder `packages/core/src/linear/`, daemon side only.

- `oauth.cjs`: PKCE authorization code flow. `linear:connect` starts a loopback HTTP server on `127.0.0.1`,
  opens `https://linear.app/oauth/authorize` in the default browser with `scope=read`, a `state` value and the
  code challenge, waits up to 5 minutes for the callback, then exchanges the code at
  `https://api.linear.app/oauth/token` with `client_id` and the code verifier. The server closes after one
  callback or the timeout.
- `token-store.cjs`: `{ accessToken, refreshToken, expiresAt, viewer: { name, email }, organization: { name, urlKey } }`
  in one file under the Milagre data folder, written and checked with `private-files.cjs` (0600, owner only),
  the way `accounts.cjs` stores provider sign-ins.
- `client.cjs`: GraphQL POST to `https://api.linear.app/graphql`. Refreshes the access token when it expires
  within 5 minutes (access tokens last 24 hours; each refresh returns a new refresh token, saved before use).
  A 401 after a refresh, or a failed refresh, clears the token and reports disconnected. The API base comes
  from `MILAGRE_LINEAR_API` when set, for tests.
- The OAuth `client_id` ships in the app (`packages/core/src/linear/config.cjs`). Victor registers the app in
  Linear › Settings › API › OAuth applications.
- Open item, settled while registering: whether Linear accepts any loopback port in the callback URL. If not,
  the server listens on one fixed port and `linear:connect` fails with "Port N is in use; close the app using
  it and try again" when it's taken.

Commands: `linear:status` (`{ connected: false }` or `{ connected: true, viewer, organization }`),
`linear:connect`, `linear:disconnect` (deletes the file, then revokes at `https://api.linear.app/oauth/revoke`
on a best-effort basis). A second `linear:connect` while one is waiting cancels the first and starts again, since
the user may have closed the browser tab and the callback port is fixed. Status changes emit
`linear:status-changed` to desktop windows. Phones get no daemon events outside an open Project, so phone
Settings re-reads status on focus. Phones may call `linear:status` and `linear:enabled:*`, never connect or
disconnect.

UI:

- Desktop Settings gets a Linear section: Connect button, or "Connected as Victor to Acme" with Disconnect.
- Phone Settings shows the same status. When disconnected it reads "Connect Linear from Settings on your Mac"
  with no button.
- The toggle is stored by the daemon (`linear:enabled:read` / `linear:enabled:save`, in
  `<dataDir>/linear/settings.json`), the way the main sync default is, so the Mac and its phones share it.
  `sidebarAllProjects` can't be the model: it lives in the desktop's localStorage. A confined phone reads it but
  can't change it. While it is off, the Linear connection controls are hidden on both platforms.

## Issues

`issues.cjs` on top of `client.cjs`:

- `listMine({ first: 50 })`: `viewer.assignedIssues` filtered to state types `started` and `unstarted`,
  ordered by `updatedAt` descending.
- `search(text, { first: 25 })`: `searchIssues` across the workspace. A query shaped like a key (`eng-123`)
  also tries an exact `issue(id:)` lookup and puts that first.
- `byKeys(keys)`: one query for up to 50 keys.
- `teamKeys()`: the workspace's team keys, cached for 10 minutes, used to recognize keys in branch names.

Every issue reaches clients as:

```ts
interface LinearIssue {
  key: string;          // "ENG-123"
  title: string;
  url: string;
  branchName: string;   // Linear's suggestion, e.g. "victor/eng-123-fix-login"
  description?: string; // markdown, only in picker results and on start
  state: { name: string; type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"; color: string };
}
```

Commands: `linear:issues` (`{ query?: string }` → mine or search results), `linear:issues-for`
(`keys: string[]` → `Record<key, LinearIssue | null>`), with a 60 second cache per key the way
`createPullRequestReader` batches PR reads. Every command returns `{ error: "not-connected" }` when there is
no token, and a short message string on network or API errors; none of them throw into the renderer.

## Start a Chat from an issue

- The new-Chat composer (desktop `ChatComposer.tsx`, mobile composer) gets a Linear button when the feature
  is on. It opens the issue picker: my issues by default, search as you type, each row showing key, title and
  status. Not connected: the picker shows "Connect Linear in Settings" (on the phone: "on your Mac").
- Picking an issue starts the Chat at once. The first message is:

  ```
  Work on Linear issue ENG-123: <title>

  <description>

  <url>
  ```

  Anything already typed in the composer is appended after the URL.
- `worktree:create` takes an optional `issueKey`. The daemon reads the issue again (never trusting a branch
  name from the client), and `createWorktree` gets `branch: issue.branchName`. If that branch already exists,
  it becomes `<branchName>-<suffix>`; the key stays in the name either way. The folder is
  `<last segment of the branch>-<suffix>` under the usual root. `nameWorktree` (the Haiku rename) is skipped.
- `branchName` is validated with `git check-ref-format --branch` before use; an invalid one falls back to
  `<key lowercased>-<slug of title>`.

## Issue chip

- `linear-links.cjs` resolves each Worktree's issue key: the stored `linear.key` when present, else the first
  match of `/(?:^|[\/_-])([a-z][a-z0-9]{0,6}-\d+)(?=$|[\/_-])/gi` in the branch whose prefix is one of
  `teamKeys()`. Matching only known team keys keeps `utf-8` or `sha-256` from looking like issues.
- `Worktree` in `packages/shared/src/model.ts` gains `linear?: { key: string; stored?: boolean }`, filled by
  the daemon when it lists Worktrees, so clients know the key without parsing branches.
- Desktop: a `useWorktreeLinearIssues` hook (shaped like `useWorktreePullRequests.ts`) reads
  `linear:issues-for` for the visible Worktrees. Mobile: the same in a `use-linear-issues.ts` hook.
- The chip shows `ENG-123 · In Progress`, its dot in the state's color, next to the PR chip on the Worktree
  row, in the hover card and in the Chat header, on both platforms. Tapping opens the issue URL (desktop:
  `shell.openExternal`; phone: `Linking.openURL`). An issue that no longer exists hides the chip.

## Link an existing Worktree

- "Link issue…" in the Worktree's menu (desktop context menu, phone action menu) opens the same
  picker; "Unlink issue" appears when a stored link exists.
- `worktree:link-issue { projectPath, worktreeId, key }`:
  - When the branch starts with `milagre/` and `readPullRequest` finds no open PR, the branch is renamed to
    the issue's `branchName` (folder untouched, as `renameWorktreeBranch` already does) and nothing is
    stored, since the branch now carries the link.
  - Otherwise the link is stored on the Worktree as `linear: { key, stored: true }` in project state. The chip
    then adds the hint "Add `Fixes ENG-123` to the PR so Linear tracks it" in its hover card and on the
    phone's issue sheet.
- `worktree:unlink-issue` clears the stored link and suppresses issue detection from the branch name until
  another issue is linked. A renamed branch is never renamed back.

## Errors

| Case | Behavior |
| --- | --- |
| Not connected | Picker shows where to connect; no chips; menu item disabled with the same hint. |
| Token revoked or refresh fails | Token file deleted, `linear:status-changed` emitted, chips hide, Settings shows Connect. |
| Offline or Linear down | Chips keep the last cached issue; the picker shows the error inline with Retry. |
| Rate limited (HTTP 429 / `RATELIMITED`) | Same as offline, and no new request for 60 seconds. |
| Picked issue deleted before start | `worktree:create` fails with "ENG-123 no longer exists in Linear" and creates nothing. |
| OAuth callback with wrong `state` (a stale tab) | Ignored; the tab says to start again and the open attempt keeps waiting. |
| Linear returns an error to the callback (user pressed Cancel) | Connect fails with Linear's message; nothing saved. |
| User closes the browser tab | The attempt waits 5 minutes, or the next Connect replaces it at once. |

## Testing

- Unit (`node --test`, fake `fetch`): PKCE challenge and state check, token refresh and its rotation,
  disconnect on 401, `listMine` / `search` / `byKeys` query shapes, key parsing against team keys,
  `branchName` validation and the collision suffix, `worktree:link-issue` rename vs store.
- Runtime: `worktree:create` with `issueKey` creates the branch from the issue and skips Haiku naming.
- Electron check `scripts/test-linear.cjs` against a local mock of Linear's GraphQL and OAuth endpoints
  (`MILAGRE_LINEAR_API`): connect, start a Chat from an issue, chip on the row, link an existing Worktree.
  Screenshots via `MILAGRE_SCREENSHOT_DIR` for each PR.
- Mobile: hook and chip tests in `apps/mobile/src`, then the dev build on the Designs QA simulator.

## Delivery

Four PRs, each desktop and mobile together, each behind the Experimental toggle:

1. Connection: OAuth, token store, client, Settings on both platforms, Experimental toggle.
2. Start a Chat from an issue: picker, `worktree:create` with `issueKey`.
3. Issue chip: key resolution, `Worktree.linear`, chips on both platforms.
4. Link an existing Worktree: menu items, rename or store, PR hint.

No PR changes the mobile runtime fingerprint (no native modules; `Linking` is already in React Native), so
each ships as an OTA update.

## Out of scope

Agent tools that read or comment on the issue, Milagre moving issue status, creating issues from Milagre,
mapping Projects to Linear teams, and connecting from the phone.

## Several workspaces (added 2026-10-09, PR #360)

A Computer can connect more than one Linear workspace. Each is named by its URL key (`acme`) and keeps its own
token in `linear/workspaces/<key>.json`; the single `linear/token.json` from before moves there on first read.
Signing in to a workspace already connected replaces its token and revokes the old grant. Settings lists one row
per workspace with its own Disconnect, plus Add workspace. The issue picker shows a tab per workspace (only with
two or more) and opens on the last one used. Every issue carries `workspace`; a Worktree stores
`linearWorkspace` next to `linearIssue`, and an older link without it resolves through the workspace whose team
keys own the key's prefix. Branch names are matched against each workspace's team keys in connection order.
