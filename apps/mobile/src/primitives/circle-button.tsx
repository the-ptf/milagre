import { Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import { Icon, type IconData } from "../icons";
import { tap } from "./tap";

/** The round bordered buttons inside sheets (close, back, done). */
export function CircleButton({
  label,
  icon,
  iconSize = 20,
  onPress,
  filled = false,
}: {
  label: string;
  icon: IconData;
  iconSize?: number;
  onPress?: () => void;
  filled?: boolean;
}) {
  const { colors } = useTheme();
  const body = (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? colors.accent : colors.surface,
        borderWidth: filled ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors.lineStrong,
      }}
    >
      <Icon icon={icon} size={iconSize} tone={filled ? "onAccent" : "ink"} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      {body}
    </Pressable>
  );
}
