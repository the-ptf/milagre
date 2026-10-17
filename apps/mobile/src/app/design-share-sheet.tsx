import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { DesignPageShareSheet } from "../design-page-share";
import { shareAvailabilityChanged } from "../designs-sheet";
import { useSession } from "../session";
import { useStyles } from "../ui";

/** Share for a Chat's designs, as a bottom sheet over them. */
export default function DesignShareScreen() {
  const { hostId, chatId } = useLocalSearchParams<{ hostId?: string; chatId?: string }>();
  const { client, designs } = useSession();
  const styles = useStyles();
  const source = client && chatId && designs.enabled === true && (!hostId || hostId === client.url) ? client : null;
  if (!source || !chatId)
    return (
      <View style={{ padding: 24 }}>
        <Text style={styles.muted}>Reconnect to this Mac to share this page.</Text>
      </View>
    );
  return (
    <DesignPageShareSheet
      key={`${source.url}:${chatId}`}
      client={source}
      chatId={chatId}
      kind="designs"
      inSheet
      onClose={() => router.back()}
      onAvailabilityChange={(available) => shareAvailabilityChanged(source.url, chatId, available)}
    />
  );
}
