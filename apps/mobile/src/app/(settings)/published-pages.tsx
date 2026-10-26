import { useState } from "react";
import { Stack, router } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text, View } from "react-native";
import { DesignPageShareSheet } from "../../design-page-share";
import { useSession } from "../../session";
import { PillButton, useStyles } from "../../ui";

export default function PublishedPagesScreen() {
  const session = useSession();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  usePreventRemove(busy, () => {});
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !busy }} />
      <View
        style={{
          flex: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        {session.client ? (
          <DesignPageShareSheet key={session.client.url} client={session.client} onClose={() => router.back()} onBusyChange={setBusy} />
        ) : (
          <View style={{ padding: 20, gap: 16 }}>
            <Text style={styles.muted}>Connect to a Mac to manage its published pages.</Text>
            <PillButton title="Back to Milagre" onPress={() => router.back()} />
          </View>
        )}
      </View>
    </>
  );
}
