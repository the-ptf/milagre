import { Platform, View } from "react-native";
import { Host, Switch } from "@expo/ui";
import { accessibilityLabel, labelsHidden, tint } from "@expo/ui/swift-ui/modifiers";
import { semantics } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "../theme";

/** A switch with no visible label, for the trailing end of a row that names it; `label` is what VoiceOver and TalkBack read. */
export function RowSwitch({ selected, onPress, disabled = false, label }: { selected: boolean; onPress: () => void; disabled?: boolean; label: string }) {
  const { colors } = useTheme();
  return (
    // The native switch keeps its own semantics and takes the label itself (a wrapper with a role would hide the Compose
    // switch from TalkBack).
    <View>
      <Host ignoreSafeArea="all" matchContents seedColor={colors.ink as string}>
        <Switch
          value={selected}
          disabled={disabled}
          onValueChange={onPress}
          modifiers={Platform.OS === "ios" ? [labelsHidden(), accessibilityLabel(label), tint(colors.ink)] : [semantics({ contentDescription: label })]}
        />
      </Host>
    </View>
  );
}
