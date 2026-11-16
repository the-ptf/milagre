import { View } from "react-native";
import { router } from "expo-router";
import { ArrowUpRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { currentBrief } from "../handoff-brief-store";
import { Markdown } from "../markdown";
import { CircleButton, PageScroll, SheetHeader, useStyles } from "../ui";

export default function HandoffBriefSheet() {
  const styles = useStyles();
  const brief = currentBrief();
  const openChat = brief.openChat;
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: 40 }}>
      <SheetHeader
        title={brief.title}
        subtitle={brief.subtitle}
        leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />}
        trailing={
          openChat ? (
            <CircleButton
              label="Open Chat"
              icon={ArrowUpRight01Icon}
              onPress={() => {
                router.back();
                openChat();
              }}
            />
          ) : undefined
        }
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
        <Markdown text={brief.text} />
      </View>
    </PageScroll>
  );
}
