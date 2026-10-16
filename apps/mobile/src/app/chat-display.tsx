import { Stack } from "expo-router";
import { PageScroll } from "../ui";
import { ChatDisplaySection } from "../chat-display-section";

export default function ChatDisplayScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Chat" }} />
      <PageScroll>
        <ChatDisplaySection />
      </PageScroll>
    </>
  );
}
