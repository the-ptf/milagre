import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { AccountsSection } from "../../accounts-section";
import { LimitAutoSwitchSection } from "../../limit-switch-section";

export default function AccountsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Accounts" }} />
      <PageScroll>
        <AccountsSection />
        <LimitAutoSwitchSection />
      </PageScroll>
    </>
  );
}
