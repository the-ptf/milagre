import { View } from "react-native";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { radius } from "../design-tokens";
import { Icon } from "../icons";
import { useTheme } from "../theme";

/** The 20pt box of a checkbox row (CheckRow `kind="checkbox"`): ink fill with an onInk tick when checked, a 1pt ink3 edge when not. */
export function CheckboxBox({ checked }: { checked: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: radius.chip,
        borderCurve: "continuous",
        borderWidth: checked ? 0 : 1,
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
