import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useTheme } from "./theme";
import { type } from "./design-tokens";

/** Keep both existing Settings routes reachable through the same Usage navigation. */
export function UsageTabs({ value }: { value: "plan" | "analytics" }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Usage view"
      style={{ flexDirection: "row", gap: 16, borderBottomWidth: 1, borderBottomColor: colors.line }}
    >
      {(["plan", "analytics"] as const).map((tab) => (
        <Pressable
          key={tab}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === tab }}
          onPress={() => {
            if (tab !== value) router.replace(tab === "plan" ? "/(settings)/usage" : "/(settings)/token-usage");
          }}
          style={({ pressed }) => ({
            minHeight: 44,
            justifyContent: "center",
            borderBottomWidth: 2,
            borderBottomColor: value === tab ? colors.ink : "transparent",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: value === tab ? colors.ink : colors.ink3, fontSize: type.footnote, fontWeight: "600" }}>
            {tab === "plan" ? "Plan usage" : "Analytics"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
