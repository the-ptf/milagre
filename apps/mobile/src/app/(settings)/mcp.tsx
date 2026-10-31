import { Platform } from "react-native";
import { Stack, router } from "expo-router";
import { Add01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HeaderButton } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { McpSection } from "../../mcp-section";
import { useMcp } from "../../use-mcp";

const add = () => router.push("/mcp-add");

export default function McpScreen() {
  const mcp = useMcp();
  // The page draws its own large title under the bar, so the bar carries only Refresh and Add.
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      {/* Stack.Toolbar takes its buttons as direct children (a Fragment is refused), so each slot picks its own element. */}
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="arrow.clockwise" accessibilityLabel="Refresh" disabled={mcp.checking} onPress={() => void mcp.refresh()} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="Refresh" icon={RefreshIcon} onPress={mcp.checking ? undefined : () => void mcp.refresh()} />
          </Stack.Toolbar.View>
        )}
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="plus" accessibilityLabel="Add MCP server" onPress={add} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="Add MCP server" icon={Add01Icon} onPress={add} />
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
      <SettingsScroll>
        <McpSection />
      </SettingsScroll>
    </>
  );
}
