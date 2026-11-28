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
import { hitSlopFor, lineHeight, radius, space, type } from "./design-tokens";
import { PullDown, Tag, pressStyle, tap, useStyles } from "./ui";
import { useTheme } from "./theme";

type Where = { parentId: string | null; branch: "yes" | "otherwise" | null; index: number };

export const openStep = (routineId: string, stepId: string) => router.push({ pathname: "/flow-step", params: { id: routineId, step: stepId } });

export const openAdd = (routineId: string, where: Where) =>
  router.push({ pathname: "/flow-add-step", params: { id: routineId, parent: where.parentId ?? "", branch: where.branch ?? "", index: String(where.index) } });

export const unavailableKinds = (triggerKind: string): Set<FlowStepKind> => new Set(triggerKind === "linear" ? [] : (["linear-comment"] as const));

const deviceZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
const AGENT_MODES = new Set(["ask", "auto", "full"]);

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
            paddingVertical: space.lg,
            paddingHorizontal: space.lg,
            borderColor: problem ? colors.red : colors.line,
            borderWidth: problem ? 1 : StyleSheet.hairlineWidth,
          },
          pressStyle({ pressed }),
        ]}
      >
        <StepTile look={look} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>
              {title}
            </Text>
            {edited ? <View style={{ width: 7, height: 7, borderRadius: radius.full, backgroundColor: colors.accent }} /> : null}
          </View>
          <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
            {subtitle}
          </Text>
          {problem ? (
            <Text numberOfLines={2} style={{ color: colors.redInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
              {problem}
            </Text>
          ) : null}
        </View>
        <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
      </Pressable>
    );
  };

  const connector = (where: Where, key: string) => (
    <View key={key} style={{ height: 32, width: 60, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", left: 29.5, top: 0, bottom: 0, width: 1, backgroundColor: colors.lineStrong }} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add step here"
        hitSlop={{ top: space.md, bottom: space.md, left: hitSlopFor(16), right: hitSlopFor(16) }}
        onPress={() => {
          tap();
          openAdd(routine.id, where);
        }}
        style={({ pressed }) => [
          {
            width: 16,
            height: 16,
            borderRadius: radius.full,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.page,
            borderWidth: 1,
            borderColor: colors.lineStrong,
          },
          pressStyle({ pressed }),
        ]}
      >
        <Icon icon={Add01Icon} tone="ink3" size={12} strokeWidth={2} />
      </Pressable>
    </View>
  );

  const pathLabel = (text: string) => <Tag label={text} square style={{ alignSelf: "flex-start" }} />;

  const list = (items: FlowStep[], parentId: string | null, branch: "yes" | "otherwise" | null, depth: number) =>
    items.map((step, index) => (
      <Fragment key={step.id}>
        {index > 0 ? connector({ parentId, branch, index }, `+${step.id}`) : null}
        {card(step)}
        {step.kind === "if" ? paths(step, depth + 1) : null}
      </Fragment>
    ));

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
                  style={({ pressed }) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.md,
                      minHeight: 44,
                      paddingHorizontal: space.lg,
                      borderRadius: radius.control,
                      borderCurve: "continuous",
                      backgroundColor: colors.inset,
                    },
                    pressStyle({ pressed }),
                  ]}
                >
                  <Icon icon={Add01Icon} tone="ink3" size={12} />
                  <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>Add step, or go straight on</Text>
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
        { flexDirection: "row", alignItems: "center", gap: space.lg, paddingVertical: space.lg, paddingHorizontal: space.lg },
        pressStyle({ pressed }),
      ]}
    >
      <StepTile look={TRIGGER_LOOK} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>
          {triggerTitle(routine.trigger)}
        </Text>
        <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
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
        <View style={{ width: 60, height: 20, alignItems: "center" }}>
          <View style={{ flex: 1, width: 1, backgroundColor: colors.lineStrong }} />
        </View>
        <View style={{ gap: space.xl, padding: space.xl, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.inset }}>
          <View style={{ gap: space.xs }}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              What should happen next?
            </Text>
            <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
              Each step can read what the trigger and earlier steps give.
            </Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            {FLOW_STEP_TYPES.map((stepType) => {
              const off = unavailable.has(stepType.kind);
              return (
                <Pressable
                  key={stepType.kind}
                  accessibilityRole="button"
                  accessibilityLabel={`${stepType.name}. ${off ? "Needs a Linear trigger" : stepType.description}`}
                  accessibilityState={{ disabled: off }}
                  disabled={off}
                  onPress={() => {
                    tap();
                    add(stepType.kind);
                  }}
                  style={({ pressed }) => [
                    styles.card,
                    {
                      flexBasis: "31%",
                      flexGrow: 1,
                      alignItems: "center",
                      gap: space.md,
                      paddingVertical: space.lg,
                      paddingHorizontal: space.sm,
                    },
                    pressStyle({ pressed, disabled: off }),
                  ]}
                >
                  <StepTile look={stepLook(stepType.kind)} size={30} />
                  <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>
                    {stepType.short}
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

function StartRow({ icon, title, onPress }: { icon: typeof Copy01Icon; title: string; onPress?: () => void }) {
  const { colors } = useTheme();
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 12 }}>
      <Icon icon={icon} tone="ink2" size={18} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
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
      style={({ pressed }) => pressStyle({ pressed, kind: "row" })}
    >
      {body}
    </Pressable>
  );
}
