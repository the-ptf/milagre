import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  RESOURCES_HINT,
  RESOURCES_REFRESH_MS,
  RESOURCES_TITLE,
  resourceMeters,
  type ComputerResources,
  type ResourceMeter,
} from "@milagre/shared/computer-resources";
import { createClient } from "./client";
import { relayRuntime } from "./relay-native";
import { Group } from "./settings-list";
import { useTheme } from "./theme";
import { radius, type } from "./design-tokens";
import type { SavedHost } from "./hosts-store";

function Meter({ meter }: { meter: ResourceMeter }) {
  const { colors } = useTheme();
  const { milagre, other, free } = meter.shares;
  return (
    <View
      accessible
      accessibilityLabel={`${meter.label}: ${meter.summary}${meter.milagre ? `, ${meter.milagre}` : ""}`}
      style={{ gap: 6, paddingVertical: 12 }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
        <Text style={{ flex: 1, color: colors.ink, fontSize: type.body }}>{meter.label}</Text>
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.subheadline, fontVariant: ["tabular-nums"] }}>
          {meter.summary}
        </Text>
      </View>
      <View style={{ flexDirection: "row", height: 6, borderRadius: radius.full, overflow: "hidden", backgroundColor: colors.inset }}>
        <View style={{ width: `${milagre * 100}%`, backgroundColor: colors.accent }} />
        <View style={{ width: `${other * 100}%`, backgroundColor: colors.ink4 }} />
        <View style={{ width: `${free * 100}%` }} />
      </View>
      {meter.milagre ? <Text style={{ color: colors.ink2, fontSize: type.footnote }}>{meter.milagre}</Text> : null}
    </View>
  );
}

/** What the group says instead of meters: offline, still reading, or why it couldn't read. Null once it has read. */
function resourcesNote({ online, read, error, name }: { online: boolean; read: boolean; error: string; name: string }): string | null {
  if (!online) return "Offline";
  if (read) return null;
  if (!error) return "Reading…";
  // An older Milagre answers with an unknown command.
  if (/unknown|not (available|allowed|supported)|no handler/i.test(error)) return `Update Milagre on ${name} to see its memory and disk.`;
  return `Couldn't read: ${error}`;
}

/** A computer's memory and disk on its Settings page, read from that computer while the page is on screen. */
export function ComputerResourcesGroup({ host, online }: { host: SavedHost; online: boolean }) {
  const { colors } = useTheme();
  const client = useMemo(() => createClient(host, fetch, 5000, relayRuntime), [host]);
  const [{ resources, error }, setState] = useState<{ resources: ComputerResources | null; error: string }>({ resources: null, error: "" });
  useFocusEffect(
    useCallback(() => {
      if (!online) return;
      let live = true;
      const read = async () => {
        try {
          const latest = await client.call<ComputerResources>("computer:resources:read", []);
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
    }, [client, online]),
  );
  const note = resourcesNote({ online, read: resources !== null, error, name: host.name });
  return (
    <Group title={RESOURCES_TITLE} footer={RESOURCES_HINT}>
      {note !== null || !resources
        ? [
            <Text key="note" style={{ color: colors.ink3, fontSize: type.subheadline, paddingVertical: 16 }}>
              {note}
            </Text>,
          ]
        : resourceMeters(resources).map((meter) => <Meter key={meter.label} meter={meter} />)}
    </Group>
  );
}
