import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { AccountsSection } from "../../accounts-section";
import { LimitAutoSwitchSection } from "../../limit-switch-section";
import { ProjectAccountsSection } from "../../project-accounts-section";
import { View } from "react-native";
import { SectionLabel } from "../../ui";

/** Settings › Accounts: saved accounts, usage-limit switching, and which account each Project or Link uses (was Project Accounts). */
export default function AccountsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Accounts" }} />
      <SettingsScroll>
        <AccountsSection />
        <LimitAutoSwitchSection />
        <View style={{ gap: 8 }}>
          <SectionLabel>Per Project</SectionLabel>
          <ProjectAccountsSection onAccountsPage />
        </View>
      </SettingsScroll>
    </>
  );
}
