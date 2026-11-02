import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { ExperimentalSection } from "../../experimental-section";

export default function ExperimentalScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Experimental" }} />
      <SettingsScroll>
        <ExperimentalSection />
      </SettingsScroll>
    </>
  );
}
