import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { VoiceSection } from "../../voice-section";

/** Settings › Voice: dictation, kept on this phone, like desktop's Voice page. */
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
