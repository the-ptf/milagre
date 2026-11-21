import { View } from "react-native";
import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { SectionLabel } from "../../ui";
import { PublishedPagesSection } from "../../published-pages-section";
import { MacFeatureRow } from "../../mac-feature-row";
import { BaguetteRow } from "../../baguette-row";

export default function PhoneSharingScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Phone & sharing" }} />
      <SettingsScroll>
        <View style={{ gap: 24 }}>
          <View style={{ gap: 8 }}>
            <SectionLabel>Simulators</SectionLabel>
            <BaguetteRow />
            <MacFeatureRow
              read="simlock:settings:read"
              title="Simlock devices"
              description="Agents lease a simulator or emulator of their own from a Simlock pool and return it wiped."
              href="/simlock"
            />
          </View>
          <View style={{ gap: 8 }}>
            <SectionLabel>Designs and artifacts</SectionLabel>
            <PublishedPagesSection />
          </View>
        </View>
      </SettingsScroll>
    </>
  );
}
