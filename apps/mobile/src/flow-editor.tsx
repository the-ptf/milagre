import { Fragment } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Add01Icon, ArrowRight01Icon, Copy01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { FLOW_LIMITS, FLOW_STEP_TYPES, flowProblems, insertStep, newStep, stepSubtitle, stepTitle } from "@milagre/shared/routine-flows";
import { triggerChipText } from "@milagre/shared/routines";
import type { FlowAgentStep, FlowIfStep, FlowStep, FlowStepKind, ModelProvider, PermissionMode } from "@milagre/shared/model";
import type { RoutineWithRuns } from "./use-routines";
import type { FlowDraft } from "./flow-draft";
import { TRIGGER_LOOK, changedStepIds, stepLook, triggerTitle } from "./flow-looks";
import { StepTile } from "./flow-ui";
import { Icon } from "./icons";
import { PullDown, tap, useStyles } from "./ui";
import { useTheme } from "./theme";

type Where = { parentId: string | null; branch: "yes" | "otherwise" | null; index: number };

/** Opens the step editor on step `stepId` of Routine `routineId`. */
export const openStep = (routineId: string, stepId: string) => router.push({ pathname: "/flow-step", params: { id: routineId, step: stepId } });

/** Opens the Add step sheet for a place in the flow. */
const openAdd = (routineId: string, where: Where) =>
  router.push({ pathname: "/flow-add-step", params: { id: routineId, parent: where.parentId ?? "", branch: where.branch ?? "", index: String(where.index) } });

/** The kinds a flow under this trigger can't use: a Linear comment needs a Linear trigger. */
export const unavailableKinds = (triggerKind: string): Set<FlowStepKind> => new Set(triggerKind === "linear" ? [] : (["linear-comment"] as const));

const deviceZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
const AGENT_MODES = new Set(["ask", "auto", "full"]);

/**
 * A flow's Steps tab: the trigger, then its steps as cards joined by a line with a "+" between them, an If's paths indented
 * under it with their labels. A step the draft changed carries a blue dot; a step with a problem says it in red. With no
 * steps yet, the step types are tiles to start from, and other Routines can be copied in.
 */
export function FlowSteps({
  routine,
  routines,
  draft,
  modelName,
  onTrigger,
}: {
  routine: RoutineWithRuns;
  routines: RoutineWithRuns[];
  draft: FlowDraft;
  modelName: (provider: ModelProvider | undefined, model: string) => string;
  onTrigger: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { steps } = draft;
  const triggerKind = routine.trigger.kind;
  const problems = flowProblems(steps, triggerKind);
  const changed = draft.hasDraft && (routine.flow?.revision ?? 0) > 0 ? changedStepIds(draft.published, steps) : new Set<string>();
  const unavailable = unavailableKinds(triggerKind);

  const add = (kind: FlowStepKind) => {
    const step = newStep(kind, steps);
    draft.edit(insertStep(steps, { parentId: null, branch: null, index: 0 }, step));
    openStep(routine.id, step.id);
  };

  const card = (step: FlowStep) => {
    const look = stepLook(step.kind);
    const problem = problems.find((item) => item.stepId === step.id)?.message;
    const title = stepTitle(step);
    const subtitle = stepSubtitle(step, { modelName });
    const edited = changed.has(step.id);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[title, edited ? "Edited" : "", subtitle, problem ?? ""].filter(Boolean).join(". ")}
        onPress={() => {
          tap();
          openStep(routine.id, step.id);
        }}
        style={({ pressed }) => [
          styles.card,
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 12,
            paddingHorizontal: 12,
            borderRadius: 14,
            borderColor: problem ? colors.red : colors.line,
            borderWidth: problem ? 1 : StyleSheet.hairlineWidth,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <StepTile look={look} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink, fontSize: 16, fontWeight: "600" }}>
              {title}
            </Text>
            {edited ? <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: colors.accent }} /> : null}
          </View>
          <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: 13, lineHeight: 18 }}>
            {subtitle}
          </Text>
          {problem ? (
            <Text numberOfLines={2} style={{ color: colors.redInk, fontSize: 13, lineHeight: 18 }}>
              {problem}
            </Text>
          ) : null}
        </View>
        <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
      </Pressable>
    );
  };

  /** The line between two cards, with the "+" that adds a step there. */
  const connector = (where: Where, key: string) => (
    <View key={key} style={{ height: 30, paddingLeft: 22, justifyContent: "center" }}>
      <View style={{ position: "absolute", left: 29.5, top: 0, bottom: 0, width: 1, backgroundColor: colors.lineStrong }} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add step here"
        hitSlop={8}
        onPress={() => {
          tap();
          openAdd(routine.id, where);
        }}
        style={({ pressed }) => ({
          width: 16,
          height: 16,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.page,
          borderWidth: 1,
          borderColor: colors.lineStrong,
          opacity: pressed ? 0.5 : 1,
        })}
      >
        <Icon icon={Add01Icon} tone="ink3" size={12} strokeWidth={2} />
      </Pressable>
    </View>
  );

  const pathLabel = (text: string) => (
    <View style={{ alignSelf: "flex-start", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.field }}>
      <Text style={{ color: colors.ink2, fontSize: 12, fontWeight: "600" }}>{text}</Text>
    </View>
  );

  const list = (items: FlowStep[], parentId: string | null, branch: "yes" | "otherwise" | null, depth: number) =>
    items.map((step, index) => (
      <Fragment key={step.id}>
        {index > 0 ? connector({ parentId, branch, index }, `+${step.id}`) : null}
        {card(step)}
        {step.kind === "if" ? paths(step, depth + 1) : null}
      </Fragment>
    ));

  /** An If's two paths, under it and indented, each with its label; an empty one offers to add a step or go straight on. */
  const paths = (step: FlowIfStep, depth: number) => (
    <View style={{ flexDirection: "row" }}>
      <View style={{ width: 40 }}>
        <View style={{ position: "absolute", left: 29.5, top: 0, bottom: 0, width: 1, backgroundColor: colors.lineStrong }} />
      </View>
      <View style={{ flex: 1, gap: 8, paddingTop: 8 }}>
        {(["yes", "otherwise"] as const).map((branch) => {
          const items = step[branch];
          return (
            <View key={branch} style={{ gap: 8 }}>
              {pathLabel(branch === "yes" ? "Yes" : "Otherwise")}
              {items.length ? (
                <View>
                  {list(items, step.id, branch, depth)}
                  {connector({ parentId: step.id, branch, index: items.length }, `end:${step.id}:${branch}`)}
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Add a step on the ${branch === "yes" ? "Yes" : "Otherwise"} path`}
                  onPress={() => {
                    tap();
                    openAdd(routine.id, { parentId: step.id, branch, index: 0 });
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    minHeight: 40,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    borderCurve: "continuous",
                    backgroundColor: colors.inset,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Icon icon={Add01Icon} tone="ink3" size={12} />
                  <Text style={{ color: colors.ink2, fontSize: 15 }}>Add step, or go straight on</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );

  const trigger = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Trigger: ${triggerChipText(routine.trigger, deviceZone())}. Edit settings`}
      onPress={() => {
        tap();
        onTrigger();
      }}
      style={({ pressed }) => [
        styles.card,
        { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <StepTile look={TRIGGER_LOOK} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>
          {triggerTitle(routine.trigger)}
        </Text>
        <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: 13, lineHeight: 18 }}>
          {triggerChipText(routine.trigger, deviceZone())}
        </Text>
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </Pressable>
  );

  if (!steps.length) {
    const flows = routines.filter((item) => item.id !== routine.id && item.flow && (item.flow.draft?.steps ?? item.flow.steps).length > 0).slice(0, 3);
    const prompts = routines.filter((item) => !item.flow && item.target.kind === "new-chat" && item.prompt.trim());
    const fromPrompt = (id: string) => {
      const source = prompts.find((item) => item.id === id);
      if (!source) return;
      const step: FlowAgentStep = { ...newStep("agent", []), name: source.name.slice(0, FLOW_LIMITS.name), prompt: source.prompt.slice(0, FLOW_LIMITS.prompt) };
      if (source.provider) step.provider = source.provider;
      if (source.model) step.model = source.model;
      if (source.permissionMode && AGENT_MODES.has(source.permissionMode)) step.permissionMode = source.permissionMode as PermissionMode;
      draft.edit([step]);
    };
    return (
      <View style={{ gap: 0 }}>
        {trigger}
        <View style={{ height: 18, marginLeft: 29.5, width: 1, backgroundColor: colors.lineStrong }} />
        <View style={{ gap: 14, padding: 16, borderRadius: 20, borderCurve: "continuous", backgroundColor: colors.inset }}>
          <View style={{ gap: 4 }}>
            <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
              What should happen next?
            </Text>
            <Text style={{ color: colors.ink3, fontSize: 15, lineHeight: 19 }}>Each step can read what the trigger and earlier steps give.</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {FLOW_STEP_TYPES.map((type) => {
              const off = unavailable.has(type.kind);
              return (
                <Pressable
                  key={type.kind}
                  accessibilityRole="button"
                  accessibilityLabel={`${type.name}. ${off ? "Needs a Linear trigger" : type.description}`}
                  accessibilityState={{ disabled: off }}
                  disabled={off}
                  onPress={() => {
                    tap();
                    add(type.kind);
                  }}
                  style={({ pressed }) => [
                    styles.card,
                    {
                      flexBasis: "31%",
                      flexGrow: 1,
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: 14,
                      paddingHorizontal: 6,
                      borderRadius: 14,
                      opacity: off ? 0.4 : pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <StepTile look={stepLook(type.kind)} size={30} />
                  <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 15, fontWeight: "600" }}>
                    {type.short}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        {flows.length || prompts.length ? (
          <View style={{ gap: 8, marginTop: 20 }}>
            <Text accessibilityRole="header" style={[styles.label, { paddingHorizontal: 4 }]}>
              Or start from
            </Text>
            <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
              {flows.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  <StartRow
                    icon={Copy01Icon}
                    title={`Copy of ${item.name}`}
                    onPress={() => draft.edit(structuredClone(item.flow!.draft?.steps ?? item.flow!.steps))}
                  />
                </View>
              ))}
              {prompts.length ? (
                <View>
                  {flows.length ? <View style={styles.separator} /> : null}
                  <PullDown
                    label="Existing Routine, as a one-step flow"
                    title="Start from a Routine"
                    searchable={{ placeholder: "Search Routines", emptyLabel: "No matching Routines" }}
                    nativeTrigger={{ systemImage: "chevron.right", title: "Existing Routine, as a one-step flow" }}
                    sections={[{ items: prompts.map((item) => ({ id: item.id, title: item.name, subtitle: item.prompt.slice(0, 80) })) }]}
                    onSelect={fromPrompt}
                  >
                    <StartRow icon={File01Icon} title="Existing Routine, as a one-step flow" />
                  </PullDown>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      {trigger}
      {connector({ parentId: null, branch: null, index: 0 }, "+first")}
      {list(steps, null, null, 0)}
      {connector({ parentId: null, branch: null, index: steps.length }, "+last")}
    </View>
  );
}

/** "Or start from" row: an icon, its words and a chevron. Without `onPress` the row sits inside a picker that opens on tap. */
function StartRow({ icon, title, onPress }: { icon: typeof Copy01Icon; title: string; onPress?: () => void }) {
  const { colors } = useTheme();
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 12 }}>
      <Icon icon={icon} tone="ink2" size={18} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 15 }}>
        {title}
      </Text>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}
