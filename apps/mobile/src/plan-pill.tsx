import { Pressable, Text } from "react-native";
import { ListTodoIcon } from "@hugeicons/core-free-icons";
import type { ChatPlan } from "@milagre/shared/model";
import { Icon } from "./icons";
import { planPillLabel } from "./plan-label";
import { useTheme } from "./theme";

/** Desktop's Tasks pill: done/total (or the current phase) in the composer row; a tap opens the plan sheet. Hidden without a plan. */
export function PlanPill({ plan, onPress }: { plan: ChatPlan | undefined; onPress: () => void }) {
  const { colors } = useTheme();
  const label = planPillLabel(plan);
  if (!label) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Tasks, ${label}`}
      accessibilityHint="Opens the task list and phase graph"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 34,
        paddingHorizontal: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon icon={ListTodoIcon} tone="ink2" size={15} />
      <Text style={{ color: colors.ink2, fontSize: 13, fontVariant: ["tabular-nums"] }}>{label}</Text>
    </Pressable>
  );
}
