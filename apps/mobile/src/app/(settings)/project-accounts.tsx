import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { ProjectAccountsSection } from "../../project-accounts-section";

export default function ProjectAccountsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Project Accounts" }} />
      <PageScroll>
        <ProjectAccountsSection />
      </PageScroll>
    </>
  );
}
