import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { KeybindingsSection } from "../../keybindings-section";

export default function KeybindingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Keybindings" }} />
      <PageScroll>
        <KeybindingsSection />
      </PageScroll>
    </>
  );
}
