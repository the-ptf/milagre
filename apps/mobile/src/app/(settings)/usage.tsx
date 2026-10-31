import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { UsageSection } from "../../usage-section";

export default function UsageScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Plan usage" }} />
      <SettingsScroll>
        <UsageSection />
      </SettingsScroll>
    </>
  );
}
