import { Pressable, View } from "react-native";
import { hitSlopFor } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { tap } from "./tap";
import { pressStyle } from "./press-style";

/**
 * A bar button for the native header; iOS draws the round glass background itself. `disabled` (or no `onPress`) keeps
 * the button role and label, dims it and reads as dimmed.
 */
export function HeaderButton({ label, icon, onPress, disabled = false }: { label: string; icon: IconData; onPress?: () => void; disabled?: boolean }) {
  const off = disabled || !onPress;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off }}
      hitSlop={hitSlopFor(36)}
      disabled={off}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => pressStyle({ pressed, disabled: off })}
    >
      <View style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
        <Icon icon={icon} size={20} tone="ink" />
      </View>
    </Pressable>
  );
}
