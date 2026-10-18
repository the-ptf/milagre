import { ActivityIndicator, Platform, View } from "react-native";
import { Button as NativeButton, Host } from "@expo/ui";
import { controlSize } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../theme";
import { tap } from "./tap";

export function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
  loading = false,
  destructive = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  loading?: boolean;
  destructive?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ minHeight: 44, justifyContent: "center", alignItems: "center" }}>
      <Host ignoreSafeArea="all" matchContents seedColor={(destructive ? colors.red : colors.ink) as string}>
        <NativeButton
          label={title}
          variant={secondary ? "outlined" : "filled"}
          disabled={disabled || loading}
          onPress={() => {
            tap();
            onPress();
          }}
          modifiers={Platform.OS === "ios" ? [controlSize("large")] : undefined}
          style={{ height: 48 }}
        />
      </Host>
      {loading && <ActivityIndicator accessibilityLabel={title} style={{ position: "absolute", right: 12 }} color={colors.ink2} />}
    </View>
  );
}
