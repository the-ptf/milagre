import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { BabysitSection } from "../../babysit-section";

export default function BabysitPrsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Babysit PRs" }} />
      <PageScroll automaticallyAdjustKeyboardInsets>
        <BabysitSection />
      </PageScroll>
    </>
  );
}
