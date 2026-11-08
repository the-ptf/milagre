import { Stack } from "expo-router";
import { View } from "react-native";
import { SectionLabel } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { LinearSection } from "../../linear-section";
import { MacFeatureRow } from "../../mac-feature-row";

/** Settings › Integrations: services the Mac signs in to and Babysit PRs, like desktop's Integrations page. */
export default function ConnectionsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Integrations" }} />
      <SettingsScroll>
        <View style={{ gap: 8 }}>
          <SectionLabel>Issue trackers</SectionLabel>
          <LinearSection />
        </View>
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
