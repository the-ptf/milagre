import { View } from "react-native";
import { Icon } from "./icons";
import type { StepLook } from "./flow-looks";
import { useTheme } from "./theme";

export function StepTile({ look, size = 36 }: { look: StepLook; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors[look.tint] as string,
      }}
    >
      <Icon icon={look.icon} tone={look.tone} size={Math.round(size * 0.5)} />
    </View>
  );
}
