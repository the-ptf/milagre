import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect, type Href } from "expo-router";
import { useSession } from "./session";
import { Row } from "./settings-list";
import { useStyles } from "./ui";

/**
 * A feature the connected Mac keeps (Babysit PRs, Simlock devices, Computer use): a row with On or Off that opens its page.
 * Read on every focus, since its page or the Mac may have changed it; hidden with no Mac, and on a Mac too old to answer.
 */
export function MacFeatureRow({ read, title, description, href }: { read: string; title: string; description: string; href: Href }) {
  const styles = useStyles();
  const client = useSession().client;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let live = true;
      client.call<{ enabled: boolean } | null>(read, []).then(
        (value) => live && setEnabled(value ? value.enabled === true : null),
        () => live && setEnabled(null),
      );
      return () => {
        live = false;
      };
    }, [client, read]),
  );
  if (!client || enabled === null) return null;
  return (
    <View style={[styles.card, { gap: 4, paddingVertical: 4 }]}>
      <Row title={title} value={enabled ? "On" : "Off"} onPress={() => router.push(href)} />
      <Text style={[styles.caption, { paddingBottom: 12 }]}>{description}</Text>
    </View>
  );
}
