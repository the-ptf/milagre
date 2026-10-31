import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { GeneralSection } from "../../general-section";

export default function GeneralScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "General" }} />
      <SettingsScroll>
        <GeneralSection />
      </SettingsScroll>
    </>
  );
}
