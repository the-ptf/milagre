--------------------------- MODULE ComputerLink ---------------------------
\* One paired computer as this desktop reaches it (Settings > Devices > Other computers), and one call made to it.
\*   apps/daemon/src/computers.cjs        start, connectRoute, online, down, refuse, stop, moveToLan, redialFor, invoke
\*   apps/daemon/src/runtime-client.cjs   connectDesktopRuntime: attach's close handler, scheduleReconnect, reconnect
\*   apps/daemon/src/peer-client.cjs      closeWhenIdle / closeIfIdle (runs right after a reply resolves), keepOpen
\*   packages/shared/src/route-supervisor.mjs  the LAN channel the supervisor holds, subscribe, lost
\* Each action is one run of JavaScript between two waits on the network or a timer: the microtasks that follow a
\* step (a resolved call, a rejected one, a released wait) belong to that step. Time is not modeled: any timer may
\* fire at any moment.

CONSTANT
  Break  \* "none" is the code as it is. Each other value is one broken variant, used to show that a rule can fail:
         \*   "moveDuringFirstCalls" moveToLan without its entry.live check (the code before this model)
         \*   "noBlipWait"           redialFor does not wait for a computer that reads Connecting or Reconnecting
         \*   "onlineKeepsHold"      online() does not call recovered()
         \*   "refuseKeepsDialing"   refuse() leaves the runtime retrying
         \*   "offKeepsDialing"      stop() leaves a scheduled redial in place

MoveOnlyLive == Break # "moveDuringFirstCalls"

VARIABLES
  shown,       \* entry.state, what Settings shows: "connecting" | "online" | "reconnecting" | "offline" | "refused" | "off"
  link,         \* where the runtime's connection is:
                \*   "waitTimer"   runtime-client's scheduleReconnect waits (no entry.wake)
                \*   "waitBackoff" connectRoute's backoff(), or start()'s retryTimer: entry.wake is set
                \*   "dialing"     connectRoute's LAN wait (atMost(supervisor.check(), lanWaitMs))
                \*   "hello"       connectRoute dials the relay (connectPeer)
                \*   "opening"     the first calls on the new channel (state patches, project:open, snapshot pages)
                \*   "lastCall"    the last of those calls is out (the last daemon:snapshot-page; takeStatePatches at start)
                \*   "up"          connected, the first calls done
                \*   "dead"        entry.runtime is set, its channel is closed, and no reconnect is scheduled
                \*   "stopped"     refused or turned off: nothing dials
  runtime,      \* entry.runtime is set (FALSE until the first start succeeds)
  via,          \* the channel the runtime holds: "none" | "relay" | "lan"
  lanOpen,      \* the route supervisor holds an open LAN channel that no runtime took yet
  closeAsked,   \* closeWhenIdle waits on the relay channel (moveToLan)
  busy,         \* a call is out on the channel (online()'s learnRoutes peer:routes, or your call)
  recovery,     \* entry.recovery: a call made now waits for a move to the LAN (up to switchWaitMs)
  offlineTimer, \* down() started the timer that turns Reconnecting into Offline (offlineAfterMs)
  failed,       \* entry.failures > 0: the runtime's next connectRoute backs off first
  peer,         \* the other computer: "awake" | "asleep" (its relay room says offline) | "away" (it removed this Mac)
  call,         \* your call (invoke): "none" | "waitSwitch" | "waitOnline" | "sent" | "notSent" | "offline" | "offlineEarly"
  ranOut        \* the call's own wait (switchWaitMs or reconnectWaitMs) ran out

vars == <<shown, link, runtime, via, lanOpen, closeAsked, busy, recovery, offlineTimer, failed, peer, call, ranOut>>

\* entry.switching is left out: the close that sets it (closeWhenIdle's beforeClose) and the down() that spends it
\* happen in one step every time (peer-client emits "close" synchronously; a failed first call rejects in a microtask),
\* and online() clears it.

\* ---- your call (invoke) ----

\* invoke's last check: `!entry.runtime || entry.state !== "online"` fails as "<name> is offline.", else
\* runtime.invoke, which throws "Milagre host is disconnected. Your command was not sent." with no live channel.
Check(sh, rt, lk) ==
  IF rt /\ sh = "online" THEN (IF lk = "up" THEN "sent" ELSE "notSent")
  ELSE IF sh \in {"offline", "refused", "off"} THEN "offline" ELSE "offlineEarly"

\* redialFor: Connecting or Reconnecting waits for the computer; Offline wakes a backed-off redial and waits.
Proceed(sh, rt, lk) ==
  IF (sh \in {"connecting", "reconnecting"} /\ Break # "noBlipWait") \/ (sh = "offline" /\ lk = "waitBackoff")
    THEN "waitOnline" ELSE Check(sh, rt, lk)

\* Where a waiting call goes after a step: the switch it waited on ended (recovered()), or the computer released it
\* (online, the offline timer, refuse, stop). It runs on in a microtask, so it sees the state the whole step left.
NextCall(sh, rt, lk, rec, released) ==
  CASE call = "waitSwitch" /\ ~rec -> Proceed(sh, rt, lk)
    [] call = "waitOnline" /\ released -> Check(sh, rt, lk)
    [] OTHER -> call

\* Sets call' and busy' for a step whose other variables are already primed.
CallAfter(released, b) ==
  /\ call' = NextCall(shown', runtime', link', recovery', released)
  /\ busy' = (b \/ (call' = "sent" /\ call # "sent"))

\* down(): recovered(); Reconnecting (and its offline timer) unless it already reads Reconnecting or Offline.
DownShown == IF shown \in {"reconnecting", "offline"} THEN shown ELSE "reconnecting"
DownTimer == IF shown \in {"reconnecting", "offline"} THEN offlineTimer ELSE TRUE
\* Where a failed connection waits: the runtime's own reconnect timer, or start()'s retry before a runtime exists.
Retry == IF runtime THEN "waitTimer" ELSE "waitBackoff"

Init ==
  /\ shown = "connecting"
  /\ link = "dialing"
  /\ runtime = FALSE
  /\ via = "none"
  /\ lanOpen = FALSE
  /\ closeAsked = FALSE
  /\ busy = FALSE
  /\ recovery = FALSE
  /\ offlineTimer = FALSE
  /\ failed = FALSE
  /\ peer = "awake"
  /\ call = "none"
  /\ ranOut = FALSE

\* ---- connecting: connectRoute, then the runtime's first calls ----

\* A runtime's reconnect makes several first calls; the first start makes one (takeStatePatches: the hello already
\* carries daemon:status), which is also its last.
FirstCalls == IF runtime THEN "opening" ELSE "lastCall"

\* After the LAN wait: the LAN channel the supervisor holds, else a relay dial.
ChooseRoute ==
  /\ link = "dialing"
  /\ IF lanOpen
       THEN /\ via' = "lan" /\ lanOpen' = FALSE /\ link' = FirstCalls
       ELSE /\ link' = "hello" /\ UNCHANGED <<via, lanOpen>>
  /\ UNCHANGED <<shown, runtime, closeAsked, busy, recovery, offlineTimer, failed, peer, call, ranOut>>

RelayAnswers ==
  /\ link = "hello" /\ peer = "awake"
  /\ via' = "relay" /\ link' = FirstCalls
  /\ UNCHANGED <<shown, runtime, lanOpen, closeAsked, busy, recovery, offlineTimer, failed, peer, call, ranOut>>

\* The relay says the computer is offline: connectRoute throws, then down() (the runtime's catch, or start()'s).
RelaySaysOffline ==
  /\ link = "hello" /\ peer = "asleep"
  /\ shown' = DownShown /\ offlineTimer' = DownTimer /\ recovery' = FALSE
  /\ link' = Retry
  /\ UNCHANGED <<runtime, via, lanOpen, closeAsked, failed, peer, ranOut>>
  /\ CallAfter(FALSE, busy)

\* A refusal retrying can't fix: refuse() stops the runtime and the supervisor and releases waiting calls.
RelayTurnsAway ==
  /\ link = "hello" /\ peer = "away"
  /\ shown' = "refused" /\ runtime' = FALSE /\ via' = "none"
  /\ link' = IF Break = "refuseKeepsDialing" THEN Retry ELSE "stopped"
  /\ lanOpen' = FALSE /\ closeAsked' = FALSE /\ recovery' = FALSE /\ offlineTimer' = FALSE
  /\ UNCHANGED <<failed, peer, ranOut>>
  /\ CallAfter(TRUE, FALSE)

RecoveryGoesOn ==
  /\ link = "opening" /\ ~closeAsked
  /\ link' = "lastCall"
  /\ UNCHANGED <<shown, runtime, via, lanOpen, closeAsked, busy, recovery, offlineTimer, failed, peer, call, ranOut>>

\* The last first call answers: online(). learnRoutes puts peer:routes out before moveToLan looks, so a LAN channel
\* open now is asked to take over once the relay channel is idle.
Opens ==
  /\ link = "lastCall" /\ ~closeAsked
  /\ link' = "up" /\ runtime' = TRUE /\ shown' = "online"
  /\ recovery' = (Break = "onlineKeepsHold" /\ recovery) /\ offlineTimer' = FALSE /\ failed' = FALSE
  /\ closeAsked' = (via = "relay" /\ lanOpen)
  /\ UNCHANGED <<via, lanOpen, peer, ranOut>>
  /\ CallAfter(TRUE, TRUE)

\* Reached only with MoveOnlyLive = FALSE. closeWhenIdle on a relay channel still in a reconnect's first calls closes
\* it right after a reply: closeIfIdle runs before the next call goes out. The close sets entry.switching and
\* entry.recovery, runtime-client's close handler says disconnected (that down() is spent as the switch's), the next
\* first call fails, and the reconnect's catch says disconnected again: a real down(), and the runtime retries.
SwitchClosesEarly ==
  /\ link = "opening" /\ closeAsked
  /\ via' = "none" /\ closeAsked' = FALSE
  /\ shown' = DownShown /\ offlineTimer' = DownTimer /\ recovery' = FALSE
  /\ link' = "waitTimer"
  /\ UNCHANGED <<runtime, lanOpen, failed, peer, ranOut>>
  /\ CallAfter(FALSE, busy)

\* Reached only with MoveOnlyLive = FALSE. The same close on the answer to the LAST first call. runtime-client's close handler runs while `recovering` is
\* still true, so it schedules no reconnect; at start, attach() has not run yet and the close goes unheard. The first
\* calls then finish on the closed channel and say connected: online(). learnRoutes fails at once; moveToLan finds no
\* client. Nothing is left to reconnect it.
SwitchClosesLast ==
  /\ link = "lastCall" /\ closeAsked
  /\ via' = "none" /\ closeAsked' = FALSE
  /\ link' = "dead" /\ runtime' = TRUE /\ shown' = "online"
  /\ recovery' = FALSE /\ offlineTimer' = FALSE /\ failed' = FALSE
  /\ UNCHANGED <<lanOpen, peer, ranOut>>
  /\ CallAfter(TRUE, FALSE)

\* ---- a connected relay channel moves to the LAN (moveToLan) ----

\* closeWhenIdle on an idle connected relay channel closes it now. down() is spent as the switch's, Online stays,
\* calls wait for entry.recovery, and the runtime reconnects (to the LAN) after its timer.
SwitchNow ==
  /\ via' = "none" /\ closeAsked' = FALSE /\ recovery' = TRUE /\ link' = "waitTimer"

\* The supervisor opens a LAN channel; its subscriber moves a runtime on the relay there (moveToLan). The channel is
\* entry.live only once online() ran on it (link "up"); one still in its first calls moves when online() calls moveToLan.
LanOpens ==
  /\ ~lanOpen /\ peer = "awake" /\ link # "stopped" /\ via # "lan"
  /\ lanOpen' = TRUE
  /\ IF via = "relay" /\ link = "up" /\ ~busy
       THEN /\ SwitchNow
            /\ UNCHANGED <<shown, runtime, busy, offlineTimer, failed, peer, call, ranOut>>
       ELSE /\ closeAsked' = (closeAsked \/ (via = "relay" /\ (link = "up" \/ ~MoveOnlyLive)))
            /\ UNCHANGED <<shown, link, runtime, via, busy, recovery, offlineTimer, failed, peer, call, ranOut>>

\* The LAN channel no runtime took goes away: supervisor lost(), and the subscriber takes back closeWhenIdle (keepOpen).
LanGoes ==
  /\ lanOpen
  /\ lanOpen' = FALSE /\ closeAsked' = FALSE
  /\ UNCHANGED <<shown, link, runtime, via, busy, recovery, offlineTimer, failed, peer, call, ranOut>>

\* A call on the connected channel answers; closeIfIdle closes a channel that waits to move to the LAN.
ReplyArrives ==
  /\ busy /\ busy' = FALSE
  /\ IF closeAsked /\ via = "relay" /\ link = "up"
       THEN /\ SwitchNow
            /\ UNCHANGED <<shown, runtime, lanOpen, offlineTimer, failed, peer, call, ranOut>>
       ELSE UNCHANGED <<shown, link, runtime, via, lanOpen, closeAsked, recovery, offlineTimer, failed, peer, call, ranOut>>

\* ---- losing the computer ----

\* The channel drops (the network, the other computer sleeping): the runtime's close handler or a failed first call,
\* then down().
ChannelDrops ==
  /\ via # "none" /\ link \in {"opening", "lastCall", "up"}
  /\ via' = "none" /\ closeAsked' = FALSE
  /\ shown' = DownShown /\ offlineTimer' = DownTimer /\ recovery' = FALSE
  /\ link' = Retry
  /\ UNCHANGED <<runtime, lanOpen, failed, peer, ranOut>>
  /\ CallAfter(FALSE, FALSE)

\* runtime-client's reconnect timer fires; connectRoute backs off first when the last attempt failed.
ReconnectTimerFires ==
  /\ link = "waitTimer"
  /\ link' = IF failed THEN "waitBackoff" ELSE "dialing"
  /\ failed' = TRUE
  /\ UNCHANGED <<shown, runtime, via, lanOpen, closeAsked, busy, recovery, offlineTimer, peer, call, ranOut>>

BackoffEnds ==
  /\ link = "waitBackoff"
  /\ link' = "dialing"
  /\ UNCHANGED <<shown, runtime, via, lanOpen, closeAsked, busy, recovery, offlineTimer, failed, peer, call, ranOut>>

OfflineTimerFires ==
  /\ offlineTimer
  /\ offlineTimer' = FALSE
  /\ shown' = IF shown = "reconnecting" THEN "offline" ELSE shown
  /\ UNCHANGED <<link, runtime, via, lanOpen, closeAsked, recovery, failed, peer, ranOut>>
  /\ CallAfter(shown = "reconnecting", busy)

PeerSleeps ==
  /\ peer = "awake"
  /\ peer' = "asleep" /\ lanOpen' = FALSE /\ closeAsked' = FALSE
  /\ UNCHANGED <<shown, link, runtime, via, busy, recovery, offlineTimer, failed, call, ranOut>>

PeerWakes ==
  /\ peer = "asleep"
  /\ peer' = "awake"
  /\ UNCHANGED <<shown, link, runtime, via, lanOpen, closeAsked, busy, recovery, offlineTimer, failed, call, ranOut>>

\* The other computer removes this Mac (Settings > Devices there): every later hello is refused.
PeerTurnsAway ==
  /\ peer # "away"
  /\ peer' = "away" /\ lanOpen' = FALSE /\ closeAsked' = FALSE
  /\ UNCHANGED <<shown, link, runtime, via, busy, recovery, offlineTimer, failed, call, ranOut>>

\* ---- you ----

\* Other computers off, or Remove: stop() closes everything and releases waiting calls.
YouTurnOff ==
  /\ shown # "off"
  /\ shown' = "off" /\ runtime' = FALSE /\ via' = "none"
  /\ link' = IF Break = "offKeepsDialing" /\ link \in {"waitTimer", "waitBackoff"} THEN link ELSE "stopped"
  /\ lanOpen' = FALSE /\ closeAsked' = FALSE /\ recovery' = FALSE /\ offlineTimer' = FALSE
  /\ UNCHANGED <<failed, peer, ranOut>>
  /\ CallAfter(TRUE, FALSE)

YouCall ==
  /\ call = "none" /\ shown # "off"
  /\ call' = IF recovery THEN "waitSwitch" ELSE Proceed(shown, runtime, link)
  /\ busy' = (busy \/ call' = "sent")
  /\ UNCHANGED <<shown, link, runtime, via, lanOpen, closeAsked, recovery, offlineTimer, failed, peer, ranOut>>

CallSwitchWaitRunsOut ==
  /\ call = "waitSwitch"
  /\ ranOut' = TRUE
  /\ call' = Proceed(shown, runtime, link)
  /\ busy' = (busy \/ call' = "sent")
  /\ UNCHANGED <<shown, link, runtime, via, lanOpen, closeAsked, recovery, offlineTimer, failed, peer>>

CallWaitRunsOut ==
  /\ call = "waitOnline"
  /\ ranOut' = TRUE
  /\ call' = Check(shown, runtime, link)
  /\ busy' = (busy \/ call' = "sent")
  /\ UNCHANGED <<shown, link, runtime, via, lanOpen, closeAsked, recovery, offlineTimer, failed, peer>>

\* Turned off or refused, the other computer gone, nothing waiting: an end, not a deadlock.
Done ==
  /\ link = "stopped" /\ peer = "away" /\ call \notin {"waitSwitch", "waitOnline"}
  /\ UNCHANGED vars

Next ==
  \/ ChooseRoute \/ RelayAnswers \/ RelaySaysOffline \/ RelayTurnsAway
  \/ RecoveryGoesOn \/ Opens \/ SwitchClosesEarly \/ SwitchClosesLast
  \/ LanOpens \/ LanGoes \/ ReplyArrives
  \/ ChannelDrops \/ ReconnectTimerFires \/ BackoffEnds \/ OfflineTimerFires
  \/ PeerSleeps \/ PeerWakes \/ PeerTurnsAway
  \/ YouTurnOff \/ YouCall \/ CallSwitchWaitRunsOut \/ CallWaitRunsOut
  \/ Done

Spec == Init /\ [][Next]_vars

\* chart.cfg draws the link alone, under the statechart budget: no call, nobody turns it off or away.
ChartScope == call = "none" /\ peer # "away" /\ shown # "off"

\* ---- rules ----

\* A call made while the computer is coming back waits for it: it fails as offline only once the computer reads
\* Offline, Refused or Off, or after its own wait.
CallWaitsWhileComingBack == ~(call = "offlineEarly" /\ ~ranOut)

\* A call to a computer that reads Online is sent, or waits through a move to the LAN; it never fails with "host
\* disconnected" before its own wait runs out.
OnlineCallGoesThrough == ~(call = "notSent" /\ ~ranOut)

\* Settings shows Online only while the computer is connected, or while it moves to the LAN.
OnlineMeansConnected == shown = "online" => (link = "up" \/ recovery)

\* Calls are held for a move to the LAN only while that move is under way.
SwitchHoldEnds == recovery => link # "up"

\* A computer that turned this Mac away is not dialed again until it is paired again.
RefusedIsQuiet == shown = "refused" => link = "stopped"

\* A computer you turned off or removed is not dialed.
OffIsQuiet == shown = "off" => link = "stopped"

=============================================================================
