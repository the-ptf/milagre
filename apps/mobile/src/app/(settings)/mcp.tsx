import { useState } from "react";
import { Platform, View } from "react-native";
import { Stack } from "expo-router";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HeaderButton, SectionLabel, Segmented } from "../../ui";
import { SettingsScroll } from "../../settings-find";
import { McpSection } from "../../mcp-section";
import { ConnectorsSection } from "../../connectors-section";
import { LocalMcpSection } from "../../local-mcp-section";
import { useMcp } from "../../use-mcp";

const VIEWS = [
  { value: "connectors", title: "Connectors" },
  { value: "mcp", title: "MCP servers" },
];

export default function McpScreen() {
  const mcp = useMcp();
  const [view, setView] = useState("connectors");
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      {view === "mcp" ? (
        <Stack.Toolbar placement="right">
          {Platform.OS === "ios" ? (
            <Stack.Toolbar.Button icon="arrow.clockwise" accessibilityLabel="Refresh" disabled={mcp.checking} onPress={() => void mcp.refresh()} />
          ) : (
            <Stack.Toolbar.View>
              <HeaderButton label="Refresh" icon={RefreshIcon} disabled={mcp.checking} onPress={() => void mcp.refresh()} />
            </Stack.Toolbar.View>
          )}
        </Stack.Toolbar>
      ) : null}
      <SettingsScroll>
        <Segmented label="Show" value={view} options={VIEWS} onChange={setView} />
        {view === "connectors" ? (
          <ConnectorsSection />
        ) : (
          <>
            <McpSection />
            <View style={{ gap: 8 }}>
              <SectionLabel>Milagre MCP</SectionLabel>
              <LocalMcpSection />
            </View>
          </>
        )}
      </SettingsScroll>
    </>
  );
}
