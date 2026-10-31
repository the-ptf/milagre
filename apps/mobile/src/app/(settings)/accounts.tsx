import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { AccountsSection } from "../../accounts-section";
import { LimitAutoSwitchSection } from "../../limit-switch-section";

export default function AccountsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Accounts" }} />
      <SettingsScroll>
        <AccountsSection />
        <LimitAutoSwitchSection />
      </SettingsScroll>
    </>
  );
}
