import { Pressable, View } from "react-native";
import { Icon, type IconData } from "../icons";
import { tap } from "./tap";

/** A bar button for the native header; iOS draws the round glass background itself. */
export function HeaderButton({ label, icon, iconSize = 20, onPress }: { label: string; icon: IconData; iconSize?: number; onPress?: () => void }) {
  const body = (
    <View accessible accessibilityRole="button" accessibilityLabel={label} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
      <Icon icon={icon} size={iconSize} tone="ink" />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
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
