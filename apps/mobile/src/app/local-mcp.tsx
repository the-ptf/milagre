import { Stack } from "expo-router";
import { PageScroll } from "../ui";
import { LocalMcpSection } from "../local-mcp-section";

export default function LocalMcpScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Milagre MCP" }} />
      <PageScroll>
        <LocalMcpSection />
      </PageScroll>
    </>
  );
}
