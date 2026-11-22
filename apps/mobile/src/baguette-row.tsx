import { useCallback, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { baguetteStatusLine, type BaguetteStatus } from "@milagre/shared/simulator";
import { useSession } from "./session";
import { Row } from "./settings-list";
import { useStyles } from "./ui";

const BAGUETTE_URL = "https://github.com/tddworks/baguette";

/** Whether this computer found Baguette, which lists and streams the iPhones on its cable. Older hosts show nothing. */
export function BaguetteRow() {
  const styles = useStyles();
  const client = useSession().client;
  const [status, setStatus] = useState<BaguetteStatus | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let live = true;
      client.call<BaguetteStatus>("baguette:status", []).then(
        (value) => live && setStatus(value),
        () => live && setStatus(null),
      );
      return () => {
        live = false;
      };
    }, [client]),
  );
  if (!client || !status) return null;
  return (
    <View style={[styles.card, { gap: 4, paddingVertical: 4 }]}>
      <Row
        title="iPhones on a cable"
        value={status.supported ? `Baguette ${status.version}` : status.found ? "Update" : "Not installed"}
        onPress={() => void Linking.openURL(BAGUETTE_URL).catch(() => {})}
      />
      <Text style={[styles.caption, { paddingBottom: 12 }]}>
        {`Chats list the paired iPhones on this computer's cable next to its simulators. ${baguetteStatusLine(status)}`}
      </Text>
    </View>
  );
}
