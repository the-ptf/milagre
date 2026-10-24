import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { GeneralSection } from "../../general-section";

export default function GeneralScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "General" }} />
      <PageScroll>
        <GeneralSection />
      </PageScroll>
    </>
  );
}
