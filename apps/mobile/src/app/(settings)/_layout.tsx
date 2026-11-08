import { Stack, router } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HeaderButton } from "../../ui";
import { stackScreenOptions } from "../../stack-options";
import { useTheme } from "../../theme";
import { SettingsSplit } from "../../settings-split";

// Opening a settings page by its own address (a link, the usage card's Manage accounts) still puts Settings under it.
export const unstable_settings = { anchor: "settings" };

const closeButton = () => <HeaderButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />;

/**
 * Settings is one bottom sheet with a Stack of its own: the root layout presents this group as a single formSheet, so a
 * page opened from Settings slides in inside the sheet, back pops it, and a swipe down closes the whole sheet. On a wide
 * iPad the list sits beside the Stack instead of being its first page (SettingsSplit).
 */
export default function SettingsLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      layout={SettingsSplit}
      screenOptions={({ navigation, route }) => ({
        ...stackScreenOptions(colors),
        // A page opened by its own address (Manage accounts on a usage card) is the first one in the sheet: nothing to go back to, so it closes.
        ...(!navigation.canGoBack() && route.name !== "settings" ? { headerLeft: closeButton } : {}),
      })}
    >
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="computers" options={{ title: "Computers" }} />
      <Stack.Screen name="computer" options={{ title: "" }} />
      <Stack.Screen name="computer-usage" options={{ title: "What Milagre uses" }} />
      <Stack.Screen name="computer-cleanup" options={{ title: "Clean up worktrees" }} />
      <Stack.Screen name="accounts" options={{ title: "Accounts" }} />
      <Stack.Screen name="browser-settings" options={{ title: "Browser" }} />
      <Stack.Screen name="connections" options={{ title: "Integrations" }} />
      <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
      <Stack.Screen name="chat-display" options={{ title: "Chat" }} />
      <Stack.Screen name="voice" options={{ title: "Voice" }} />
      <Stack.Screen name="models" options={{ title: "Models" }} />
      <Stack.Screen name="worktrees" options={{ title: "Worktrees" }} />
      <Stack.Screen name="phone-sharing" options={{ title: "Phone & sharing" }} />
      <Stack.Screen name="this-mac" options={{ title: "This Mac" }} />
      <Stack.Screen name="dictation-language" options={{ title: "Dictation language" }} />
      <Stack.Screen name="dictation-model" options={{ title: "Speech model" }} />
      <Stack.Screen name="keybindings" options={{ title: "Keybindings" }} />
      <Stack.Screen name="archived" options={{ title: "Archived Chats" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="usage" options={{ title: "Plan usage" }} />
      <Stack.Screen name="token-usage" options={{ title: "Token usage" }} />
      <Stack.Screen name="skills" options={{ title: "Skills" }} />
      <Stack.Screen name="skill" options={{ title: "Skill" }} />
      <Stack.Screen name="mcp" options={{ title: "MCP" }} />
      <Stack.Screen name="mcp-server" />
      <Stack.Screen name="experimental" options={{ title: "Church" }} />
      <Stack.Screen name="babysit-prs" options={{ title: "Babysit PRs" }} />
      <Stack.Screen name="simlock" options={{ title: "Simlock devices" }} />
      <Stack.Screen name="computer-use" options={{ title: "Computer use" }} />
      <Stack.Screen name="project-settings" options={{ title: "Project" }} />
      <Stack.Screen name="published-pages" />
    </Stack>
  );
}
