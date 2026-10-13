import { useEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { taskCounts } from "@milagre/shared/chat-plan";
import { useSession } from "../session";
import { useStyles } from "../ui";
import { PlanPhaseGraph, PlanTree } from "../plan-view";
import { planPillLabel } from "../plan-label";

/** Desktop's Tasks popover as a sheet: the Chat's task tree and phase graph, live as the agent works. */
export default function PlanSheet() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const plan = id ? session.snapshot?.project?.state.sessions[Number(id)]?.plan : undefined;
  const missing = !planPillLabel(plan);
  // The plan went away (cleared, another host, a reset session): nothing to show.
  useEffect(() => {
    if (missing) router.back();
  }, [missing]);
  if (!plan || missing) return null;
  const { total } = taskCounts(plan.tasks);
  return (
    <ScrollView contentContainerStyle={{ paddingTop: 28, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 4, gap: 20 }}>
      {plan.tasks.length > 0 && (
        <View style={{ gap: 6 }}>
          <View style={[styles.row, { justifyContent: "space-between", flexWrap: "nowrap" }]}>
            <Text accessibilityRole="header" style={styles.subtitle}>
              Tasks
            </Text>
            <Text style={[styles.muted, { fontVariant: ["tabular-nums"] }]}>{total}</Text>
          </View>
          <PlanTree plan={plan} />
        </View>
      )}
      {plan.phases.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text accessibilityRole="header" style={styles.subtitle}>
            Phase graph
          </Text>
          <PlanPhaseGraph plan={plan} />
        </View>
      )}
    </ScrollView>
  );
}
