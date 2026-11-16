import { Stack, router } from "expo-router";
import { Text, View } from "react-native";
import { IMPORT_INTRO, IMPORT_TITLE } from "@milagre/shared/ade-import";
import { SettingsScroll } from "../../settings-find";
import { MainSyncSection } from "../../mac-settings-sections";
import { Row } from "../../settings-list";
import { useStyles } from "../../ui";

export default function WorktreesScreen() {
  const styles = useStyles();
  return (
    <>
      <Stack.Screen options={{ title: "Worktrees" }} />
      <SettingsScroll>
        <MainSyncSection />
        <View style={{ gap: 8 }}>
          <Text style={styles.section}>Add Project</Text>
          <View style={[styles.card, { gap: 4 }]}>
            <Row title={IMPORT_TITLE} onPress={() => router.push("/import")} />
            <Text style={styles.caption}>{IMPORT_INTRO}</Text>
          </View>
        </View>
      </SettingsScroll>
    </>
  );
}
