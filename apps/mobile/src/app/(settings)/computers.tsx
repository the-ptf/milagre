import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { Add01Icon, ArrowRight01Icon, ComputerIcon, LaptopIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { presenceTone } from "@milagre/shared/chat-scopes";
import { useSession } from "../../session";
import { savedHosts } from "../../hosts-native";
import { phoneName } from "../../phone-name-native";
import { statusLine, isDesktopComputer } from "../../computer-actions";
import { useComputerStatus, useRouteChanges } from "../../use-computer-status";
import { Icon } from "../../icons";
import { EmptyState, ErrorNotice, Group, HeaderButton, ListRow, PageScroll, RowCheckbox, Segmented, pressStyle, useStyles } from "../../ui";
import { lanRoutes } from "../../routes-native";
import { ComputerMap, hostMachine, useComputersView } from "../../computer-map";
import { lineHeight, radius, type } from "../../design-tokens";
import { useTheme } from "../../theme";

const add = () => router.push("/add-computer");

export default function ComputersScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const { hosts, loadHosts } = session;
  const reachability = useComputerStatus(hosts);
  useRouteChanges(hosts);
  const [error, setError] = useState("");
  const [view, setView] = useComputersView();
  const here = Platform.OS === "ios" ? (Platform.isPad ? "This iPad" : "This iPhone") : "This phone";
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
        {hosts.length > 0 && (
          <Segmented
            label="Show computers as"
            value={view}
            options={[
              { value: "map", title: "Map" },
              { value: "list", title: "List" },
            ]}
            onChange={(next) => setView(next === "list" ? "list" : "map")}
          />
        )}
        {hosts.length > 0 && view === "map" ? (
          <ComputerMap
            hubName={phoneName || here}
            hubLabel={here}
            machines={hosts.map((host) =>
              hostMachine(host, reachability[host.id] ?? "checking", { lan: lanRoutes.kind(host.id) === "lan", address: lanRoutes.address(host.id) }),
            )}
            onOpen={(id) => router.push({ pathname: "/computer", params: { id } })}
          />
        ) : hosts.length > 0 ? (
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
                    style={({ pressed }) => [
                      { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56 },
                      pressStyle({ pressed, kind: "row" }),
                    ]}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors[presenceTone(state)] }} />
                        <Icon icon={isDesktopComputer(host.name) ? ComputerIcon : LaptopIcon} tone="ink2" size={16} />
                        <Text
                          numberOfLines={1}
                          style={{ flexShrink: 1, color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}
                        >
                          {host.name}
                        </Text>
                      </View>
                      <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
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
          <EmptyState icon={ComputerIcon} title="No computers paired">
            Open Settings → Phone & sharing in Milagre on your computer, then scan its pairing code with +.
          </EmptyState>
        )}
        {error ? <ErrorNotice message={error} /> : null}
        <Group title={here}>
          <ListRow title="Name on computers" icon={SmartPhone01Icon} value={phoneName || undefined} chevron={false} />
        </Group>
      </PageScroll>
    </>
  );
}
