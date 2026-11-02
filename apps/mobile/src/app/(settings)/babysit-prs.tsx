import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { BabysitSection } from "../../babysit-section";

export default function BabysitPrsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Babysit PRs" }} />
      <SettingsScroll automaticallyAdjustKeyboardInsets>
        <BabysitSection />
      </SettingsScroll>
    </>
  );
}
