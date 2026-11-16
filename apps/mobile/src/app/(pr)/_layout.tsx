import { Stack, router } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HeaderButton } from "../../ui";
import { stackScreenOptions } from "../../stack-options";
import { useTheme } from "../../theme";

const closeButton = () => <HeaderButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />;

export default function PullRequestLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={({ navigation }) => ({
        ...stackScreenOptions(colors),
        // A page opened on its own (from the iPad panel) is the first in the sheet: nothing to go back to, so it closes.
        ...(!navigation.canGoBack() ? { headerLeft: closeButton } : {}),
      })}
    >
      <Stack.Screen name="pull-request" options={{ title: "", headerShown: false }} />
      <Stack.Screen name="pr-threads" options={{ title: "Comments" }} />
      <Stack.Screen name="pr-diff" options={{ title: "" }} />
      <Stack.Screen name="pr-review" options={{ title: "Review" }} />
      <Stack.Screen name="pr-labels" options={{ title: "Labels" }} />
      <Stack.Screen name="pr-reviewers" options={{ title: "Reviewers" }} />
    </Stack>
  );
}
