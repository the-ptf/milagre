import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSession } from "./session";
import { ListRow, useStyles } from "./ui";

/** Settings › Milagre › Designs and artifacts: the connected Mac's published pages, like desktop's. */
export function PublishedPagesSection() {
  const styles = useStyles();
  const session = useSession();
  // The client whose owner history answered; undefined while asking, null when it refused.
  const [sharingOwner, setSharingOwner] = useState<typeof session.client | undefined>(undefined);
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      setSharingOwner(undefined);
      if (!client) return;
      let live = true;
      // Owner history remains available without a live Chat or a reachable sharing service.
      // Confined demo phones and older hosts reject this call or return no history.
      client.call<unknown>("artifact:all-page-shares", []).then(
        (history) => live && setSharingOwner(Array.isArray(history) ? client : null),
        () => live && setSharingOwner(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  if (!session.client) return <Text style={styles.caption}>Connect to a Mac to manage its published pages.</Text>;
  if (sharingOwner === undefined) return null;
  if (sharingOwner !== session.client) return <Text style={styles.caption}>{"Only the Mac's owner can manage its published pages."}</Text>;
  return (
    <View style={[styles.card, { gap: 4 }]}>
      <ListRow compact title="Published pages" subtitle="Public links to designs and artifacts." onPress={() => router.push("/published-pages")} />
    </View>
  );
}
