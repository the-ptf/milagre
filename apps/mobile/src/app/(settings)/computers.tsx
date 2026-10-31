import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { Add01Icon, ArrowRight01Icon, ComputerIcon, LaptopIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { useSession } from "../../session";
import { savedHosts } from "../../hosts-native";
import { phoneName } from "../../phone-name-native";
import { statusLine, isDesktopComputer } from "../../computer-actions";
import { useComputerStatus, useRouteChanges } from "../../use-computer-status";
import { Icon } from "../../icons";
import { ErrorNotice, HeaderButton, PageScroll, RowCheckbox, useStyles } from "../../ui";
import { useTheme } from "../../theme";

const add = () => router.push("/add-computer");

/** Settings › Computers: every paired computer with whether it answers and whether its Chats show in the list. */
export default function ComputersScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const { hosts, loadHosts } = session;
  const reachability = useComputerStatus(hosts);
  useRouteChanges(hosts);
  const [error, setError] = useState("");
  const dot = (state: string) => (state === "online" ? colors.green : state === "checking" ? colors.orange : colors.lineStrong);
  return (
    <>
      <Stack.Screen options={{ title: "Computers" }} />
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="plus" accessibilityLabel="Add computer" onPress={add} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="Add computer" icon={Add01Icon} onPress={add} />
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
      <PageScroll>
        {hosts.length > 0 ? (
          <View style={[styles.card, { paddingVertical: 0, paddingHorizontal: 0, gap: 0 }]}>
            {hosts.map((host, index) => {
              const state = reachability[host.id] ?? "checking";
              const shown = !host.hidden;
              return (
                <View key={host.id}>
                  {index > 0 && <View style={styles.separator} />}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${host.name}. ${statusLine(host, state)}`}
                    onPress={() => router.push({ pathname: "/computer", params: { id: host.id } })}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, minHeight: 78, opacity: pressed ? 0.5 : 1 })}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot(state) }} />
                        <Icon icon={isDesktopComputer(host.name) ? ComputerIcon : LaptopIcon} tone="ink2" size={15} />
                        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink, fontSize: 16, fontWeight: "600" }}>
                          {host.name}
                        </Text>
                      </View>
                      <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 13 }}>
                        {statusLine(host, state)}
                      </Text>
                    </View>
                    <RowCheckbox
                      label={`Show ${host.name} Chats`}
                      selected={shown}
                      onPress={() =>
                        void savedHosts
                          .setHidden(host.id, shown)
                          .then(() => loadHosts())
                          .then(
                            () => setError(""),
                            (e: Error) => setError(e.message),
                          )
                      }
                    />
                    <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={[styles.card, { gap: 6 }]}>
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>No computers paired</Text>
            <Text style={styles.muted}>Open Settings → Devices in Milagre on your Mac, then scan its pairing code with +.</Text>
          </View>
        )}
        {error ? <ErrorNotice message={error} /> : null}
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.ink2, fontSize: 13, paddingHorizontal: 16 }}>This iPhone</Text>
          <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }]}>
            <Icon icon={SmartPhone01Icon} tone="ink" size={20} />
            <Text style={{ color: colors.ink, fontSize: 16 }}>Name on computers</Text>
            {phoneName ? (
              <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: 15, textAlign: "right" }}>
                {phoneName}
              </Text>
            ) : null}
          </View>
        </View>
      </PageScroll>
    </>
  );
}
