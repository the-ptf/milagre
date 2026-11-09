import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { ComputerUseSection } from "../../computer-use-section";

export default function ComputerUseScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Computer use" }} />
      <SettingsScroll>
        <ComputerUseSection />
      </SettingsScroll>
    </>
  );
}
