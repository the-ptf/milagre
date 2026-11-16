import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { GlassSurface } from "./glass-surface";
import { radius } from "../design-tokens";
import { Icon, type IconData } from "../icons";
import { useTheme } from "../theme";
import { tap } from "./tap";

/** One glass surface for the Chat's Browser, PR and menu, in native and split headers. */
export function HeaderActionGroup({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", borderRadius: radius.full, borderCurve: "continuous" }}>
      <GlassSurface />
      {children}
    </View>
  );
}

export function HeaderAction({ label, icon, iconSize = 20, onPress }: { label: string; icon: IconData; iconSize?: number; onPress?: () => void }) {
  const { colors } = useTheme();
  const style = { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.full, borderCurve: "continuous" } as const;
  const content = <Icon icon={icon} size={iconSize} tone="ink" />;
  if (!onPress) return <View style={style}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [style, pressed && { backgroundColor: colors.hover }]}
    >
      {content}
    </Pressable>
  );
}
