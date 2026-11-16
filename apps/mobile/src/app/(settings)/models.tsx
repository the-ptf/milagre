import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { ContextSettingsSection } from "../../context-settings-section";

export default function ModelsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Models" }} />
      <SettingsScroll>
        <ContextSettingsSection />
      </SettingsScroll>
    </>
  );
}
