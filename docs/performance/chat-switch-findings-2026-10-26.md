# Chat-switch performance: measurements on the real desktop app (2026-10-26)

Setup (all throwaway, nothing of Victor's touched): worktree /Users/victor/.milagre/worktrees/milagre-ade/run-an-analysis-of-the-cag8 at 4cc31a83,
production renderer build (apps/desktop/dist) in Electron 44.5.1, profile A = $TMPDIR/chatperf/profileA, its host started by
$TMPDIR/chatperf/daemon.cjs (wraps runtime.invoke and computers:invoke with timings into <profile>/perf-timings.ndjson, repo code untouched).
Local Projects: "ade" = copy of Victor's milagre-ade .milagre (143 Chats, 1396 messages, 26 MB in-memory state, 14 MB chats.db, all Chats on one
Worktree), "events" = copy of rd-events (11 Chats). A seeded Named Link "Perf Link" (8 Chats, 197 messages, members ade+events).
Computer "B" = a second daemon ($TMPDIR/chatperf/profileB) paired through relay.milagre.cloud, with Projects "adeb" (same copy as ade) and "hg"
(happiergym, 20 Chats). Routes: LAN (ws://192.168.2.177:18798) in rounds 1-3, relay-only in round 4+.
Driver: $TMPDIR/chatperf/measure2.mjs clicks sidebar rows through CDP (real pointer events) and records the app's own `milagre:chat-switch`
performance measure (localStorage milagre.measureNavigation=1) plus a rAF watcher: `ready` = first frame where the target Chat's messages
are on screen (message element ids), `row` = sidebar row marked aria-current. Long tasks (>50 ms) via PerformanceObserver. Raw: results*.json.
14-core M-series Mac, otherwise mostly idle (load avg 4-8).

## 1. Time to painted, idle Mac (median of all rounds; ms)

| path                                                                                                                                          | n   | median | min | max |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------ | --- | --- |
| Local: Chat to Chat, same Project (parked or cold, 25-27 msgs)                                                                                | 10  | 42     | 25  | 131 |
| Local: cold Chat with 300 ms hover prefetch                                                                                                   | 5   | 39     | 37  | 49  |
| Link: Chat to Chat inside the open Link                                                                                                       | 7   | 44     | 20  | 48  |
| Remote (LAN or relay): Chat to Chat, same remote Project, parked                                                                              | 2   | 49     | 47  | 51  |
| Remote: Chat to Chat, same remote Project, cold                                                                                               | 10  | 68     | 62  | 82  |
| Remote: switch to another computer's Project (Chat cold)                                                                                      | 10  | 50     | 40  | 72  |
| Local: switch to the small Project (Chat cold)                                                                                                | 5   | 73     | 68  | 92  |
| Local: switch back to the big Project (26 MB state)                                                                                           | 15  | 67     | 15  | 132 |
| Link: open the Link from a Project (link:open)                                                                                                | 7   | 78     | 45  | 94  |
| Relay-only route (B reachable only through relay.milagre.cloud): paints are the same (28-71 ms) because the window paints from its last       |
| copy / parked transcript; the remote data arrives later: chat:messages 80-100 ms per page (vs 1-8 ms on LAN), media:read 60-300 ms per image. |
| No long tasks (>50 ms) on the renderer main thread in any switch.                                                                             |

## 2. Loaded Mac (10 busy worker threads on 14 cores, same plan)

In-Project switches stayed 27-50 ms. Project switches degraded: switch back to the big local Project 361 ms and 266 ms, to the small one
167 ms (idle: 24-98). The host log shows trivial handlers (terminal:list, project:branches, link:list) taking 200-270 ms at that moment and
chat:messages#8683 = 201 ms: the cold Chat's page read queued behind the host's Project-open work and the starved event loop.
(A first run also showed stalls caused by my own helper client taking whole states; fixed by opting it into lean patches before re-measuring.)

## 3. What a switch makes the hosts do (per switch, from perf-timings.ndjson)

- Local Chat-to-Chat, same Project: ~12-23 host calls: chat:messages (page, 0.1-3 ms local), chat:set-open, terminal:list, artifact:list,
  artifact:comments, checkpoint:list, worktree:pull-request + worktree:pull-requests (gh, 100-530 ms), browser:list/simulator:list polls.
- Local Project switch (canvas:open-project): ~29 calls: canvas:open-project (= openProject: resolveProject + readProject: git worktree list,
  reconcile, resumeInterrupted, titles.resume, routines sweep, recoverHandoffs, diffs.refresh of every Worktree with Chats, registry add,
  rememberProject), project:registry (30-100 ms: git rev-parse + worktree list per registered Project), project:branches (git), link:list,
  project:recent, skills:list (55-420 ms dir scan, 173 skills), agent:cli-status (130-900 ms, provider CLI), agent:models (130-1200 ms),
  usage:cached + usage:read (900-2400 ms, provider CLI), worktree:pull-request(s) (gh), canvas:links (90-230 ms: activeWorktrees of every
  registered Project), terminal:list, artifact:*, checkpoint:list, chat:set-open, project:image (215-1150 ms, gh api user), plus polls.
- Remote Project switch: ~60 calls counting both ends: the same burst is sent to computer B over the channel (B runs project:switch =
  openProject 160-460 ms, skills:list, agent:models, agent:cli-status, usage:_, worktree:pull-request(s), terminal:list, browser:list,
  simulator:list, artifact:_, checkpoint:list, designs:enabled:read), plus one media:read per image in the Chat (each = project:worktree-paths
  - project:chat-image on B + file read + base64; 30 images in Chat 8683 = 30 round trips, serialized, 4-110 ms each on LAN, 60-300 ms relay).
    project:switch on B also reorders B's recent-projects list and sets B's shownProjectPath (side effect on the other Mac).
- Open a Link: ~31 calls: link:open (30 ms here; recovers preparations, resumeInterrupted; runtime-level result 1.4-2.8 MB), project:recent x3,
  link:list x2, routines:list x2, canvas:links, skills:list, agent:cli-status, agent:models, usage:read, worktree:pull-request.
- Chat to Chat inside an open Link: 5 calls (chat:messages, terminal:list, browser:list...). Not measured by the app's own instrumentation:
  beginChatSwitch is only called in App.openChat/openCanvasChat, never by LinkWorkspace's pick.
- Startup with one paired computer: project:read for every remote Project (lean state 1.27 MB for the big one) and computers:remember of
  each copy into computers/<id>/cache.sqlite (computer-cache.cjs: 41 ms CPU in the host profile), project:image per remote Project.

## 4. Host CPU profile (daemon A, 110 s session with ~40 switches, 2.9 s busy)

Top self time: child_process spawn 929 ms (a third of all host CPU), computerName spawnSync (scutil) 59 ms (blocks the loop), git client
72 ms, tweetnacl 94 ms (relay crypto), computer-cache sqlite 41 ms, chat-db 49 ms, project-edits patchSession 25 ms, hydrate 18 ms, module
loading 168 ms (lazy requires on first use: agents/models loadSdk 22 ms on a switch).
spawn by caller: pull-request.cjs:108 (gh) 517 ms, git/client.cjs 378 ms, browsers-cdp.cjs run (browser:list poll) 26 ms, agents/command 14 ms,
readBranchPullRequest 12 ms, usage.cjs 5 ms, project-image githubAccount 3 ms. listedWorktrees 131 ms inclusive, 115 of them from
resolveProject (called by openProject and by projectRegistry().list() -> present(entry) for every registry entry).

## 5. In-process micro-benchmarks ($TMPDIR/chatperf/bench-host.mjs, bench-diff.mjs)

readProjectState(ade copy) 87 ms (26 MB); reconcileState + isDeepStrictEqual 0.9 ms; leanState 0.5 ms (1.27 MB lean JSON, stringify 1.6 ms);
JSON.stringify(whole 26 MB state) 39 ms (only for clients without lean patches); diffState one title change 0.3 ms.
Real repository (read-only git): activeWorktrees = 118 ms for 128 Worktrees; readDiffStat = 73 ms per Worktree (merge-base + diff --numstat +
untracked lines, 3 git spawns), 88 Worktrees have Chats with messages -> diffs.refresh after every Project open = ~1.6 s of git at 4 in flight;
discoverSkills 55 ms (173 skills).

## 6. Renderer CPU per switch (CDP Profiler, 100 us sampling, 700 ms window after the click)

Project switch back into the big Project from a remote one: 126-251 ms busy, spread over many small React tasks (propagateParentContextChanges,
updateProperties, measureScroll, getBoundingClientRect), no function above 7 ms: the whole-App re-render under adoptProject's flushSync.
Remote Project switch 122 ms; in-Project cold open 83-124 ms (parse + mount); in-Project parked revisit 41 ms.

## 7. Polls seen in the host log regardless of switching

simulator:list every 5 s; browser:list every 15 s (spawns a process: browsers-cdp run); usage:read about every 60 s (provider CLI, ~1 s).

## Candidate issues to verify (code paths)

C1 Every Project open (canvas:open-project / project:switch / project:read of an unloaded Project) runs diffs.refresh over every Worktree with
Chats (3 git spawns each) and a git worktree list; on Victor's real Project that is 88 Worktrees ~1.6 s of git per switch.
C2 project:registry (sidebar) and canvas:links re-run resolveProject/activeWorktrees for every registered Project on every switch.
C3 The renderer re-reads skills:list, agent:models, agent:cli-status, usage:read/cached, project:branches, worktree:pull-request(s),
project:image on every Project switch (and some on every Chat switch), each spawning a process; nothing is cached across switches.
C4 Remote Project opens use project:switch on the other Mac (full openProject + recents reorder + shownProjectPath) where the local path uses
canvas:open-project; both do the full readProject each time even when the Project is already loaded there.
C5 A remote Chat's images: one media:read round trip per image, serialized on one channel, with a project:worktree-paths check each, and
no host-side cache; over the relay a 30-image Chat takes seconds to fill.
C6 The same follow-up burst (terminal:list, browser:list, simulator:list, artifact:*, checkpoint:list, usage, skills, models, cli-status, PRs)
is sent to the paired computer on every remote switch (60 calls).
C7 computerName() uses spawnSync (scutil) on the host's event loop.
C8 Polls: simulator:list every 5 s and browser:list every 15 s (process spawn) run for every window all the time.
C9 In-Link Chat switches are not instrumented (beginChatSwitch missing in LinkWorkspace); the chat-switch measure over-reports Project
switches (129 ms measured vs 24 ms painted) because commitChatSwitch only fires on a later commit.
C10 The cold Chat's page read (chat:messages) shares the host's single event loop and the client's MAX_PENDING=32 slot pool with the burst
above, so on a loaded Mac it waits behind spawns and git; the page read has no priority.
C11 Startup with other computers: every remote Project's full lean state is read and written to the sqlite copy; project:image per Project.
