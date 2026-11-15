---------------------------- MODULE Snooze ----------------------------
\* One Chat's Snooze (#1039, fixed in #1043), as the host, the desktop sidebar and the phone push see it.
\*   host:    packages/core/src/runtime.cjs: patchChat (receivedAt = needsUserCount, then editProject, then the wake
\*            for a question counted after receivedAt), publishAgentEvent (needsUserAt, wakeSnoozedChat), sendMessage
\*            (wakeSnoozedChat byUser); packages/core/src/snooze-sweep.cjs (the wake time)
\*   sidebar: apps/desktop/app/src/lib/snooze-pending.ts: snoozeChat (the mark, ANSWERED_MS once the latest patch is
\*            answered, PENDING_MS otherwise), settleSnoozePending, dropSnoozePending
\*   phone:   apps/daemon/src/mobile-push.cjs deliver(): reads snoozed_until through project:snapshot after the event;
\*            a finished turn of a snoozed Chat stays quiet, a failed one always goes out
\* One patch at a time: Snooze and Wake are not offered while one is on its way (the code allows several, and
\* snoozeChat's `latest` map makes only the newest one's answer count; this model does not cover that).

CONSTANT
  Break  \* "none" is the code as it is. Each other value is one broken variant, used to show that a rule can fail:
         \*   "noSaveWake"        patchChat does not wake a Chat asked while its Snooze was being saved (before #1043)
         \*   "dropFailedPush"    mobile-push drops a snoozed Chat's failed-turn push too (before #1043)
         \*   "markWaitsForRows"  an answered mark waits for agreeing rows or a minute (before #1043)
         \*   "pushIgnoresSnooze" mobile-push sends a snoozed Chat's finished-turn push

VARIABLES
  hostSnoozed,   \* the host has snoozed_until set
  turn,          \* "idle" | "running" | "asking" | "failed"
  needsYou,      \* a question or failure that came after your last Snooze click is open
  early,         \* that question or failure reached the host before your Snooze patch did (the known-open window)
  askedSince,    \* a question or failure was counted after the host received the Snooze patch it is saving
  wakeQueued,    \* wakeSnoozedChat is queued behind the Project's queue; not saved yet
  patch,         \* the sidebar's patch: "none" | "snooze" (on its way) | "snoozeHeld" (patchChat has it) | "wake"
  mark,          \* the sidebar's pending mark: "none" | "snooze" | "wake"
  markShort,     \* the host answered the mark's patch: the mark goes within ANSWERED_MS
  seen,          \* snoozed, in the host rows the sidebar last rendered
  push,          \* the phone push of this turn's end: "none" | "done" | "fail" | "doneSent" | "doneDropped" | "failSent" | "failDropped"
  endShown,      \* the sidebar showed the Chat snoozed when its turn finished
  endHost        \* the host had the Chat snoozed when its turn finished, and nothing woke it since

vars == <<hostSnoozed, turn, needsYou, early, askedSince, wakeQueued, patch, mark, markShort, seen, push, endShown, endHost>>

\* What the sidebar shows: the pending mark wins over the host rows (withSnoozePending).
shown == IF mark = "snooze" THEN TRUE ELSE IF mark = "wake" THEN FALSE ELSE seen

Init ==
  /\ hostSnoozed = FALSE
  /\ turn = "running"   \* a Chat at work: what Snooze is for
  /\ needsYou = FALSE
  /\ early = FALSE
  /\ askedSince = FALSE
  /\ wakeQueued = FALSE
  /\ patch = "none"
  /\ mark = "none"
  /\ markShort = FALSE
  /\ seen = FALSE
  /\ push = "none"
  /\ endShown = FALSE
  /\ endHost = FALSE

\* ---- you, in the sidebar ----

YouSnooze ==
  /\ ~shown /\ patch = "none"
  /\ mark' = "snooze" /\ markShort' = FALSE /\ patch' = "snooze"
  /\ needsYou' = FALSE /\ early' = FALSE   \* what is open now waits: "ask me later"
  /\ UNCHANGED <<hostSnoozed, turn, askedSince, wakeQueued, seen, push, endShown, endHost>>

YouWake ==
  /\ shown /\ patch = "none"
  /\ mark' = "wake" /\ markShort' = FALSE /\ patch' = "wake"
  /\ UNCHANGED <<hostSnoozed, turn, needsYou, early, askedSince, wakeQueued, seen, push, endShown, endHost>>

\* sendMessage: wakeSnoozedChat(byUser) on the host, dropSnoozePending in the sidebar.
YouSend ==
  /\ turn \in {"idle", "failed"} /\ patch = "none"
  /\ turn' = "running"
  /\ hostSnoozed' = FALSE /\ mark' = "none" /\ markShort' = FALSE
  /\ needsYou' = FALSE /\ early' = FALSE /\ push' = "none" /\ endShown' = FALSE /\ endHost' = FALSE
  /\ UNCHANGED <<askedSince, wakeQueued, patch, seen>>

YouAnswer ==
  /\ turn = "asking"
  /\ turn' = "running" /\ needsYou' = FALSE /\ early' = FALSE
  /\ UNCHANGED <<hostSnoozed, askedSince, wakeQueued, patch, mark, markShort, seen, push, endShown, endHost>>

\* ---- the host ----

\* patchChat starts: receivedAt = needsUserCount, then editProject waits in the Project's queue.
HostReceivesSnooze ==
  /\ patch = "snooze"
  /\ patch' = "snoozeHeld" /\ askedSince' = FALSE
  /\ UNCHANGED <<hostSnoozed, turn, needsYou, early, wakeQueued, mark, markShort, seen, push, endShown, endHost>>

\* editProject saves snoozed_until; a question counted since receivedAt queues the wake. The sidebar's await ends:
\* the mark is the latest call's, so it moves to ANSWERED_MS.
HostSavesSnooze ==
  /\ patch = "snoozeHeld"
  /\ hostSnoozed' = TRUE /\ patch' = "none"
  /\ wakeQueued' = (wakeQueued \/ (askedSince /\ Break # "noSaveWake"))
  /\ markShort' = (mark = "snooze" /\ Break # "markWaitsForRows")
  /\ UNCHANGED <<turn, needsYou, early, askedSince, mark, seen, push, endShown, endHost>>

HostSavesWake ==
  /\ patch = "wake"
  /\ hostSnoozed' = FALSE /\ patch' = "none" /\ endHost' = FALSE
  /\ markShort' = (mark = "wake" /\ Break # "markWaitsForRows")
  /\ UNCHANGED <<turn, needsYou, early, askedSince, wakeQueued, mark, seen, push, endShown>>

\* publishAgentEvent: needsUserAt = ++needsUserCount, then wakeSnoozedChat, which returns at once unless heldState has
\* snoozed_until now.
Asks(nextTurn) ==
  /\ turn' = nextTurn /\ needsYou' = TRUE
  /\ early' = (patch = "snooze")
  /\ askedSince' = (askedSince \/ patch = "snoozeHeld")
  /\ wakeQueued' = (wakeQueued \/ hostSnoozed)

AgentAsks ==
  /\ turn = "running"
  /\ Asks("asking")
  /\ UNCHANGED <<hostSnoozed, patch, mark, markShort, seen, push, endShown, endHost>>

AgentFails ==
  /\ turn = "running"
  /\ Asks("failed")
  /\ push' = "fail"
  /\ UNCHANGED <<hostSnoozed, patch, mark, markShort, seen, endShown, endHost>>

AgentFinishes ==
  /\ turn = "running"
  /\ turn' = "idle"
  /\ push' = "done" /\ endShown' = shown /\ endHost' = hostSnoozed
  /\ UNCHANGED <<hostSnoozed, needsYou, early, askedSince, wakeQueued, patch, mark, markShort, seen>>

HostWakes ==
  /\ wakeQueued
  /\ wakeQueued' = FALSE /\ hostSnoozed' = FALSE /\ endHost' = FALSE
  /\ UNCHANGED <<turn, needsYou, early, askedSince, patch, mark, markShort, seen, push, endShown>>

\* The sweep, once the wake time passes (30 minutes at least, so the sidebar has settled).
TimeComes ==
  /\ hostSnoozed /\ patch = "none" /\ mark = "none" /\ ~wakeQueued
  /\ hostSnoozed' = FALSE /\ endHost' = FALSE
  /\ UNCHANGED <<turn, needsYou, early, askedSince, wakeQueued, patch, mark, markShort, seen, push, endShown>>

\* mobile-push deliver(): reads snoozed_until, then sends or drops the end-of-turn push. Its project:snapshot waits in
\* the Project's queue behind a wake the same event queued. A failed turn's push always goes out.
PhoneReads ==
  /\ push \in {"done", "fail"} /\ ~wakeQueued
  /\ push' = IF push = "done"
               THEN (IF hostSnoozed /\ Break # "pushIgnoresSnooze" THEN "doneDropped" ELSE "doneSent")
               ELSE (IF hostSnoozed /\ Break = "dropFailedPush" THEN "failDropped" ELSE "failSent")
  /\ UNCHANGED <<hostSnoozed, turn, needsYou, early, askedSince, wakeQueued, patch, mark, markShort, seen, endShown, endHost>>

\* ---- the sidebar renders the host rows (settleSnoozePending) ----

SidebarRenders ==
  /\ seen # hostSnoozed
  /\ seen' = hostSnoozed
  /\ mark' = IF (mark = "snooze" /\ hostSnoozed) \/ (mark = "wake" /\ ~hostSnoozed) THEN "none" ELSE mark
  /\ markShort' = (markShort /\ mark' # "none")
  /\ UNCHANGED <<hostSnoozed, turn, needsYou, early, askedSince, wakeQueued, patch, push, endShown, endHost>>

\* The mark's timer: ANSWERED_MS (5 s) once answered, PENDING_MS (a minute) otherwise. Either way the sidebar has the
\* latest host rows by then (an assumption: rows arrive within 5 s of the answer).
MarkExpires ==
  /\ mark # "none" /\ patch = "none" /\ seen = hostSnoozed
  /\ mark' = "none" /\ markShort' = FALSE
  /\ UNCHANGED <<hostSnoozed, turn, needsYou, early, askedSince, wakeQueued, patch, seen, push, endShown, endHost>>

Next ==
  \/ YouSnooze \/ YouWake \/ YouSend \/ YouAnswer
  \/ HostReceivesSnooze \/ HostSavesSnooze \/ HostSavesWake
  \/ AgentAsks \/ AgentFails \/ AgentFinishes \/ HostWakes \/ TimeComes
  \/ PhoneReads
  \/ SidebarRenders \/ MarkExpires

Spec == Init /\ [][Next]_vars

\* ---- rules ----

\* Nothing on its way: no wake queued, no patch, the sidebar has the latest rows, and no answered mark is in its last
\* few seconds.
Settled == ~wakeQueued /\ patch = "none" /\ seen = hostSnoozed /\ ~markShort

\* A question or failure that came after you snoozed brings the Chat back to your list. Known-open window, left out on
\* purpose: one that reaches the host before the Snooze patch does. The host can't tell it from one you already saw,
\* and "ask me later" keeps those snoozed. The window is one network trip; NeedsYouShowsStrict shows it.
NeedsYouShows == (Settled /\ needsYou /\ ~early /\ turn \in {"asking", "failed"}) => ~shown
NeedsYouShowsStrict == (Settled /\ needsYou /\ turn \in {"asking", "failed"}) => ~shown

\* The host and your sidebar agree once nothing is on its way.
SidebarAgrees == Settled => (shown = hostSnoozed)

\* A failed turn reaches your phone.
FailureReachesPhone == push # "failDropped"

\* A turn that finishes while the computer has the Chat snoozed sends no push. Known-open window, left out on purpose:
\* a turn that finishes after you tap Snooze and before the computer saves it still pushes (the sidebar already showed
\* it snoozed). SnoozedFinishIsQuietStrict, worded on what the sidebar showed, shows it.
SnoozedFinishIsQuiet == ~(push = "doneSent" /\ endHost)
SnoozedFinishIsQuietStrict == ~(push = "doneSent" /\ endShown)

=============================================================================
