import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { ExperimentalSection } from "../../experimental-section";

export default function ChurchScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Church" }} />
      <SettingsScroll>
        <ExperimentalSection />
      </SettingsScroll>
    </>
  );
}
