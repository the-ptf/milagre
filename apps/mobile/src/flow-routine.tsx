import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Folder01Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PauseCircleIcon,
  PencilEdit02Icon,
  TestTube01Icon,
} from "@hugeicons/core-free-icons";
import { currentStep, flowChanges, flowProblems, needsAnswer, stepTitle } from "@milagre/shared/routine-flows";
import { canRunNow, routineTimes, routineWhereText, triggerChipText } from "@milagre/shared/routines";
import type { ModelProvider, RoutineRun } from "@milagre/shared/model";
import { useSession } from "./session";
import { useRoutines, type RoutineWithRuns } from "./use-routines";
import { useFlowDraft } from "./flow-draft";
import { FlowSteps } from "./flow-editor";
import { FlowRunList } from "./flow-runs";
import { runName } from "./flow-looks";
import { FlowButton, FlowChip, FlowNote } from "./flow-ui";
import { routineIcon } from "./routine-rows";
import { useActivityClock } from "./chat-row-store";
import { modelsFor } from "./turn-options";
import { confirm } from "./confirm-store";
import { Icon } from "./icons";
import { ErrorNotice, HeaderButton, PageScroll, PullDown, RowCheckbox, Segmented, showActions, tap, useStyles } from "./ui";
import { useTheme } from "./theme";

export type FlowTab = "steps" | "runs" | "settings";
type Client = { call: <T>(method: string, args: unknown[]) => Promise<T> };

const deviceZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** Opens a flow Run's page. */
export const openFlowRun = (routineId: string, runId: string) => router.push({ pathname: "/flow-run", params: { id: routineId, run: runId } });

/** Starts a Test run of the draft (written first) and opens it. */
export async function startTestRun(client: Client, routineId: string, flush: () => Promise<void>, refresh: () => Promise<void>) {
  await flush();
  const result = await client.call<{ run?: RoutineRun } | null>("routines:flow-test", [routineId]);
  await refresh();
  if (result?.run?.id) openFlowRun(routineId, result.run.id);
}

/**
 * A flow's Routine page, as the designs draw it: its revision and draft chips, a bar when a Run waits for you, then Steps
 * (the editor, with Test run and Publish at the bottom), Runs, and Settings (the switch, the trigger and where Runs work,
 * and Edit, which opens the Routine form without its prompt).
 */
export function FlowRoutineScreen({ routine, initialTab = "steps" }: { routine: RoutineWithRuns; initialTab?: FlowTab }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { client } = session;
  const routines = useRoutines(client);
  const draft = useFlowDraft(client, routine, routines.update);
  const [tab, setTab] = useState<FlowTab>(initialTab);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [footerHeight, setFooterHeight] = useState(0);
  const now = useActivityClock(true);
  const flow = routine.flow!;
  const revision = flow.revision;
  const runs = [...(routine.runs ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const changes = flowChanges(draft.published, draft.steps);
  const changeCount = revision === 0 ? 0 : changes.length;
  const problems = flowProblems(draft.steps, routine.trigger.kind);
  const waiting = runs.find((run) => needsAnswer(run));
  const waitingStep = waiting ? currentStep(waiting.flow) : null;
  const modelName = (provider: ModelProvider | undefined, model: string) =>
    (provider ? modelsFor(provider, session.models).find((item) => item.id === model)?.name : undefined) ?? model;

  const edit = () => router.push({ pathname: "/routine-form", params: { id: routine.id } });
  async function act(id: string, run: () => Promise<unknown>, fallback: string) {
    if (busy) return;
    setError("");
    setBusy(id);
    try {
      await run();
    } catch (caught) {
      setError(failure(caught, fallback));
    } finally {
      setBusy("");
    }
  }
  const testRun = () => client && void act("test", () => startTestRun(client, routine.id, draft.flush, routines.refresh), "Could not start a Test run.");
  const publish = () =>
    void act(
      "publish",
      async () => {
        await draft.flush();
        router.push({ pathname: "/flow-publish", params: { id: routine.id } });
      },
      "Could not save the draft.",
    );
  async function discard() {
    const message = revision
      ? `${changeCount === 1 ? "Its change goes" : `Its ${changeCount} changes go`}, and the steps go back to revision ${revision}.`
      : "Its steps go, and the flow starts again with no steps.";
    if (!(await confirm("Discard the draft?", message, "Discard draft"))) return;
    await act("discard", () => draft.discard(), "Could not discard the draft.");
  }
  const runNow = () =>
    client &&
    void act(
      "run",
      async () => {
        await client.call("routines:run-now", [routine.id]);
        await routines.refresh();
      },
      "Could not run this Routine.",
    );
  const resume = (run: RoutineRun) =>
    client &&
    void act(
      `resume:${run.id}`,
      async () => {
        await client.call("routines:flow-act", [routine.id, run.id, "resume", {}]);
        await routines.refresh();
      },
      "Could not resume this Run.",
    );
  const flip = () => void act("flip", () => routines.update(routine.id, { enabled: !routine.enabled }), "Could not change this Routine.");

  const empty = draft.steps.length === 0;
  const testable = !empty && problems.length === 0;
  const publishable = testable && (revision === 0 || changeCount > 0);
  const hint = empty
    ? "Add at least one step to test or publish"
    : problems[0]
      ? problems[0].message
      : revision > 0 && changeCount === 0
        ? `No changes since revision ${revision}`
        : "Simulation uses sample or saved fields. No agents or actions run.";
  const menu = () =>
    showActions({
      title: routine.name,
      actions: [
        { id: "test", title: "Test run", disabled: !testable },
        ...(canRunNow(routine) ? [{ id: "run", title: "Run now", disabled: !routine.enabled || revision === 0 }] : []),
        { id: "edit", title: "Edit settings" },
        ...(changeCount > 0 || (revision === 0 && draft.hasDraft && !empty) ? [{ id: "discard", title: "Discard draft", destructive: true }] : []),
      ],
      onSelect: (id) => {
        if (id === "test") testRun();
        else if (id === "run") runNow();
        else if (id === "edit") edit();
        else if (id === "discard") void discard();
      },
    });

  const statusText = revision === 0 ? "Off, not published" : `${routine.enabled ? "On" : "Off"}, revision ${revision}`;
  const times = routineTimes(routine, now);
  const problem = routine.pausedReason && !routine.enabled ? routine.pausedReason : routine.lastError;
  const footer = tab === "steps";

  return (
    <View collapsable={false} style={styles.screen}>
      <Stack.Screen options={{ title: routine.name }} />
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="ellipsis" accessibilityLabel="More" onPress={menu} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="More" icon={MoreHorizontalIcon} onPress={menu} />
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
      <PageScroll
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 12, paddingBottom: footer ? footerHeight + 24 : 36 }}
        scrollIndicatorInsets={footer ? { bottom: footerHeight } : undefined}
      >
        {routines.error ? <ErrorNotice message={routines.error} retry={() => void routines.refresh()} retryTitle="Reload" /> : null}
        {error ? <ErrorNotice message={error} /> : null}
        {draft.error ? <ErrorNotice message={`The draft isn't saved: ${draft.error}`} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <FlowChip text={statusText} tone={routine.enabled && revision > 0 ? "green" : "neutral"} dot />
          {changeCount > 0 ? (
            <PullDown
              label={`Draft, ${changeCount} ${changeCount === 1 ? "change" : "changes"}`}
              title="Draft"
              sections={[{ items: [{ id: "discard", title: "Discard draft", systemImage: "trash", destructive: true }] }]}
              onSelect={() => void discard()}
            >
              <FlowChip text={`Draft, ${changeCount} ${changeCount === 1 ? "change" : "changes"}`} trailing={ArrowDown01Icon} />
            </PullDown>
          ) : null}
        </View>
        {problem ? (
          <FlowNote tone="red" icon={Alert02Icon}>
            {problem}
          </FlowNote>
        ) : null}
        {waiting ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${runName(routine, waiting)} waits for you${waitingStep ? ` at ${stepTitle(waitingStep)}` : ""}. Open it`}
            onPress={() => {
              tap();
              openFlowRun(routine.id, waiting.id);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 10,
              borderCurve: "continuous",
              backgroundColor: colors.orangeTint,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon icon={PauseCircleIcon} tone="orangeInk" size={18} />
            <Text numberOfLines={2} style={{ flex: 1, color: colors.ink, fontSize: 15, lineHeight: 19 }}>
              {`${runName(routine, waiting)} waits for you${waitingStep ? ` at ${stepTitle(waitingStep)}` : ""}`}
            </Text>
            <Icon icon={ArrowRight01Icon} tone="orangeInk" size={16} />
          </Pressable>
        ) : null}
        <Segmented
          label="Show"
          value={tab}
          options={[
            { value: "steps", title: "Steps" },
            { value: "runs", title: runs.length ? `Runs ${runs.length}` : "Runs" },
            { value: "settings", title: "Settings" },
          ]}
          onChange={(value) => setTab(value as FlowTab)}
        />
        {tab === "steps" ? (
          <FlowSteps routine={routine} routines={routines.routines} draft={draft} modelName={modelName} onTrigger={edit} />
        ) : tab === "runs" ? (
          <FlowRunList
            routine={routine}
            onOpen={(run) => openFlowRun(routine.id, run.id)}
            onResume={resume}
            resuming={busy.startsWith("resume:") ? busy.slice(7) : ""}
          />
        ) : (
          <View style={{ gap: 12 }}>
            <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>{routine.enabled ? "On" : "Off"}</Text>
                <Text style={[styles.caption, { fontSize: 13 }]}>
                  {revision === 0
                    ? "Publish the flow to turn it on."
                    : routine.enabled
                      ? `New Runs use revision ${revision}.`
                      : "The trigger starts no Runs while it is off."}
                </Text>
              </View>
              <RowCheckbox label={`${routine.name} on`} selected={routine.enabled} disabled={revision === 0} onPress={flip} />
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginHorizontal: -20 }}
              contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}
            >
              <SettingChip icon={routineIcon(routine)} text={triggerChipText(routine.trigger, deviceZone())} />
              <SettingChip
                icon={routine.target.kind === "new-chat" && routine.target.workspace === "worktree" ? GitBranchIcon : Folder01Icon}
                text={routineWhereText(routine.target)}
              />
            </ScrollView>
            {times ? <Text style={[styles.caption, { fontSize: 13, paddingHorizontal: 4 }]}>{times}</Text> : null}
            <Text style={[styles.caption, { fontSize: 13, paddingHorizontal: 4 }]}>
              Each step picks its own model and permissions. Runs in progress keep the revision they started on.
            </Text>
            <FlowButton title="Edit settings" kind="secondary" icon={PencilEdit02Icon} onPress={edit} />
          </View>
        )}
      </PageScroll>
      {footer ? (
        <View
          onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            gap: 10,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.line,
            backgroundColor: colors.page,
            paddingHorizontal: 16,
            paddingTop: hint ? 10 : 14,
            paddingBottom: Math.max(insets.bottom, 16),
          }}
        >
          {hint ? (
            <Text numberOfLines={2} style={[styles.caption, { textAlign: "center", fontSize: 13, color: problems[0] && !empty ? colors.redInk : colors.ink3 }]}>
              {hint}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <FlowButton
              title="Test run"
              kind="secondary"
              icon={TestTube01Icon}
              disabled={!testable || !client}
              loading={busy === "test"}
              onPress={testRun}
              style={{ flex: 1 }}
            />
            <FlowButton
              title={revision === 0 ? "Publish" : `Publish revision ${revision + 1}`}
              disabled={!publishable || !client}
              loading={busy === "publish"}
              onPress={publish}
              style={{ flex: 1.7 }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A setting as a pill on the field fill, as the Routine page's chips. */
function SettingChip({ icon, text }: { icon: Parameters<typeof Icon>[0]["icon"]; text: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 30, paddingHorizontal: 11, borderRadius: 14, backgroundColor: colors.field }}
    >
      <Icon icon={icon} tone="ink2" size={15} />
      <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, fontWeight: "500" }}>
        {text}
      </Text>
    </View>
  );
}
