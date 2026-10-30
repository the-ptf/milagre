import { Stack } from "expo-router";
import { View } from "react-native";
import { PageScroll, SectionLabel } from "../../ui";
import { LinearSection } from "../../linear-section";

/** Settings › Connections: services the Mac signs in to, like desktop's Connections section. Linear first; more to come. */
export default function ConnectionsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Connections" }} />
      <PageScroll>
        <View style={{ gap: 8 }}>
          <SectionLabel>Issue trackers</SectionLabel>
          <LinearSection />
        </View>
      </PageScroll>
    </>
  );
}
