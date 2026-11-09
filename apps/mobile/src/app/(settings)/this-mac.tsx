import { View } from "react-native";
import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { SectionLabel } from "../../ui";
import { MacUpdatesSection } from "../../mac-settings-sections";
import { MacFeatureRow } from "../../mac-feature-row";
import { useSession } from "../../session";

/** Settings › This Mac: the connected Mac's Milagre update and Computer use, like desktop's This Mac page. */
export default function ThisMacScreen() {
  const session = useSession();
  const host = session.client ? session.hosts.find((saved) => saved.id === session.client?.url) : undefined;
  return (
    <>
      <Stack.Screen options={{ title: host?.name || session.hostName || "This Mac" }} />
      <SettingsScroll>
        <View style={{ gap: 24 }}>
          <MacUpdatesSection />
          <View style={{ gap: 8 }}>
            <SectionLabel>Automation</SectionLabel>
            <MacFeatureRow
              read="computer-use:settings:read"
              title="Computer use"
              description="Agents see and operate apps on the Mac, asking before each new app."
              href="/computer-use"
            />
          </View>
        </View>
      </SettingsScroll>
    </>
  );
}
