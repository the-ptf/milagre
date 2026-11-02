import { View } from "react-native";
import { router } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { currentBrief } from "../handoff-brief-store";
import { Markdown } from "../markdown";
import { CircleButton, PageScroll, SheetHeader, useStyles } from "../ui";

/**
 * The brief the new provider was sent when a Chat switched providers, or the linked summary a Link gave it, read-only,
 * as desktop's brief dialog shows it.
 */
export default function HandoffBriefSheet() {
  const styles = useStyles();
  const brief = currentBrief();
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: 40 }}>
      <SheetHeader title={brief.title} leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
        <Markdown text={brief.text} />
      </View>
    </PageScroll>
  );
}
