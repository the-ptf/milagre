import { useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { canOpenRunChat, canRunNow, clock, unreadRunChats } from "@milagre/shared/routines";
import { useSession } from "../session";
import { useRoutines, type RoutineWithRuns } from "../use-routines";
import { useProjectStates } from "../use-project-states";
import { useActivityClock } from "../chat-row-store";
import { routineDeleteMessage, routineIcon, routineMeta } from "../routine-rows";
import { RunList } from "../run-list";
import { confirm } from "../confirm-store";
import { Icon } from "../icons";
import { Button, ErrorNotice, HeaderButton, PageScroll, RowSwitch, useStyles } from "../ui";
import { useTheme } from "../theme";

/** The Projects a Routine's Run Chats live in: where it opens them (a Heartbeat's own Chat's), and where its Runs' Chats are. */
function routineProjects(routine: RoutineWithRuns | undefined) {
  if (!routine) return [];
  const own = routine.target.kind === "chat" ? projectOfKey(routine.target.chatId) : routine.target.projectPath;
  return [own, ...(routine.runs ?? []).flatMap((run) => (run.chatId ? [projectOfKey(run.chatId)] : []))];
}

/**
 * One Routine, as desktop's Routine page: what starts it and its switch, Run now, then its Runs, newest first, with the
 * stretches that did nothing folded. Edit sits in the header; Delete at the end.
 */
export default function RoutineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const { client } = useSession();
  const routines = useRoutines(client);
  const routine = routines.routines.find((item) => item.id === id);
  // An older Mac may list a Routine without its Runs.
  const runs = routine?.runs ?? [];
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  // "Today 10:15" becomes "Yesterday 10:15" with the app's shared half-minute clock.
  const now = useActivityClock(true);
  // Each new Run or status reads its Projects again, so its Chat opens and its dot shows.
  const states = useProjectStates(routineProjects(routine), runs.map((run) => `${run.id}:${run.status}`).join(","));
  const unreadChats = useMemo(() => unreadRunChats(states), [states]);

  const edit = () => routine && router.push({ pathname: "/routine-form", params: { id: routine.id } });
  const fail = (failure: unknown, fallback: string) => setError(failure instanceof Error ? failure.message : fallback);
  const toolbar = (
    <Stack.Toolbar placement="right">
      {Platform.OS === "ios" ? (
        <Stack.Toolbar.Button icon="pencil" accessibilityLabel="Edit" disabled={!routine || !client} onPress={edit} />
      ) : (
        <Stack.Toolbar.View>
          <HeaderButton label="Edit" icon={PencilEdit02Icon} onPress={routine && client ? edit : undefined} />
        </Stack.Toolbar.View>
      )}
    </Stack.Toolbar>
  );
  if (!routine || !client)
    return (
      <>
        <Stack.Screen options={{ title: "Routine" }} />
        {toolbar}
        <PageScroll>
          {routines.error ? <ErrorNotice message={routines.error} retry={() => void routines.refresh()} retryTitle="Reload" /> : null}
          <Text style={styles.muted}>
            {!client ? "Connect to a Mac to see its Routines." : routines.loading ? "Loading…" : "This Routine is no longer on this Mac."}
          </Text>
        </PageScroll>
      </>
    );

  const meta = routineMeta(routine, now);
  const openChat = (key: string) =>
    router.push({ pathname: "/chat", params: { projectPath: projectOfKey(key), hostId: client.url, id: String(sessionIdFromKey(key)) } });
  function flip() {
    if (!routine) return;
    setError("");
    void routines.update(routine.id, { enabled: !routine.enabled }).catch((failure) => fail(failure, "Could not change this Routine."));
  }
  async function runNow() {
    if (!routine || !client || starting) return;
    setError("");
    setStarting(true);
    try {
      await client.call("routines:run-now", [routine.id]);
      await routines.refresh();
    } catch (failure) {
      fail(failure, "Could not run this Routine.");
    } finally {
      setStarting(false);
    }
  }
  async function remove() {
    if (!routine || !client) return;
    setError("");
    try {
      if (!(await confirm(`Delete ${routine.name}?`, routineDeleteMessage(routine), "Delete"))) return;
      await client.call("routines:delete", [routine.id]);
      router.back();
      await routines.refresh();
    } catch (failure) {
      fail(failure, "Could not delete this Routine.");
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: routine.name }} />
      {toolbar}
      <PageScroll style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
        {routines.error ? <ErrorNotice message={routines.error} retry={() => void routines.refresh()} retryTitle="Reload" /> : null}
        {error ? <ErrorNotice message={error} /> : null}
        <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13 }]}>
          <Icon icon={routineIcon(routine)} tone={routine.enabled ? "ink" : "ink2"} size={20} />
          <Text style={[styles.muted, { flex: 1 }]}>{meta}</Text>
          <RowSwitch label={`${routine.name} on`} selected={routine.enabled} onPress={flip} />
        </View>
        {/* Linear and webhook Routines run only on their event; the scheduler refuses Run now for them. */}
        {canRunNow(routine) ? <Button title="Run now" secondary disabled={!routine.enabled} loading={starting} onPress={() => void runNow()} /> : null}
        <Text accessibilityRole="header" style={[styles.label, { paddingHorizontal: 4, marginTop: 8 }]}>
          Runs
        </Text>
        {runs.length ? (
          <RunList
            runs={runs}
            routineName={routine.name}
            now={now}
            unreadChats={unreadChats}
            canOpen={(key) => canOpenRunChat(states, key)}
            onOpenChat={openChat}
          />
        ) : (
          <View style={[styles.card, { alignItems: "center", gap: 4, paddingVertical: 24 }]}>
            <Text style={styles.muted}>No Runs yet</Text>
            {routine.enabled && typeof routine.nextRunAt === "number" ? (
              <Text style={[styles.caption, { color: colors.ink3 }]}>{`Next Run ${clock(routine.nextRunAt)}`}</Text>
            ) : null}
          </View>
        )}
        <View style={{ marginTop: 12 }}>
          <Button title="Delete" secondary destructive onPress={() => void remove()} />
        </View>
      </PageScroll>
    </>
  );
}
