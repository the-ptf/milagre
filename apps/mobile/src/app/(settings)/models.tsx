import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { ContextSettingsSection } from "../../context-settings-section";

/** Settings › Models: how the connected Mac's agents compact their context, like desktop's Models page. */
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
