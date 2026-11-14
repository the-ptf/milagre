import { View } from "react-native";
import { router } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { USAGE_BUTTON_LABEL } from "@milagre/shared/usage";
import { CircleButton, PageScroll, SheetHeader, useStyles } from "../ui";
import { UsageSection } from "../usage-section";

/** The Chats list's Plan usage button opens this: every provider's limits at once, as desktop's usage button popover. */
export default function UsageSheet() {
  const styles = useStyles();
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: 40 }}>
      <SheetHeader title={USAGE_BUTTON_LABEL} leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        {/* An empty navigation slot: the sheet's title already names it, so the section's own heading stays out. */}
        <UsageSection navigation={<View />} />
      </View>
    </PageScroll>
  );
}
