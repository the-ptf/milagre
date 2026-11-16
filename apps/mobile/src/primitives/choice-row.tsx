import { Pressable, Text, View } from "react-native";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons";
import { lineHeight, space, type } from "../design-tokens";
import { useTheme } from "../theme";
import { Findable } from "../settings-find";
import { pressStyle } from "./press-style";
import { tap } from "./tap";

export function ChoiceRow({ title, selected, onPress }: { title: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Findable title={title}>
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={title}
        accessibilityState={{ checked: selected }}
        onPress={() => {
          tap();
          onPress();
        }}
        style={({ pressed }) => [{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.lg }, pressStyle({ pressed })]}
      >
        <Text style={{ flex: 1, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: selected ? "600" : "500", color: colors.ink }}>{title}</Text>
        <View style={{ width: 24 }}>{selected && <Icon icon={Tick02Icon} tone="ink" size={20} />}</View>
      </Pressable>
    </Findable>
  );
}
