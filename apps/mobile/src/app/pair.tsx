import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { parsePairing } from "../pairing";
import { useSession } from "../session";
import { ErrorNotice, PillButton, useStyles } from "../ui";
import { SpinnerRing } from "../icons";

/** Opened by the milagre://pair link in the host's QR code when it is scanned with the Camera app. */
export default function PairLink() {
  const styles = useStyles();
  const params = useLocalSearchParams<{
    address?: string;
    token?: string;
    name?: string;
    cfId?: string;
    cfSecret?: string;
    relay?: string;
    host?: string;
    key?: string;
  }>();
  const session = useSession();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The link is rebuilt from the params expo-router parsed; only the ones it carried go back in.
        const query = (["address", "relay", "host", "key", "token", "name", "cfId", "cfSecret"] as const).flatMap((key) =>
          params[key] === undefined ? [] : [`${key}=${encodeURIComponent(params[key] || "")}`],
        );
        const pairing = parsePairing(`milagre://pair?${query.join("&")}`);
        if ((await session.connect(pairing)) && !cancelled) {
          router.dismissAll();
          router.replace("/projects");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.address, params.token, params.name, params.cfId, params.cfSecret, params.relay, params.host, params.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={[styles.screen, { padding: 24, justifyContent: "center", gap: 16 }]}>
      <Stack.Screen options={{ title: "Pairing" }} />
      {error ? (
        <>
          <ErrorNotice message={error} />
          <PillButton title="Back to computers" secondary onPress={() => router.replace("/")} />
        </>
      ) : (
        <View style={{ alignItems: "center", gap: 12 }}>
          <SpinnerRing size={24} />
          <Text style={styles.muted}>Pairing with {params.name || "your computer"}…</Text>
        </View>
      )}
    </View>
  );
}
