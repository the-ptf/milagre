import { Pressable, Text, View, type ColorValue } from "react-native";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons";
import { radius, type } from "../design-tokens";
import { useTheme } from "../theme";

/** The whole row is a target; standalone checkboxes keep the same 44pt hit area. */
export function Checkbox({
  label,
  selected,
  onPress,
  disabled = false,
  showLabel = true,
  tint,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  showLabel?: boolean;
  tint?: ColorValue;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      {showLabel && <Text style={{ flex: 1, fontSize: type.body, fontWeight: "500", color: colors.ink }}>{label}</Text>}
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: radius.chip,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: selected ? (tint ?? colors.ink) : colors.ink3,
          backgroundColor: selected ? (tint ?? colors.ink) : colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && <Icon icon={Tick02Icon} tone="onInk" size={16} strokeWidth={2} />}
      </View>
    </Pressable>
  );
}
