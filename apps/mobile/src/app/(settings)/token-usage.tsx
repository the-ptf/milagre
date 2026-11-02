import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { TokenUsageSection } from "../../token-usage-section";
import { UsageTabs } from "../../usage-tabs";

export default function TokenUsageScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Usage" }} />
      <SettingsScroll>
        <UsageTabs value="analytics" />
        <TokenUsageSection />
      </SettingsScroll>
    </>
  );
}
