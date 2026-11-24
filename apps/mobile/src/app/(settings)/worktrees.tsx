import { Stack } from "expo-router";
import { View } from "react-native";
import { SectionLabel } from "../../ui";
import { MacFeatureRow } from "../../mac-feature-row";
import { SettingsScroll } from "../../settings-find";
import { ImportSection, MainSyncSection } from "../../mac-settings-sections";

export default function WorktreesScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Worktrees" }} />
      <SettingsScroll>
        <MainSyncSection />
        <ImportSection />
        <View style={{ gap: 8 }}>
          <SectionLabel>Pull requests</SectionLabel>
          <MacFeatureRow
            read="babysit:settings:read"
            title="Babysit PRs"
            description="Watch every PR a Chat opens and fix review comments, failed checks and conflicts."
            href="/babysit-prs"
          />
        </View>
      </SettingsScroll>
    </>
  );
}
