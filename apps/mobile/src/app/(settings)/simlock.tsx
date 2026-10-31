import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { SimlockSection } from "../../simlock-section";

export default function SimlockScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Simlock devices" }} />
      <PageScroll automaticallyAdjustKeyboardInsets>
        <SimlockSection />
      </PageScroll>
    </>
  );
}
