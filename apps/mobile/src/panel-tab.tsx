import { Pressable, Text } from "react-native";
import { lineHeight, radius, type } from "./design-tokens";
import { Icon, type IconData, type Tone } from "./icons";
import { useTheme } from "./theme";
import { tap } from "./ui";

export function PanelTab({ label, icon, tone, selected, onPress }: { label: string; icon: IconData; tone: Tone; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: radius.full,
        borderCurve: "continuous",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: selected ? colors.hover2 : pressed ? colors.hover : "transparent",
      })}
    >
      <Icon icon={icon} tone={tone} size={16} />
      <Text
        style={{
          color: selected ? colors.ink : colors.ink2,
          fontSize: type.subheadline,
          lineHeight: lineHeight.subheadline,
          fontWeight: selected ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
