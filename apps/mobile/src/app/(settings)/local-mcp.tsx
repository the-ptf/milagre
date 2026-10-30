import { View } from "react-native";
import { Stack } from "expo-router";
import { PageScroll, SectionLabel } from "../../ui";
import { PublishedPagesSection } from "../../published-pages-section";
import { LocalMcpSection } from "../../local-mcp-section";

/** Settings › Milagre: Designs and artifacts, then the Milagre MCP, like desktop's Milagre section. */
export default function MilagreScreen() {
  const header = (title: string) => <SectionLabel style={{ paddingHorizontal: 16 }}>{title}</SectionLabel>;
  return (
    <>
      <Stack.Screen options={{ title: "Milagre" }} />
      <PageScroll>
        <View style={{ gap: 24 }}>
          <View style={{ gap: 8 }}>
            {header("Designs and artifacts")}
            <PublishedPagesSection />
          </View>
          <View style={{ gap: 8 }}>
            {header("Milagre MCP")}
            <LocalMcpSection />
          </View>
        </View>
      </PageScroll>
    </>
  );
}
