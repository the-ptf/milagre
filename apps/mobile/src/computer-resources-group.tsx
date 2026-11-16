import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { ArrowRight01Icon, HardDriveIcon, RamMemoryIcon } from "@hugeicons/core-free-icons";
import {
  RESOURCES_REFRESH_MS,
  UNREADABLE,
  computerPlatformLabel,
  resourceGauges,
  type ComputerResources,
  type ResourceGauge,
} from "@milagre/shared/computer-resources";
import { createClient } from "./client";
import { relayRuntime } from "./relay-native";
import { Group } from "./settings-list";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { radius, space, type } from "./design-tokens";
import { pressStyle } from "./primitives/press-style";
import type { SavedHost } from "./hosts-store";

const last = new Map<string, ComputerResources>();

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

const olderMilagre = (error: string) => /unknown|not (available|allowed|supported)|no handler/i.test(error);

function GaugeBar({ gauge }: { gauge: ResourceGauge }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={gauge.tooltip}
      style={{ flexDirection: "row", gap: space.xxs, height: 6, borderRadius: radius.full, overflow: "hidden", backgroundColor: colors.inset }}
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
      style={({ pressed }) => ({ gap: 8, paddingVertical: 12, ...pressStyle({ pressed, kind: "row" }) })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
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

export function ComputerResourcesGroup({ host, online }: { host: SavedHost; online: boolean }) {
  const { colors } = useTheme();
  const { resources, error } = useComputerResources(host, online);
  const gauges = resources && online ? resourceGauges(resources) : null;
  const note = resourcesNote({ online, read: gauges !== null, unreadable: resources !== null && online && gauges === null, error, name: host.name });
  const open = () => router.push({ pathname: "/computer-usage", params: { id: host.id } });
  return (
    <Group title={resources ? computerPlatformLabel(resources.platform) : undefined}>
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
