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
import { FlowRoutineScreen } from "../flow-routine";
import type { IconData } from "../icons";
import { EmptyState, ErrorNotice, HeaderButton, InlineError, PageScroll, RowCheckbox, SectionLabel, Segmented, Tag, useStyles } from "../ui";

type Targets = { projects: { path: string; chats: { chatId: string; title: string }[] }[] };

function routineProjects(routine: RoutineWithRuns | undefined) {
  if (!routine) return [];
  const own = routine.target.kind === "chat" ? projectOfKey(routine.target.chatId) : routine.target.projectPath;
  return [own, ...(routine.runs ?? []).flatMap((run) => (run.chatId ? [projectOfKey(run.chatId)] : []))];
}

function leave(left: { current: boolean }) {
  if (left.current) return;
  left.current = true;
  if (router.canGoBack()) router.back();
  else router.replace("/routines");
}

function SettingChip({ icon, text }: { icon: IconData; text: string }) {
  return <Tag icon={icon} label={text} />;
}

function StatePill({ on }: { on: boolean }) {
  return <Tag tone={on ? "green" : "neutral"} dot label={on ? "On" : "Paused"} />;
}

const deviceZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function RoutineScreen() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const styles = useStyles();
  const session = useSession();
  const { client } = session;
  const routines = useRoutines(client);
  const routine = routines.routines.find((item) => item.id === id);
  const runs = routine?.runs ?? [];
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState<RunFilter>("all");
  const now = useActivityClock(true);
  const states = useProjectStates(routineProjects(routine), runs.map((run) => `${run.id}:${run.status}`).join(","));
  const unreadChats = useMemo(() => unreadRunChats(states), [states]);
  const targets = useRpc<Targets>(routine?.target.kind === "chat" ? client : null, "routines:targets", []).data;
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
  const runnable = Boolean(routine && client && canRunNow(routine));
  const canStart = runnable && Boolean(routine?.enabled) && !starting;
  const editable = !routine || canEditRoutine(routine);
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
            {!client ? "Connect to your computer to see its Routines." : routines.loading ? "Loading…" : "This Routine is no longer on your computer."}
          </Text>
        </PageScroll>
      </>
    );

  if (routine.flow) return <FlowRoutineScreen routine={routine} initialTab={tab === "runs" || tab === "settings" ? tab : "steps"} />;

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
            <StatePill on={routine.enabled} />
          </View>
          <RowCheckbox label={`${routine.name} on`} selected={routine.enabled} onPress={flip} />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginHorizontal: -16 }}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
        >
          <SettingChip icon={routineIcon(routine)} text={triggerChipText(routine.trigger, deviceZone())} />
          <SettingChip
            icon={target.kind === "chat" ? BubbleChatIcon : target.workspace === "worktree" ? GitBranchIcon : Folder01Icon}
            text={routineWhereText(target, chatTitle)}
          />
          <SettingChip icon={SparklesIcon} text={model} />
          {routineRetries(routine) ? (
            <SettingChip
              icon={Refresh01Icon}
              text={fallbackText(routine, (provider, modelId) => modelsFor(provider, session.models).find((item) => item.id === modelId)?.name)}
            />
          ) : null}
          <SettingChip icon={SecurityCheckIcon} text={mode} />
        </ScrollView>
        {times ? <Text style={styles.footnote}>{times}</Text> : null}
        <InlineError message={problem} />
        <SectionLabel flush>Runs</SectionLabel>
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
          <EmptyState title="No Runs yet">
            {routine.enabled && typeof routine.nextRunAt === "number" ? `Next Run ${clock(routine.nextRunAt)}` : undefined}
          </EmptyState>
        )}
      </PageScroll>
    </>
  );
}
