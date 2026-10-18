import { type ColorValue } from "react-native";
import { Host, Switch } from "@expo/ui";
import { useTheme } from "../theme";

export function Toggle({
  title,
  selected,
  onPress,
  disabled = false,
  tint: seed,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** The switch's on color; green unless a screen asks for another (the MCP screens use ink). */
  tint?: ColorValue;
}) {
  const { colors } = useTheme();
  return (
    <Host ignoreSafeArea="all" matchContents={{ vertical: true }} style={{ minHeight: 44 }} seedColor={(seed ?? colors.green) as string}>
      <Switch label={title} value={selected} disabled={disabled} onValueChange={onPress} />
    </Host>
  );
}
