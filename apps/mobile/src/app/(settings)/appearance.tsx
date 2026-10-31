import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { AppearanceSection } from "../../appearance-section";

export default function AppearanceScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Appearance" }} />
      <SettingsScroll>
        <AppearanceSection />
      </SettingsScroll>
    </>
  );
}
