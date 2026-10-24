import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { UsageSection } from "../../usage-section";

export default function UsageScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Plan usage" }} />
      <PageScroll>
        <UsageSection />
      </PageScroll>
    </>
  );
}
