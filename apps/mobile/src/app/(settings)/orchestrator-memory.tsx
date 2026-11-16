import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { OrchestratorMemoryPage } from "../../orchestrator-memory-section";

export default function OrchestratorMemoryScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Memory" }} />
      <SettingsScroll>
        <OrchestratorMemoryPage />
      </SettingsScroll>
    </>
  );
}
