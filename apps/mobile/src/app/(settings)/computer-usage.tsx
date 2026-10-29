import { useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { HardDriveIcon, RamMemoryIcon } from "@hugeicons/core-free-icons";
import { BREAKDOWN_TITLE, MEASURING_TOOLTIP, UNREADABLE, partOpacity, resourceGauges, type ResourceGauge } from "@milagre/shared/computer-resources";
import { useSession } from "../../session";
import { useComputerStatus } from "../../use-computer-status";
import { useComputerResources } from "../../computer-resources-group";
import { Icon } from "../../icons";
import { ErrorNotice, PageScroll, useStyles } from "../../ui";
import { useTheme } from "../../theme";
import { radius, type } from "../../design-tokens";

function PartsCard({ gauge }: { gauge: ResourceGauge }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { gap: 12, paddingVertical: 16 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon icon={gauge.kind === "memory" ? RamMemoryIcon : HardDriveIcon} tone="ink2" size={20} />
        <Text style={{ color: colors.accent, fontSize: type.title3, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{gauge.milagre ?? "—"}</Text>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: type.subheadline }}>
          {gauge.context}
        </Text>
      </View>
      {gauge.measuring ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
          <ActivityIndicator size="small" color={colors.ink3} />
          <Text style={{ color: colors.ink3, fontSize: type.subheadline }}>{MEASURING_TOOLTIP}…</Text>
        </View>
      ) : (
        <>
          <View style={{ flexDirection: "row", gap: 2, height: 8, borderRadius: radius.full, overflow: "hidden" }}>
            {gauge.parts.map((part, index) => (
              <View key={part.kind} style={{ flex: part.portion, backgroundColor: colors.accent, opacity: partOpacity(index) }} />
            ))}
          </View>
          {gauge.parts.map((part, index) => (
            <View
              key={part.kind}
              accessible
              accessibilityLabel={`${part.label}, ${part.value}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 28 }}
            >
              <View style={{ width: 10, height: 10, borderRadius: radius.chip, backgroundColor: colors.accent, opacity: partOpacity(index) }} />
              <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: type.body }}>
                {part.label}
              </Text>
              <Text style={{ color: colors.ink3, fontSize: type.body, fontVariant: ["tabular-nums"] }}>{part.value}</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

/** Settings › Computers › a computer › What Milagre uses: its memory and disk split by agent, terminal, app and folder. */
export default function ComputerUsageScreen() {
  const { colors } = useTheme();
  const session = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const host = session.hosts.find((saved) => saved.id === id);
  // One list per host: a fresh array each render would restart the status check after every answer, in a loop.
  const hosts = useMemo(() => (host ? [host] : []), [host]);
  const status = useComputerStatus(hosts);
  const online = host ? status[host.id] !== "offline" : false;
  const { resources, error } = useComputerResources(host, online);
  const gauges = resources && online ? resourceGauges(resources) : null;
  return (
    <>
      <Stack.Screen options={{ title: BREAKDOWN_TITLE }} />
      <PageScroll>
        {!online ? (
          <Text style={{ color: colors.ink3, fontSize: type.subheadline, paddingVertical: 16 }}>Offline</Text>
        ) : gauges ? (
          <View style={{ gap: 22 }}>
            <PartsCard gauge={gauges.memory} />
            {gauges.disk ? <PartsCard gauge={gauges.disk} /> : null}
          </View>
        ) : error || resources ? (
          <ErrorNotice message={error || UNREADABLE} />
        ) : (
          <ActivityIndicator color={colors.ink3} style={{ marginTop: 24 }} />
        )}
      </PageScroll>
    </>
  );
}
