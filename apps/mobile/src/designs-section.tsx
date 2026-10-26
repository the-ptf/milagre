import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSession } from "./session";
import { ErrorNotice, ListRow, PillButton, Toggle, useStyles } from "./ui";

/** Settings › Milagre › Designs and artifacts: the connected Mac's Designs switch and its published pages, like desktop's. */
export function DesignsSection() {
  const styles = useStyles();
  const session = useSession();
  const [sharingOwner, setSharingOwner] = useState<typeof session.client>(null);
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      setSharingOwner(null);
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
  if (!session.client) return <Text style={styles.caption}>Connect to a Mac to change its Designs setting.</Text>;
  return (
    <View style={[styles.card, { gap: 4 }]}>
      <Toggle
        title="Designs"
        selected={session.designs.enabled === true}
        disabled={session.designs.enabled === null || session.designs.stale || session.designs.saving}
        onPress={() => void session.designs.save(session.designs.enabled !== true)}
      />
      <Text style={styles.caption}>Create editable designs in Chat.</Text>
      {sharingOwner === session.client && (
        <ListRow compact title="Published pages" subtitle="Public links to designs and artifacts." onPress={() => router.push("/published-pages")} />
      )}
      {session.designs.saving ? (
        <Text style={styles.caption}>Saving...</Text>
      ) : session.designs.stale && !session.designs.error ? (
        <Text style={styles.caption}>Checking your Mac...</Text>
      ) : null}
      {session.designs.stale && session.designs.enabled !== null && <Text style={styles.caption}>Showing the last confirmed setting.</Text>}
      {session.designs.error ? (
        <>
          <ErrorNotice message={session.designs.error} />
          <PillButton title="Retry Designs setting" secondary onPress={() => void session.designs.refresh()} />
        </>
      ) : null}
    </View>
  );
}
