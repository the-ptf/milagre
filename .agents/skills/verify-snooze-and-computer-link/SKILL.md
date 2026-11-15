---
name: verify-snooze-and-computer-link
description: Model-check Milagre's Snooze (host wake, desktop sidebar mark, phone push) and the link to a paired computer (reconnect, move to the LAN, calls made meanwhile) with TLA+. Use before and after any change to runtime.cjs patchChat or its Snooze wake, snooze-pending.ts, mobile-push.cjs, computers.cjs, runtime-client.cjs's reconnect, peer-client.cjs closeWhenIdle, or route-supervisor.mjs.
---

# Verify Snooze and the computer link

Two small TLA+ models of code where events race: tests run one order, the model checker runs every order. Each model
names the code it describes in its header comments, and each action in it is one run of JavaScript between two waits.

Read every TLC result with the pstack `/statechart` skill. It turns a broken rule into its shortest path in plain words
and draws the chart when a model passes. Don't copy its commands here: they change between releases.

## The rules

**Snooze** (`snooze/Snooze.tla`). One Chat, the host, the desktop sidebar, the phone push.

| Rule                   | In plain words                                                                       | Harm when it breaks                                   |
| ---------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `NeedsYouShows`        | A question or failure that came after you snoozed brings the Chat back to your list. | The Chat sleeps with a question open until its timer. |
| `SidebarAgrees`        | Once nothing is on its way, the sidebar shows what the host has.                     | A woken Chat stays in Snoozed.                        |
| `FailureReachesPhone`  | A failed turn reaches your phone.                                                    | You never hear that the work stopped.                 |
| `SnoozedFinishIsQuiet` | A turn that finishes while the computer has the Chat snoozed sends no push.          | Snooze doesn't quiet the phone.                       |

Two windows stay open on purpose, and each has a strict rule that shows it (`snooze/Snooze-known-open.cfg`):

- `NeedsYouShowsStrict`: a question that reaches the host before the Snooze patch does keeps the Chat snoozed. The host
  can't tell it from a question you already saw, and Snooze means "ask me later" for those. The window is one network
  trip. `NeedsYouShows` leaves out exactly these questions (`early`).
- `SnoozedFinishIsQuietStrict`: a turn that finishes after you tap Snooze and before the computer saves it still
  pushes. `SnoozedFinishIsQuiet` counts only finishes after the save (`endHost`).

Don't widen either window without the same kind of reason written next to the rule.

**Computer link** (`computer-link/ComputerLink.tla`). One paired computer as this desktop reaches it, and one call to it.

| Rule                       | In plain words                                                                                                                                      | Harm when it breaks                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `CallWaitsWhileComingBack` | A call made while the computer is coming back waits for it, and fails as offline only once it reads Offline, Refused or Off, or after its own wait. | Sends fail with "is offline" during a blip (the #733 incident).         |
| `OnlineCallGoesThrough`    | A call to a computer that reads Online is sent, or waits through a move to the LAN.                                                                 | Every call fails with "Milagre host is disconnected".                   |
| `OnlineMeansConnected`     | Settings shows Online only while the computer is connected or moving to the LAN.                                                                    | The computer looks fine and nothing works.                              |
| `SwitchHoldEnds`           | Calls wait for a move to the LAN only while the move is under way.                                                                                  | Every call waits 10 s first.                                            |
| `RefusedIsQuiet`           | A computer that turned this desktop away is not dialed again until it is paired again.                                                              | Redials keep relay rooms awake (the 2026-11-10 Durable Objects outage). |
| `OffIsQuiet`               | A computer you turned off or removed is not dialed.                                                                                                 | Same.                                                                   |

## Run it

From the repo root:

```sh
node .agents/skills/verify-snooze-and-computer-link/check.mjs              # both models, about 30 s
node .agents/skills/verify-snooze-and-computer-link/check.mjs computer-link # or snooze
```

It needs Java 11 or later (`$JAVA`, else `java`). TLC is `$TLA2TOOLS` if set, else v1.7.4, downloaded once to
`~/.cache/milagre-tlc` and checked against its SHA-256. Every line must read `ok`. Besides the code as it is, the
script runs each known-open window and each broken variant (the `Break` constant in each model), and expects each to
break its named rules. That is how you know every rule can still fail. A `FAIL` line names what it found and what it
expected.

## When a change touches covered code

1. Run the check before your change and keep the output.
2. Read your diff against each model. Ask what each changed line does to an action: a new wait splits one action in
   two, a moved check changes a guard, a new caller writes the same state. Change the model to describe the new code,
   from the code, before you rerun. Keep one indivisible run of JavaScript as one action.
3. Rerun. If a rule breaks, read the path with `/statechart` (the views are `snooze/view-sidebar.mjs`,
   `snooze/view-phone.mjs` and `computer-link/view.mjs`), then replay the path against the real code, one step per
   action, as a test. The suites that already drive these paths: `apps/desktop/electron/computers.test.cjs`
   (`fakeMac`, with `mac.hold` to hold any reply), `packages/core/src/runtime-snooze.test.cjs`,
   `apps/desktop/app/src/lib/snooze-pending.test.ts`, `apps/daemon/src/mobile-push.test.cjs`.
   - The replay reproduces it: it is a bug. Report it with the path in the code's words. Fix it only if asked, or if it
     is small and clear, with the replay as a regression test that fails without the fix.
   - The replay doesn't reproduce it: assume the model is wrong. Find the step the code can't take and fix the model.
4. Never weaken a rule or remove a case from `check.mjs` to make it pass. A promise that changed on purpose changes its
   rule, with the evidence (commit, test, doc) written next to it.
5. When a change adds a new guard a rule depends on, add a `Break` value that removes it and a case in `check.mjs`.
6. Move the sync commit below forward only after the models describe the code at the new commit and the check passes.

## Coverage and sync

Last confirmed against the code at **6191e1f73** (both models).

| Model         | Code it describes                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Snooze        | `packages/core/src/runtime.cjs`: `patchChat` (receivedAt, the wake after editProject), `publishAgentEvent` (needsUserAt, wakeSnoozedChat), `wakeSnoozedChat`, `sendMessage`'s wake; `packages/core/src/snooze-sweep.cjs`; `apps/desktop/app/src/lib/snooze-pending.ts` (`snoozeChat`, `settleSnoozePending`, `dropSnoozePending`); `apps/daemon/src/mobile-push.cjs` `deliver()`                                                                                         |
| Computer link | `apps/daemon/src/computers.cjs` (`start`, `connectRoute`, `backoff`, `online`, `down`, `refuse`, `stop`, `moveToLan`, `redialFor`, `invoke`, the supervisor subscriber); `apps/daemon/src/runtime-client.cjs` (`connectDesktopRuntime`: `attach`'s close handler, `scheduleReconnect`, `reconnect`); `apps/daemon/src/peer-client.cjs` (`closeWhenIdle`, `closeIfIdle`, `keepOpen`, `receive`); `packages/shared/src/route-supervisor.mjs` (`walk`, `lost`, `subscribe`) |

To see what changed since: `git log 6191e1f73..HEAD -- <the files above>`.

## Bounds and what the models leave out

- Both models are small and finite: one Chat, one paired computer, one call. TLC checks every order of their steps,
  so a pass covers the model, not the whole app.
- Time is not modeled: any timer may fire at any moment. A rule that depends on how long something takes is out of
  reach. The models assume the sidebar has the host's latest rows by the time a mark's timer fires (5 s once answered,
  a minute otherwise), and that the Snooze sweep runs 30 minutes or more after a Snooze.
- Snooze: one patch at a time (the code allows several; `snoozeChat`'s `latest` map makes only the newest answer
  count, and no rule checks it). The phone's own pending marks, Done, and Routines are not modeled.
- Computer link: pairing (`add`), a host too old for the desktop (`hostOutdated`, which says connected before
  `entry.runtime` is set), the per-call `peer:routes` answer, several LAN addresses, Browser streams, and the backoff
  step lengths (covered by `computers.test.cjs`) are not modeled. `entry.switching` is not a variable: the close that
  sets it and the `down()` that spends it are always one step.
- Charts: the full models are over `/statechart`'s 500-state chart budget, so a run draws only bug paths.
  `computer-link/chart.cfg` draws the link alone (no call, nobody turning it off).
