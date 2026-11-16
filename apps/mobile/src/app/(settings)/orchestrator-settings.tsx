import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { OrchestratorSettingsPage } from "../../orchestrator-settings-section";

export default function OrchestratorSettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Orchestrator" }} />
      <SettingsScroll automaticallyAdjustKeyboardInsets>
        <OrchestratorSettingsPage />
      </SettingsScroll>
    </>
  );
}
