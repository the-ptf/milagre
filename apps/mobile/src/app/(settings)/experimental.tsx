import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { ExperimentalSection } from "../../experimental-section";

export default function ExperimentalScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Experimental" }} />
      <PageScroll>
        <ExperimentalSection />
      </PageScroll>
    </>
  );
}
