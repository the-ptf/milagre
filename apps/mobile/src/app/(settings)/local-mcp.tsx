import { Text, View } from "react-native";
import { Stack } from "expo-router";
import { PageScroll } from "../../ui";
import { PublishedPagesSection } from "../../published-pages-section";
import { LocalMcpSection } from "../../local-mcp-section";
import { useTheme } from "../../theme";

/** Settings › Milagre: Designs and artifacts, then the Milagre MCP, like desktop's Milagre section. */
export default function MilagreScreen() {
  const { colors } = useTheme();
  const header = (title: string) => (
    <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.ink2, fontSize: 13, paddingHorizontal: 16 }}>
      {title}
    </Text>
  );
  return (
    <>
      <Stack.Screen options={{ title: "Milagre" }} />
      <PageScroll>
        <View style={{ gap: 28 }}>
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
