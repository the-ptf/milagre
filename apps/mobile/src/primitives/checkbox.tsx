import { Pressable, View } from "react-native";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { hitSlopFor, radius } from "../design-tokens";
import { Icon } from "../icons";
import { useTheme } from "../theme";
import { tap } from "./tap";
import { pressStyle } from "./press-style";

/** The 20pt box: ink fill with an onInk tick when checked, an ink3 outline when not. */
export function CheckboxBox({ checked }: { checked: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: radius.chip,
        borderCurve: "continuous",
        borderWidth: checked ? 0 : 1.5,
        borderColor: colors.ink3,
        backgroundColor: checked ? colors.ink : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && <Icon icon={Tick02Icon} tone="onInk" size={16} />}
    </View>
  );
}

/** A standalone checkbox with a 44pt target. Inside a row, use CheckRow (the whole row is the target). */
export function Checkbox({ label, checked, onPress, disabled = false }: { label: string; checked: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      hitSlop={hitSlopFor(20)}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => pressStyle({ pressed, disabled })}
    >
      <CheckboxBox checked={checked} />
    </Pressable>
  );
}
