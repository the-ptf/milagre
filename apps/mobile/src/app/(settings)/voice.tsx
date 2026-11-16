import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { VoiceSection } from "../../voice-section";

export default function VoiceScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Voice" }} />
      <SettingsScroll>
        <VoiceSection />
      </SettingsScroll>
    </>
  );
}
