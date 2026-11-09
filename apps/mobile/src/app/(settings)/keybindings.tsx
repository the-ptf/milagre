import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { KeybindingsSection } from "../../keybindings-section";

export default function KeybindingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Keybindings" }} />
      <SettingsScroll>
        <KeybindingsSection />
      </SettingsScroll>
    </>
  );
}
