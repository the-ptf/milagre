import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { MainSyncSection } from "../../mac-settings-sections";

/** Settings › Worktrees: the connected Mac's default for new Worktrees, like desktop's Worktrees page. */
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
