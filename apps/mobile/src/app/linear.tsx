import { Stack } from "expo-router";
import { PageScroll } from "../ui";
import { LinearSection } from "../linear-section";

export default function LinearScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Linear" }} />
      <PageScroll>
        <LinearSection />
      </PageScroll>
    </>
  );
}
