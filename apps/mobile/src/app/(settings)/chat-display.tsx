import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { ChatDisplaySection } from "../../chat-display-section";

export default function ChatDisplayScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Chat" }} />
      <SettingsScroll>
        <ChatDisplaySection />
      </SettingsScroll>
    </>
  );
}
