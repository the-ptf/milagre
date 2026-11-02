import { Stack } from "expo-router";
import { View } from "react-native";
import { SectionLabel } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { LinearSection } from "../../linear-section";

/** Settings › Connections: services the Mac signs in to, like desktop's Connections section. Linear first; more to come. */
export default function ConnectionsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Connections" }} />
      <SettingsScroll>
        <View style={{ gap: 8 }}>
          <SectionLabel>Issue trackers</SectionLabel>
          <LinearSection />
        </View>
      </SettingsScroll>
    </>
  );
}
