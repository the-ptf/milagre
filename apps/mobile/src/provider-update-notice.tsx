import { useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProviderUpdates } from "@milagre/shared/use-provider-updates";
import type { ProviderUpdate } from "@milagre/shared/model";
import { providerName } from "@milagre/shared/providers";
import { useSession } from "./session";
import { savedProviderUpdateDismissals } from "./hosts-native";
import { ProviderLogo } from "./icons";
import { IconButton, PillButton } from "./ui";
import { useTheme } from "./theme";

export function ProviderUpdateNotice() {
  const session = useSession();
  const { client, refreshProviders } = session;
  const refreshRef = useRef(refreshProviders);
  useEffect(() => {
    refreshRef.current = refreshProviders;
  }, [refreshProviders]);
  const transport = useMemo(
    () =>
      client
        ? {
            read: () => client.call<ProviderUpdate[]>("agent:provider-updates"),
            install: async (update: ProviderUpdate) => {
              const result = await client.call<{ ok: boolean; error?: string }>("agent:update-cli", [update.provider, update.version]);
              if (result.ok) void refreshRef.current();
              return result;
            },
            // Saved on the phone: a reconnect builds a new client, which would otherwise bring the card back.
            dismissals: {
              load: () => savedProviderUpdateDismissals.load(client.url),
              add: (key: string) => savedProviderUpdateDismissals.add(client.url, key),
            },
          }
        : null,
    [client],
  );
  const updates = useProviderUpdates(transport);
  const { current, working, error } = updates;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!current) return null;
  const name = providerName(current.provider);
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, bottom: Math.max(insets.bottom, 16), zIndex: 50 }}>
      <View
        accessibilityLiveRegion="polite"
        style={{ borderRadius: 20, borderCurve: "continuous", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 16, gap: 12 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ProviderLogo provider={current.provider} size={20} />
          <Text style={{ flex: 1, color: colors.ink, fontSize: 15, fontWeight: "600" }}>
            Update available: {name} v{current.version}
          </Text>
          <IconButton label={`Dismiss ${name} update`} icon={Cancel01Icon} disabled={working} onPress={updates.dismiss} />
        </View>
        <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>
          Install the update on {session.hostName || "your computer"} now or review provider settings.
        </Text>
        {!!error && (
          <Text accessibilityRole="alert" style={{ color: colors.redInk, fontSize: 13 }}>
            {error}
          </Text>
        )}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <PillButton title="Settings" secondary onPress={() => router.push("/accounts")} />
          <PillButton title={working ? "Updating…" : error ? "Retry" : "Update"} loading={working} disabled={working} onPress={() => void updates.install()} />
        </View>
      </View>
    </View>
  );
}
