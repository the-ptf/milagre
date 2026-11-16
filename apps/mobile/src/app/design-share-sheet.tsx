import { Text } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { DesignPageShareSheet } from "../design-page-share";
import { shareAvailabilityChanged } from "../share-availability";
import { useSession } from "../session";
import { SheetBody, useStyles } from "../ui";

export default function DesignShareScreen() {
  const { hostId, chatId, kind: asked } = useLocalSearchParams<{ hostId?: string; chatId?: string; kind?: string }>();
  const kind = asked === "artifacts" ? "artifacts" : "designs";
  const { client, designs } = useSession();
  const styles = useStyles();
  const source = client && chatId && (kind === "artifacts" || designs.enabled === true) && (!hostId || hostId === client.url) ? client : null;
  if (!source || !chatId)
    return (
      <SheetBody>
        <Text style={styles.muted}>Reconnect to your computer to share this page.</Text>
      </SheetBody>
    );
  return (
    <DesignPageShareSheet
      key={`${source.url}:${chatId}:${kind}`}
      client={source}
      chatId={chatId}
      kind={kind}
      inSheet
      onClose={() => router.back()}
      onAvailabilityChange={(available) => shareAvailabilityChanged(source.url, chatId, available, kind)}
    />
  );
}
