import { Platform } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { EmptyState, PageScroll } from "../../ui";
import { designPlatform, designSection } from "../../design-system-catalogue";
import { DesignSystemPage } from "../../design-system-specimens";

/** One page of Settings › Design system, by its `section`, with the notes for the `platform` the index's switch picked. */
export default function DesignSystemPageScreen() {
  const params = useLocalSearchParams<{ section?: string; platform?: string }>();
  const section = designSection(params.section);
  const platform = designPlatform(params.platform, Platform.OS);
  return (
    <>
      <Stack.Screen options={{ title: section?.title ?? "Design system" }} />
      <PageScroll>{section ? <DesignSystemPage section={section} platform={platform} /> : <EmptyState title="This page is no longer here" />}</PageScroll>
    </>
  );
}
