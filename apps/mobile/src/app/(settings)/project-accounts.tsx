import { Stack } from "expo-router";
import { SettingsScroll } from "../../settings-find";
import { ProjectAccountsSection } from "../../project-accounts-section";

export default function ProjectAccountsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Project Accounts" }} />
      <SettingsScroll>
        <ProjectAccountsSection />
      </SettingsScroll>
    </>
  );
}
