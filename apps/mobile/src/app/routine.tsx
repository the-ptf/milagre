import { useCallback, useMemo, useRef, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  BubbleChatIcon,
  Folder01Icon,
  GitBranchIcon,
  PencilEdit02Icon,
  PlayIcon,
  Refresh01Icon,
  SecurityCheckIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { RoutineRun } from "@milagre/shared/model";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import {
  canEditRoutine,
  canOpenRunChat,
  canRunNow,
  clock,
  fallbackText,
  filterRuns,
  routineRetries,
  routineTimes,
  routineWhereText,
  runFilterCounts,
  triggerChipText,
  unreadRunChats,
  type RunFilter,
} from "@milagre/shared/routines";
import { useSession } from "../session";
import { useRoutines, type RoutineWithRuns } from "../use-routines";
import { useProjectStates } from "../use-project-states";
import { useRpc } from "../use-rpc";
import { useActivityClock } from "../chat-row-store";
import { modelsFor } from "../turn-options";
import { routineIcon } from "../routine-rows";
import { RunList } from "../run-list";
import { Icon, type IconData } from "../icons";
import { ErrorNotice, HeaderButton, PageScroll, RowCheckbox, Segmented, useStyles } from "../ui";
import { useTheme } from "../theme";

type Targets = { projects: { path: string; chats: { chatId: string; title: string }[] }[] };

/** The Projects a Routine's Run Chats live in: where it opens them (a Heartbeat's own Chat's), and where its Runs' Chats are. */
function routineProjects(routine: RoutineWithRuns | undefined) {
  if (!routine) return [];
  const own = routine.target.kind === "chat" ? projectOfKey(routine.target.chatId) : routine.target.projectPath;
  return [own, ...(routine.runs ?? []).flatMap((run) => (run.chatId ? [projectOfKey(run.chatId)] : []))];
}

/** Leaves the page, once however many ask: back, or to the Routines list when it was opened with nothing behind it. */
function leave(left: { current: boolean }) {
  if (left.current) return;
  left.current = true;
  if (router.canGoBack()) router.back();
  else router.replace("/routines");
}

/** A Routine's setting as a pill on the field fill, as desktop's chips: its icon and words. */
function Chip({ icon, text }: { icon: IconData; text: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 30, paddingHorizontal: 11, borderRadius: 15, backgroundColor: colors.field }}
    >
      <Icon icon={icon} tone="ink2" size={15} />
      <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, fontWeight: "500" }}>
        {text}
      </Text>
    </View>
  );
}

/** "On" in green, or "Paused" in grey, under the Routine's name. */
function StatusPill({ on }: { on: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={on ? "On" : "Paused"}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 24,
        paddingHorizontal: 9,
        borderRadius: 12,
        backgroundColor: on ? colors.greenTint : colors.field,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: on ? colors.green : colors.ink3 }} />
      <Text style={{ color: on ? colors.greenInk : colors.ink3, fontSize: 12, fontWeight: "600" }}>{on ? "On" : "Paused"}</Text>
    </View>
  );
}

/**
 * One Routine, as desktop's Routine page: On or Paused with its switch, its settings as chips, when it runs next and last
 * ran, then its Runs by day, filtered by All, Acted, Failed or Unread, with the stretches that did nothing folded. Run now
 * and Edit sit in the header; Delete is in Edit. A babysit Heartbeat has no Edit (no form edits it): the Routines list's
 * menu deletes it.
 */
/** This phone's time zone: a schedule chip in another one names its zone. */
const deviceZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function RoutineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const { client } = session;
  const routines = useRoutines(client);
  const routine = routines.routines.find((item) => item.id === id);
  // An older Mac may list a Routine without its Runs.
  const runs = routine?.runs ?? [];
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState<RunFilter>("all");
  // "Today 10:15" becomes "Yesterday 10:15" with the app's shared half-minute clock.
  const now = useActivityClock(true);
  // Each new Run or status reads its Projects again, so its Chat opens and its dot shows.
  const states = useProjectStates(routineProjects(routine), runs.map((run) => `${run.id}:${run.status}`).join(","));
  const unreadChats = useMemo(() => unreadRunChats(states), [states]);
  // A Heartbeat's Where chip names its Chat.
  const targets = useRpc<Targets>(routine?.target.kind === "chat" ? client : null, "routines:targets", []).data;
  // A Routine deleted (from this page, or anywhere else) takes its page with it, as on desktop: once the Mac's list has been
  // read and no longer holds it, go back. Not while the list is still loading, or after a read that failed, or when the
  // Mac's Routines are off. A page with another screen on top (the Edit form) goes when it is back in view.
  const left = useRef(false);
  const gone = !routine && routines.enabled !== null && !routines.loading && !routines.error;
  useFocusEffect(
    useCallback(() => {
      if (gone) leave(left);
    }, [gone]),
  );

  const edit = () => routine && router.push({ pathname: "/routine-form", params: { id: routine.id } });
  const fail = (failure: unknown, fallback: string) => setError(failure instanceof Error ? failure.message : fallback);
  const runNow = async () => {
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
  };
  // Linear and webhook Routines run only on their event; the scheduler refuses Run now for them.
  const runnable = Boolean(routine && client && canRunNow(routine));
  const canStart = runnable && Boolean(routine?.enabled) && !starting;
  const editable = !routine || canEditRoutine(routine);
  // Stack.Toolbar takes its buttons as direct children (a Fragment is refused), so each slot picks its own element.
  const toolbar = (
    <Stack.Toolbar placement="right">
      {runnable ? (
        Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="play.fill" accessibilityLabel="Run now" disabled={!canStart} onPress={() => void runNow()} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="Run now" icon={PlayIcon} onPress={canStart ? () => void runNow() : undefined} />
          </Stack.Toolbar.View>
        )
      ) : null}
      {!editable ? null : Platform.OS === "ios" ? (
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

  const openChat = (key: string) =>
    router.push({ pathname: "/chat", params: { projectPath: projectOfKey(key), hostId: client.url, id: String(sessionIdFromKey(key)) } });
  function flip() {
    if (!routine) return;
    setError("");
    void routines.update(routine.id, { enabled: !routine.enabled }).catch((failure) => fail(failure, "Could not change this Routine."));
  }
  const canOpen = (key: string) => canOpenRunChat(states, key);
  const unread = (run: RoutineRun) => Boolean(run.chatId && unreadChats.has(run.chatId) && canOpen(run.chatId));
  const counts = runFilterCounts(runs, unread);
  // A filter whose Runs are all gone (the last unread one read) falls back to All.
  const shownFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
  const filters = (
    [
      { value: "all", title: `All ${counts.all}` },
      { value: "acted", title: `Acted ${counts.acted}` },
      { value: "failed", title: `Failed ${counts.failed}` },
      { value: "unread", title: `Unread ${counts.unread}` },
    ] as const
  ).filter((option) => option.value === "all" || counts[option.value] > 0);
  const { target } = routine;
  const chatTitle = (chatId: string) => targets?.projects.flatMap((project) => project.chats).find((chat) => chat.chatId === chatId)?.title;
  const model = routine.model
    ? ((routine.provider ? modelsFor(routine.provider, session.models).find((item) => item.id === routine.model)?.name : undefined) ?? routine.model)
    : "Default model";
  const mode = routine.permissionMode ? (PERMISSION_MODES.find((item) => item.id === routine.permissionMode)?.name ?? routine.permissionMode) : "Default mode";
  const times = routineTimes(routine, now);
  const problem = routine.pausedReason && !routine.enabled ? routine.pausedReason : routine.lastError;

  return (
    <>
      <Stack.Screen options={{ title: routine.name }} />
      {toolbar}
      <PageScroll style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
        {routines.error ? <ErrorNotice message={routines.error} retry={() => void routines.refresh()} retryTitle="Reload" /> : null}
        {error ? <ErrorNotice message={error} /> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, flexDirection: "row" }}>
            <StatusPill on={routine.enabled} />
          </View>
          <RowCheckbox label={`${routine.name} on`} selected={routine.enabled} onPress={flip} />
        </View>
        {/* The chips scroll sideways when they don't fit, edge to edge. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginHorizontal: -20 }}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}
        >
          <Chip icon={routineIcon(routine)} text={triggerChipText(routine.trigger, deviceZone())} />
          <Chip
            icon={target.kind === "chat" ? BubbleChatIcon : target.workspace === "worktree" ? GitBranchIcon : Folder01Icon}
            text={routineWhereText(target, chatTitle)}
          />
          <Chip icon={SparklesIcon} text={model} />
          {routineRetries(routine) ? (
            <Chip
              icon={Refresh01Icon}
              text={fallbackText(routine, (provider, modelId) => modelsFor(provider, session.models).find((item) => item.id === modelId)?.name)}
            />
          ) : null}
          <Chip icon={SecurityCheckIcon} text={mode} />
        </ScrollView>
        {times ? <Text style={[styles.caption, { fontSize: 13, paddingHorizontal: 4 }]}>{times}</Text> : null}
        {problem ? <Text style={{ color: colors.redInk, fontSize: 13, paddingHorizontal: 4 }}>{problem}</Text> : null}
        <Text accessibilityRole="header" style={[styles.label, { paddingHorizontal: 4, marginTop: 8 }]}>
          Runs
        </Text>
        {runs.length ? (
          <>
            {filters.length > 1 ? (
              <Segmented label="Show" value={shownFilter} options={[...filters]} onChange={(value) => setFilter(value as RunFilter)} />
            ) : null}
            <RunList
              key={shownFilter}
              runs={filterRuns(runs, shownFilter, unread)}
              routineName={routine.name}
              now={now}
              unreadChats={unreadChats}
              canOpen={canOpen}
              onOpenChat={openChat}
            />
          </>
        ) : (
          <View style={[styles.card, { alignItems: "center", gap: 4, paddingVertical: 24 }]}>
            <Text style={styles.muted}>No Runs yet</Text>
            {routine.enabled && typeof routine.nextRunAt === "number" ? (
              <Text style={[styles.caption, { color: colors.ink3 }]}>{`Next Run ${clock(routine.nextRunAt)}`}</Text>
            ) : null}
          </View>
        )}
      </PageScroll>
    </>
  );
}
