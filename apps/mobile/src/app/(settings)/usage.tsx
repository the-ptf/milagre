import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { UsageSection } from "../../usage-section";
import { UsageTabs } from "../../usage-tabs";

export default function UsageScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Usage" }} />
      <SettingsScroll>
        <UsageTabs value="plan" />
        <UsageSection header />
      </SettingsScroll>
    </>
  );
}
