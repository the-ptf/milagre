import { View } from "react-native";
import { router } from "expo-router";
import { ArrowUpRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { currentBrief } from "../handoff-brief-store";
import { Markdown } from "../markdown";
import { CircleButton, PageScroll, SheetHeader, useStyles } from "../ui";

/**
 * The brief the new provider was sent when a Chat switched providers, the linked summary a Link gave it, or a message
 * another Chat sent, read-only, as desktop's brief dialog shows it. A Chat's message also offers to open that Chat.
 */
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
