import { Stack, router } from "expo-router";
import { Text, View } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { CircleButton, PageScroll, useStyles } from "../ui";
import { Markdown } from "../markdown";
import { lineHeight, type } from "../design-tokens";
import { useAppUpdates } from "../update-sheet";
import { useTheme } from "../theme";

export default function UpdateNotesScreen() {
  const { state } = useAppUpdates();
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View collapsable={false} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: "What's new" }} />
      <View collapsable={false} style={{ flexDirection: "row", alignItems: "center", padding: 16 }}>
        <Text accessibilityRole="header" style={{ flex: 1, fontSize: type.title2, lineHeight: lineHeight.title2, fontWeight: "600", color: colors.ink }}>
          {"What's new"}
        </Text>
        <CircleButton label="Close release notes" icon={Cancel01Icon} onPress={() => router.back()} />
      </View>
      <PageScroll style={{ flex: 1 }}>
        {state.releaseNotes ? <Markdown text={state.releaseNotes} /> : <Text style={styles.muted}>No release notes were published for this update.</Text>}
      </PageScroll>
    </View>
  );
}
