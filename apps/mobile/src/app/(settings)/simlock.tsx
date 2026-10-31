import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { SimlockSection } from "../../simlock-section";

export default function SimlockScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Simlock devices" }} />
      <SettingsScroll automaticallyAdjustKeyboardInsets>
        <SimlockSection />
      </SettingsScroll>
    </>
  );
}
