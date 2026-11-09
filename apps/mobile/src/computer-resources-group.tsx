import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { ArrowRight01Icon, HardDriveIcon, RamMemoryIcon } from "@hugeicons/core-free-icons";
import { RESOURCES_REFRESH_MS, UNREADABLE, resourceGauges, type ComputerResources, type ResourceGauge } from "@milagre/shared/computer-resources";
import { createClient } from "./client";
import { relayRuntime } from "./relay-native";
import { Group } from "./settings-list";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { radius, type } from "./design-tokens";
import type { SavedHost } from "./hosts-store";

// The last read per computer, so the breakdown page and a reopened computer page show numbers at once.
const last = new Map<string, ComputerResources>();

/** A computer's memory and disk, read from that computer while the page is on screen and every 15 seconds after. */
export function useComputerResources(host: SavedHost | undefined, online: boolean): { resources: ComputerResources | null; error: string } {
  const client = useMemo(() => (host ? createClient(host, fetch, 5000, relayRuntime) : null), [host]);
  const [state, setState] = useState<{ resources: ComputerResources | null; error: string }>(() => ({
    resources: host ? (last.get(host.id) ?? null) : null,
    error: "",
  }));
  useFocusEffect(
    useCallback(() => {
      if (!online || !client || !host) return;
      let live = true;
      const read = async () => {
        try {
          const latest = await client.call<ComputerResources>("computer:resources:read", []);
          last.set(host.id, latest);
          if (live) setState({ resources: latest, error: "" });
        } catch (failure) {
          if (live) setState((current) => ({ ...current, error: (failure as Error).message }));
        }
      };
      void read();
      const timer = setInterval(() => void read(), RESOURCES_REFRESH_MS);
      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [client, host, online]),
  );
  return state;
}

/** Whether an error means the computer runs a Milagre too old to report its memory and disk. */
const olderMilagre = (error: string) => /unknown|not (available|allowed|supported)|no handler/i.test(error);

/** A gauge's bar: Milagre in the accent, everything else in use in the faint ink (orange when the computer is low). */
function GaugeBar({ gauge }: { gauge: ResourceGauge }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={gauge.tooltip}
      style={{ flexDirection: "row", gap: 1, height: 6, borderRadius: radius.full, overflow: "hidden", backgroundColor: colors.inset }}
    >
      <View style={{ width: `${gauge.shares.milagre * 100}%`, borderRadius: radius.full, backgroundColor: colors.accent }} />
      <View style={{ width: `${gauge.shares.other * 100}%`, borderRadius: radius.full, backgroundColor: gauge.low ? colors.orange : colors.ink4 }} />
    </View>
  );
}

function GaugeRow({ gauge, onPress }: { gauge: ResourceGauge; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${gauge.kind === "memory" ? "Memory" : "Disk"}: ${gauge.free} ${gauge.of}. ${gauge.tooltip}`}
      onPress={onPress}
      style={({ pressed }) => ({ gap: 8, paddingVertical: 12, opacity: pressed ? 0.5 : 1 })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon icon={gauge.kind === "memory" ? RamMemoryIcon : HardDriveIcon} tone={gauge.low ? "orangeInk" : "ink2"} size={20} />
        <Text style={{ color: gauge.low ? colors.orangeInk : colors.ink, fontSize: type.body, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {gauge.free}
        </Text>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: type.subheadline, fontVariant: ["tabular-nums"] }}>
          {gauge.of}
        </Text>
        {gauge.measuring ? <ActivityIndicator size="small" color={colors.ink3} /> : null}
        <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
      </View>
      <GaugeBar gauge={gauge} />
    </Pressable>
  );
}

/** What the group says instead of rows: offline, still reading, or why it couldn't read. Null once it has read. */
function resourcesNote({
  online,
  read,
  unreadable,
  error,
  name,
}: {
  online: boolean;
  read: boolean;
  unreadable: boolean;
  error: string;
  name: string;
}): string | null {
  if (!online) return "Offline";
  if (read) return null;
  if (unreadable) return UNREADABLE;
  if (!error) return "Reading…";
  if (olderMilagre(error)) return `Milagre on ${name} can't report memory and disk yet. Update it to see them.`;
  return `Couldn't read: ${error}`;
}

/** Settings › Computers › one computer: its memory and disk; a row opens what Milagre uses there. */
export function ComputerResourcesGroup({ host, online }: { host: SavedHost; online: boolean }) {
  const { colors } = useTheme();
  const { resources, error } = useComputerResources(host, online);
  const gauges = resources && online ? resourceGauges(resources) : null;
  const note = resourcesNote({ online, read: gauges !== null, unreadable: resources !== null && online && gauges === null, error, name: host.name });
  const open = () => router.push({ pathname: "/computer-usage", params: { id: host.id } });
  return (
    <Group>
      {note !== null || !gauges
        ? [
            <Text key="note" style={{ color: colors.ink3, fontSize: type.subheadline, paddingVertical: 16 }}>
              {note}
            </Text>,
          ]
        : [
            <GaugeRow key="memory" gauge={gauges.memory} onPress={open} />,
            ...(gauges.disk ? [<GaugeRow key="disk" gauge={gauges.disk} onPress={open} />] : []),
          ]}
    </Group>
  );
}
