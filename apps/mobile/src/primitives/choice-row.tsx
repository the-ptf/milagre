import { Pressable, Text, View } from "react-native";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons";
import { type } from "../design-tokens";
import { useTheme } from "../theme";
import { Findable } from "../settings-find";

/** One item in a single-choice list, with a checkmark beside the active choice. */
export function ChoiceRow({ title, selected, onPress }: { title: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Findable title={title}>
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={title}
        accessibilityState={{ checked: selected }}
        onPress={onPress}
        style={({ pressed }) => ({ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, opacity: pressed ? 0.6 : 1 })}
      >
        <Text style={{ flex: 1, fontSize: type.body, fontWeight: selected ? "600" : "500", color: colors.ink }}>{title}</Text>
        <View style={{ width: 24 }}>{selected && <Icon icon={Tick02Icon} tone="accentInk" size={20} />}</View>
      </Pressable>
    </Findable>
  );
}
