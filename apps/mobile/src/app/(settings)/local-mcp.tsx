import { View } from "react-native";
import { Stack } from "expo-router";
import { PageScroll, SectionLabel } from "../../ui";
import { PublishedPagesSection } from "../../published-pages-section";
import { LocalMcpSection } from "../../local-mcp-section";

/** Settings › Milagre: Designs and artifacts, then the Milagre MCP, like desktop's Milagre section. */
export default function MilagreScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Milagre" }} />
      <PageScroll>
        <View style={{ gap: 24 }}>
          <View style={{ gap: 8 }}>
            <SectionLabel>Designs and artifacts</SectionLabel>
            <PublishedPagesSection />
          </View>
          <View style={{ gap: 8 }}>
            <SectionLabel>Milagre MCP</SectionLabel>
            <LocalMcpSection />
          </View>
        </View>
      </PageScroll>
    </>
  );
}
