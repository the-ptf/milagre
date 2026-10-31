import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { ComputerUseSection } from "../../computer-use-section";

export default function ComputerUseScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Computer use" }} />
      <PageScroll>
        <ComputerUseSection />
      </PageScroll>
    </>
  );
}
