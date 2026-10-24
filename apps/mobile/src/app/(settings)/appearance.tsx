import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { AppearanceSection } from "../../appearance-section";

export default function AppearanceScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Appearance" }} />
      <PageScroll>
        <AppearanceSection />
      </PageScroll>
    </>
  );
}
