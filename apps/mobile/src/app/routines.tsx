import { Children, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { Add01Icon, ArrowRight01Icon, RepeatIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { canRunNow } from "@milagre/shared/routines";
import { useSession } from "../session";
import { useRoutines, type RoutineWithRuns } from "../use-routines";
import { useActivityClock } from "../chat-row-store";
import { isHeartbeat, routineIcon, routineMeta } from "../routine-rows";
import { confirm } from "../confirm-store";
import { Icon } from "../icons";
import { ErrorNotice, HeaderButton, PageScroll, PullDown, RowSwitch, useStyles } from "../ui";
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
  const { colors } = useTheme();
  const { client } = useSession();
  const routines = useRoutines(client);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  // "2 h ago" moves on with the app's shared half-minute clock.
  const now = useActivityClock(true);
  const all = routines.routines;
  const empty = client && routines.enabled === true && !routines.loading && !all.length && !routines.error && !routines.unavailable && !error;
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
    } else if (id === "delete")
      void act(async () => {
        if (!(await confirm(`Delete ${routine.name}?`, "Its Runs stop and it is removed from this Mac.", "Delete"))) return;
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
        <View style={[styles.screen, { padding: 20, paddingBottom: 36 }]}>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14 }}>
            <Icon icon={RepeatIcon} tone="ink3" size={40} />
            <Text style={[styles.muted, { textAlign: "center" }]}>No Routines yet.</Text>
          </View>
          <Text style={[styles.caption, { textAlign: "center" }]}>{LID_HELP}</Text>
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
          {routines.enabled === false ? (
            <View style={[styles.card, { gap: 8 }]}>
              <Text style={[styles.text, { fontWeight: "600" }]}>Routines are off on this Mac</Text>
              <Text style={styles.muted}>Turn them on in Settings › Experimental to let Routines run. Nothing runs while they are off.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open Experimental settings"
                onPress={() => router.push("/experimental")}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, opacity: pressed ? 0.5 : 1 })}
              >
                <Icon icon={Settings01Icon} tone="ink" size={20} />
                <Text style={[styles.text, { flex: 1, fontWeight: "500" }]}>Experimental</Text>
                <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
              </Pressable>
            </View>
          ) : null}
          {all.length ? (
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {FILTERS.map((item) => {
                const selected = filter === item.id;
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={`${item.label}, ${counts[item.id]}`}
                    onPress={() => setFilter(item.id)}
                    style={({ pressed }) => ({
                      height: 32,
                      paddingHorizontal: 12,
                      borderRadius: 16,
                      borderCurve: "continuous",
                      justifyContent: "center",
                      backgroundColor: selected ? colors.ink : colors.surface,
                      borderWidth: selected ? 0 : 1,
                      borderColor: colors.lineStrong,
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ color: selected ? colors.onInk : colors.ink2, fontSize: 13, fontWeight: selected ? "600" : "500" }}>
                      {item.label} {counts[item.id]}
                    </Text>
                  </Pressable>
                );
              })}
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
                  onSelect={(id) => select(routine, id)}
                  onFlip={() => flip(routine)}
                />
              ))}
            </Group>
          ))}
          {client && !routines.unavailable ? <Text style={[styles.caption, { paddingHorizontal: 4 }]}>{LID_HELP}</Text> : null}
        </PageScroll>
      )}
    </>
  );
}

/** A section label over a card of rows split by hairlines. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={[styles.label, { paddingHorizontal: 4 }]}>
        {title}
      </Text>
      <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
        {Children.toArray(children).map((child, index) => (
          <View key={(child as { key?: string }).key ?? String(index)}>
            {index > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line }} /> : null}
            {child}
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * One Routine: its icon, name and meta open its actions; the switch at the end turns it on or off. The switch sits beside
 * the menu, not inside it, since a menu's trigger takes every touch in its frame.
 */
function RoutineRow({
  routine,
  now,
  hasChat,
  onSelect,
  onFlip,
}: {
  routine: RoutineWithRuns;
  now: number;
  hasChat: boolean;
  onSelect: (id: string) => void;
  onFlip: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const meta = routineMeta(routine, now);
  const heartbeat = isHeartbeat(routine);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      {/* The label is what VoiceOver reads for the row: its name, meta and any paused reason or error. */}
      <PullDown
        label={`${routine.name}. ${meta}`}
        title={routine.name}
        style={{ flex: 1 }}
        sections={[
          {
            items: [
              { id: "edit", title: "Edit", systemImage: "pencil" },
              // Linear and webhook Routines run only on their event; the scheduler refuses Run now for them.
              ...(canRunNow(routine) ? [{ id: "run", title: "Run now", systemImage: "play", disabled: !routine.enabled }] : []),
              { id: "open", title: heartbeat ? "Open Chat" : "Open last Chat", systemImage: "bubble.left", disabled: !hasChat },
            ],
          },
          { items: [{ id: "delete", title: "Delete", systemImage: "trash", destructive: true }] },
        ]}
        onSelect={onSelect}
      >
        <View
          accessible
          accessibilityLabel={`${routine.name}. ${meta}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 68, paddingVertical: 13 }}
        >
          <Icon icon={routineIcon(routine)} tone={routine.enabled ? "ink" : "ink2"} size={20} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text numberOfLines={1} style={[styles.text, { fontSize: 15, lineHeight: 20, fontWeight: "500" }, !routine.enabled && { color: colors.ink2 }]}>
              {routine.name}
            </Text>
            <Text numberOfLines={routine.pausedReason || routine.lastError ? 3 : 1} style={[styles.caption, { color: colors.ink2 }]}>
              {meta}
            </Text>
          </View>
        </View>
      </PullDown>
      <RowSwitch label={routine.name} selected={routine.enabled} onPress={onFlip} />
    </View>
  );
}
