import { useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { Add01Icon, RepeatIcon } from "@hugeicons/core-free-icons";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { canEditRoutine, canRunNow, unreadRunChatsOf, unreadRunRoutines } from "@milagre/shared/routines";
import { useSession } from "../session";
import { useRoutines, type RoutineWithRuns } from "../use-routines";
import { useProjectStates } from "../use-project-states";
import { useActivityClock } from "../chat-row-store";
import { isHeartbeat, routineDeleteMessage, routineIcon, routineMeta } from "../routine-rows";
import { ChatMarkIcon } from "../status-indicators";
import { confirm } from "../confirm-store";
import { Icon } from "../icons";
import { Chip, EmptyState, ErrorNotice, Group, HeaderButton, PageScroll, PullDown, RowSwitch, useStyles } from "../ui";
import { lineHeight, type } from "../design-tokens";
import { useTheme } from "../theme";

type Filter = "all" | "heartbeats" | "triggers" | "paused";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "heartbeats", label: "Heartbeats" },
  { id: "triggers", label: "Triggers" },
  { id: "paused", label: "Paused" },
];
/** The spec keeps the lid-close limit to this help line and the switched-off state. */
export const LID_HELP = "Routines run while this Mac is awake. Closing the lid on battery pauses them.";

const newRoutine = () => router.push("/routine-form");
const openRoutine = (routine: RoutineWithRuns) => router.push({ pathname: "/routine", params: { id: routine.id } });

/** The Projects the Routines open Run Chats in, for their rows' unread dots. */
const runProjects = (routines: RoutineWithRuns[]) => routines.flatMap((routine) => (routine.target.kind === "new-chat" ? [routine.target.projectPath] : []));

/** The Chat a Routine's action opens: a heartbeat's own Chat, else the Chat its newest Run started. */
function chatOf(routine: RoutineWithRuns) {
  if (routine.target.kind === "chat") return routine.target.chatId;
  let last: RoutineWithRuns["runs"][number] | undefined;
  for (const run of routine.runs ?? []) if (run.chatId && (!last || run.startedAt > last.startedAt)) last = run;
  return last?.chatId;
}

/** The connected Mac's Routines: heartbeats and triggers, each with its switch and actions. */
export default function RoutinesScreen() {
  const styles = useStyles();
  const { client } = useSession();
  const routines = useRoutines(client);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  // "2 h ago" moves on with the app's shared half-minute clock.
  const now = useActivityClock(true);
  const all = routines.routines;
  // A Routine with a hidden Run Chat nobody opened shows a dot; each new Run reads its Project again.
  const states = useProjectStates(runProjects(all), all.map((routine) => routine.runs?.[0]?.id ?? "").join(","));
  const unread = useMemo(() => unreadRunRoutines(states), [states]);
  const empty = client && routines.enabled !== null && !routines.loading && !all.length && !routines.error && !routines.unavailable && !error;
  const heartbeats = all.filter(isHeartbeat);
  const triggers = all.filter((routine) => !isHeartbeat(routine));
  const counts: Record<Filter, number> = {
    all: all.length,
    heartbeats: heartbeats.length,
    triggers: triggers.length,
    paused: all.filter((routine) => !routine.enabled).length,
  };
  const shown = (list: RoutineWithRuns[]) => (filter === "paused" ? list.filter((routine) => !routine.enabled) : list);
  const groups = [
    { title: "Heartbeats", rows: filter === "triggers" ? [] : shown(heartbeats) },
    { title: "Triggers", rows: filter === "heartbeats" ? [] : shown(triggers) },
  ].filter((group) => group.rows.length);

  async function act(run: () => Promise<unknown>, fallback: string) {
    setError("");
    try {
      await run();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : fallback);
    }
  }
  function select(routine: RoutineWithRuns, id: string) {
    if (!client) return;
    if (id === "edit") router.push({ pathname: "/routine-form", params: { id: routine.id } });
    else if (id === "run")
      void act(async () => {
        await client.call("routines:run-now", [routine.id]);
        await routines.refresh();
      }, "Could not run this Routine.");
    else if (id === "open") {
      const chatId = chatOf(routine);
      if (chatId) router.push({ pathname: "/chat", params: { projectPath: projectOfKey(chatId), hostId: client.url, id: String(sessionIdFromKey(chatId)) } });
    } else if (id === "read")
      void act(
        () =>
          Promise.all(
            unreadRunChatsOf(states, routine.id).map((key) => client.call("chat:patch", [projectOfKey(key), sessionIdFromKey(key), { unread: false }])),
          ),
        "Could not mark this Routine read.",
      );
    else if (id === "delete")
      void act(async () => {
        if (!(await confirm(`Delete ${routine.name}?`, routineDeleteMessage(routine), "Delete"))) return;
        await client.call("routines:delete", [routine.id]);
        await routines.refresh();
      }, "Could not delete this Routine.");
  }
  function flip(routine: RoutineWithRuns) {
    void act(() => routines.update(routine.id, { enabled: !routine.enabled }), "Could not change this Routine.");
  }

  return (
    <>
      {/* Stack.Toolbar takes its buttons as direct children (a Fragment is refused), so each slot picks its own element. */}
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="plus" accessibilityLabel="New Routine" disabled={!client || !!routines.unavailable} onPress={newRoutine} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="New Routine" icon={Add01Icon} onPress={client && !routines.unavailable ? newRoutine : undefined} />
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
      {empty ? (
        <View style={[styles.screen, { justifyContent: "center", padding: 16 }]}>
          <EmptyState icon={RepeatIcon} title="No Routines yet">
            {LID_HELP}
          </EmptyState>
        </View>
      ) : (
        <PageScroll style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
          {!client ? <Text style={styles.muted}>Connect to a Mac to see its Routines.</Text> : null}
          {routines.error ? <ErrorNotice message={routines.error} retry={() => void routines.refresh()} retryTitle="Reload" /> : null}
          {error ? <ErrorNotice message={error} /> : null}
          {routines.unavailable ? (
            <Text style={styles.muted}>
              {routines.unavailable === "older" ? "Update Milagre on this Mac to use Routines." : "Routines aren't available on this connection."}
            </Text>
          ) : null}
          {all.length ? (
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {FILTERS.map((item) => (
                <Chip
                  key={item.id}
                  label={`${item.label} ${counts[item.id]}`}
                  accessibilityLabel={`${item.label}, ${counts[item.id]}`}
                  selected={filter === item.id}
                  onPress={() => setFilter(item.id)}
                />
              ))}
            </View>
          ) : null}
          {groups.map((group) => (
            <Group key={group.title} title={group.title}>
              {group.rows.map((routine) => (
                <RoutineRow
                  key={routine.id}
                  routine={routine}
                  now={now}
                  hasChat={!!chatOf(routine)}
                  unread={unread.has(routine.id)}
                  onOpen={() => openRoutine(routine)}
                  onSelect={(id) => select(routine, id)}
                  onFlip={() => flip(routine)}
                />
              ))}
            </Group>
          ))}
          {client && !routines.unavailable ? <Text style={[styles.footnote, { paddingHorizontal: 16 }]}>{LID_HELP}</Text> : null}
        </PageScroll>
      )}
    </>
  );
}

/**
 * One Routine: a tap on its icon, name and meta opens its page, a long press its actions; the switch at the end turns it on
 * or off. The switch sits beside the menu, not inside it, since a menu's trigger takes every touch in its frame. A dot by the
 * name says one of its hidden Run Chats is unread.
 */
function RoutineRow({
  routine,
  now,
  hasChat,
  unread,
  onOpen,
  onSelect,
  onFlip,
}: {
  routine: RoutineWithRuns;
  now: number;
  hasChat: boolean;
  unread: boolean;
  onOpen: () => void;
  onSelect: (id: string) => void;
  onFlip: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const meta = routineMeta(routine, now);
  const label = `${routine.name}${unread ? ", unread Runs" : ""}. ${meta}`;
  const heartbeat = isHeartbeat(routine);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      {/* The label is what VoiceOver reads for the row: its name, unread Runs, meta and any paused reason or error. */}
      <PullDown
        label={label}
        title={routine.name}
        style={{ flex: 1 }}
        onPress={onOpen}
        sections={[
          {
            items: [
              // A babysit Heartbeat follows the Babysit PRs settings: no form edits it.
              ...(canEditRoutine(routine) ? [{ id: "edit", title: "Edit", systemImage: "pencil" }] : []),
              // Linear and webhook Routines run only on their event (a babysit Heartbeat on its PR's); the scheduler refuses Run now for them.
              ...(canRunNow(routine) ? [{ id: "run", title: "Run now", systemImage: "play", disabled: !routine.enabled }] : []),
              { id: "open", title: heartbeat ? "Open Chat" : "Open last Chat", systemImage: "bubble.left", disabled: !hasChat },
              ...(unread ? [{ id: "read", title: "Mark as read", systemImage: "checkmark" }] : []),
            ],
          },
          { items: [{ id: "delete", title: "Delete", systemImage: "trash", destructive: true }] },
        ]}
        onSelect={onSelect}
      >
        <View accessible accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 12 }}>
          <Icon icon={routineIcon(routine)} tone={routine.enabled ? "ink" : "ink2"} size={20} />
          <View style={{ flex: 1, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <Text
                numberOfLines={1}
                style={[
                  styles.text,
                  { flexShrink: 1, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" },
                  !routine.enabled && { color: colors.ink2 },
                ]}
              >
                {routine.name}
              </Text>
              {unread ? <ChatMarkIcon mark="unread" /> : null}
            </View>
            <Text numberOfLines={routine.pausedReason || routine.lastError ? 3 : 1} style={styles.caption}>
              {meta}
            </Text>
          </View>
        </View>
      </PullDown>
      <RowSwitch label={routine.name} selected={routine.enabled} onPress={onFlip} />
    </View>
  );
}
