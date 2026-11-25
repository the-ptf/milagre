import { Text } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { DesignPageShareSheet } from "../design-page-share";
import type { ShareScope } from "../design-page-sharing";
import { shareAvailabilityChanged } from "../share-availability";
import { useSession } from "../session";
import { SheetBody, useStyles } from "../ui";

function scopeOf(kind: string | undefined, designId: string | undefined, designIds: string | undefined): ShareScope {
  if (kind === "artifacts") return { kind };
  if (kind === "selection" && designIds) return { kind, designIds: designIds.split(",") };
  if (kind === "design" && designId) return { kind, designId };
  return { kind: "workspace" };
}

export default function DesignShareScreen() {
  const { hostId, chatId, kind, designId, designIds } = useLocalSearchParams<{
    hostId?: string;
    chatId?: string;
    kind?: string;
    designId?: string;
    designIds?: string;
  }>();
  const scope = scopeOf(kind, designId, designIds);
  const { client, designs } = useSession();
  const styles = useStyles();
  const source =
    client && chatId && ((scope.kind !== "design" && scope.kind !== "selection") || designs.enabled === true) && (!hostId || hostId === client.url)
      ? client
      : null;
  if (!source || !chatId)
    return (
      <SheetBody>
        <Text style={styles.muted}>Reconnect to your computer to share this page.</Text>
      </SheetBody>
    );
  return (
    <DesignPageShareSheet
      key={`${source.url}:${chatId}:${scope.kind}:${scope.designId ?? designIds ?? ""}`}
      client={source}
      chatId={chatId}
      scope={scope}
      inSheet
      onClose={() => router.back()}
      onAvailabilityChange={(available) => shareAvailabilityChanged(source.url, chatId, available)}
    />
  );
}
