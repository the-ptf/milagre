import { View } from "react-native";
import { router } from "expo-router";
import { Segmented } from "./ui";

const VIEWS = [
  { value: "plan", title: "Plan usage" },
  { value: "analytics", title: "Analytics" },
];

export function UsageTabs({ value }: { value: "plan" | "analytics" }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 200 }}>
      <Segmented
        label="Usage view"
        value={value}
        options={VIEWS}
        onChange={(next) => {
          if (next !== value) router.replace(next === "plan" ? "/(settings)/usage" : "/(settings)/token-usage");
        }}
      />
    </View>
  );
}
