import { Platform, type ColorValue } from "react-native";
import { Host, Switch } from "@expo/ui";
import { font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../theme";

/**
 * A labelled switch row: the label at body 17 in the theme's ink (SwiftUI would draw it in the system black or white),
 * the switch ink when on. On Android the Material switch derives its colours from the ink seed (@expo/ui's universal
 * Switch doesn't take explicit Compose colours).
 */
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
  /** @deprecated Switches are ink (system.md); kept so existing callers compile. */
  tint?: ColorValue;
}) {
  const { colors } = useTheme();
  return (
    <Host ignoreSafeArea="all" matchContents={{ vertical: true }} style={{ minHeight: 44 }} seedColor={(seed ?? colors.ink) as string}>
      <Switch
        label={title}
        value={selected}
        disabled={disabled}
        onValueChange={onPress}
        modifiers={Platform.OS === "ios" ? [font({ textStyle: "body" }), foregroundStyle(colors.ink)] : undefined}
      />
    </Host>
  );
}
