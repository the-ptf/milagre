import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { MainSyncSection } from "../../mac-settings-sections";

export default function WorktreesScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Worktrees" }} />
      <SettingsScroll>
        <MainSyncSection />
      </SettingsScroll>
    </>
  );
}
