import { Stack, router } from "expo-router";
import { Text, View } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { IconButton, PageScroll } from "../ui";
import { Markdown } from "../markdown";
import { useAppUpdates } from "../update-sheet";
import { useTheme } from "../theme";

export default function UpdateNotesScreen() {
  const { state } = useAppUpdates();
  const { colors } = useTheme();
  return (
    <View collapsable={false} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: "What's new" }} />
      <View collapsable={false} style={{ flexDirection: "row", alignItems: "center", padding: 20 }}>
        <Text accessibilityRole="header" style={{ flex: 1, fontSize: 24, fontWeight: "600", color: colors.ink }}>
          {"What's new"}
        </Text>
        <IconButton label="Close release notes" icon={Cancel01Icon} onPress={() => router.back()} />
      </View>
      <PageScroll style={{ flex: 1 }}>
        {state.releaseNotes ? (
          <Markdown text={state.releaseNotes} />
        ) : (
          <Text style={{ color: colors.ink2, fontSize: 16, lineHeight: 23 }}>No release notes were published for this update.</Text>
        )}
      </PageScroll>
    </View>
  );
}
