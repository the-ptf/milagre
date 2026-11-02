import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FLOW_LIMITS, FLOW_STEP_TYPES, flattenSteps, insertStep, newStep } from "@milagre/shared/routine-flows";
import type { FlowStepKind } from "@milagre/shared/model";
import { useSession } from "../session";
import { useRoutines } from "../use-routines";
import { useFlowDraft } from "../flow-draft";
import { openStep, unavailableKinds } from "../flow-editor";
import { stepLook } from "../flow-looks";
import { StepTile } from "../flow-ui";
import { tap, useStyles } from "../ui";
import { useTheme } from "../theme";

/**
 * The Add step sheet: the step types, each with its icon and what it does. A pick adds the step at the place the "+" was
 * tapped and, once the sheet has gone, opens it in the step editor. An If that would nest deeper than a flow allows, and a
 * Linear comment under another trigger, can't be picked.
 */
export default function FlowAddStepSheet() {
  const params = useLocalSearchParams<{ id: string; parent?: string; branch?: string; index?: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useSession();
  const routines = useRoutines(client);
  const routine = routines.routines.find((item) => item.id === params.id);
  const draft = useFlowDraft(client, routine, routines.update);
  const parentId = params.parent || null;
  const branch = params.branch === "yes" || params.branch === "otherwise" ? params.branch : null;
  const index = Number(params.index ?? 0) || 0;
  // How deep the new step would sit: one below the If it goes under.
  const parentDepth = parentId ? (flattenSteps(draft.steps).find((entry) => entry.step.id === parentId)?.depth ?? 0) : -1;
  const unavailable = unavailableKinds(routine?.trigger.kind ?? "");
  const tooDeep = parentDepth + 1 >= FLOW_LIMITS.depth;
  // The step added; it opens once the sheet is gone, so the editor's sheet never fights this one's dismissal.
  const added = useRef("");
  const routineId = routine?.id ?? "";
  useEffect(
    () => () => {
      if (added.current) {
        const stepId = added.current;
        setTimeout(() => openStep(routineId, stepId), 50);
      }
    },
    [routineId],
  );

  const pick = (kind: FlowStepKind) => {
    if (!routine) return;
    const step = newStep(kind, draft.steps);
    try {
      draft.edit(insertStep(draft.steps, { parentId, branch, index }, step));
    } catch {
      // The place is gone (its If was deleted elsewhere): add nothing.
      router.back();
      return;
    }
    added.current = step.id;
    router.back();
  };

  return (
    <View style={{ paddingTop: 24, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 4, gap: 14 }}>
      <Text accessibilityRole="header" style={[styles.subtitle, { textAlign: "center" }]}>
        Add step
      </Text>
      <View style={{ gap: 4 }}>
        {FLOW_STEP_TYPES.map((type) => {
          const off = unavailable.has(type.kind) || (type.kind === "if" && tooDeep);
          const why = unavailable.has(type.kind) ? "Needs a Linear trigger" : type.kind === "if" && tooDeep ? `Ifs nest ${FLOW_LIMITS.depth} deep at most` : "";
          return (
            <Pressable
              key={type.kind}
              accessibilityRole="button"
              accessibilityLabel={`${type.name}. ${why || type.description}`}
              accessibilityState={{ disabled: off }}
              disabled={off || !routine}
              onPress={() => {
                tap();
                pick(type.kind);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 60,
                paddingHorizontal: 10,
                paddingVertical: 10,
                borderRadius: 14,
                borderCurve: "continuous",
                backgroundColor: pressed ? colors.hover : "transparent",
                opacity: off ? 0.4 : 1,
              })}
            >
              <StepTile look={stepLook(type.kind)} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>{type.name}</Text>
                <Text numberOfLines={2} style={{ color: colors.ink3, fontSize: 13, lineHeight: 18 }}>
                  {why || type.description}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
