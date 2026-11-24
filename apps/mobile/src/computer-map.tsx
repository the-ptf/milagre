import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import * as SecureStore from "expo-secure-store";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { ComputerIcon, LaptopIcon, Search01Icon, SmartPhone01Icon, Tablet01Icon } from "@hugeicons/core-free-icons";
import {
  ROW_SIZES,
  layoutMachineRows,
  machineKindOf,
  matchesMachine,
  routeCount,
  routeName,
  type MapLineState,
  type MapMachine,
  type MapMachineKind,
} from "@milagre/shared/computer-map";
import type { Reachability } from "./computer-actions";
import type { SavedHost } from "./hosts-store";
import { seenAgo } from "./seen-ago";
import { Icon } from "./icons";
import { DISABLED_OPACITY, Field, pressStyle } from "./ui";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme, type Palette } from "./theme";

const KIND_ICON = { laptop: LaptopIcon, desktop: ComputerIcon, phone: SmartPhone01Icon, tablet: Tablet01Icon } as const;
const STATE_LABEL: Record<MapLineState, string> = { active: "in use", standby: "checking", offline: "offline", degraded: "refused" };
const LEGEND: { label: string; state: MapLineState }[] = [
  { label: "In use", state: "active" },
  { label: "Checking", state: "standby" },
  { label: "Offline", state: "offline" },
];
const DASH: Partial<Record<MapLineState, string>> = { offline: "4 4" };

const stroke = (colors: Palette, state: MapLineState) => (state === "active" ? colors.green : state === "degraded" ? colors.red : colors.ink4);

function pill(colors: Palette, state: MapLineState) {
  if (state === "active") return { backgroundColor: colors.greenTint, color: colors.greenInk };
  if (state === "degraded") return { backgroundColor: colors.redTint, color: colors.redInk };
  return { backgroundColor: colors.field, color: state === "offline" ? colors.ink3 : colors.ink2 };
}

/** A computer this phone has paired: in use while it answers, over LAN or Tailscale when that route is current. */
export function hostMachine(host: SavedHost, reachability: Reachability, route: { lan: boolean; address: string | null }, now = Date.now()): MapMachine {
  const routes = 1 + (host.routes?.lan ? 1 : 0);
  const relayHost = host.relay ? host.relay.url : host.address;
  const seen = seenAgo(host.lastUsed, now);
  return {
    id: host.id,
    name: host.name,
    kind: machineKindOf(host.name),
    state: reachability === "online" ? "active" : reachability === "checking" ? "standby" : "offline",
    route: routeName(reachability === "online" && route.lan ? "lan" : "relay", { address: route.address, relayHost }),
    detail:
      reachability === "online"
        ? `Online · ${routeCount(routes)}`
        : reachability === "checking"
          ? "Checking…"
          : seen
            ? seen.charAt(0).toUpperCase() + seen.slice(1)
            : "Offline",
    direction: "out",
  };
}

function Tile({ kind, state, hub = false }: { kind: MapMachineKind; state?: MapLineState; hub?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 32,
        height: 32,
        borderRadius: radius.control,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hub ? colors.ink : colors.field,
      }}
    >
      <Icon icon={KIND_ICON[kind]} size={16} color={hub ? colors.onInk : colors.ink2} />
      {state && (
        <View
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: 10,
            height: 10,
            borderRadius: radius.full,
            borderWidth: 2,
            borderColor: colors.surface,
            backgroundColor: state === "active" ? colors.green : state === "degraded" ? colors.red : colors.ink4,
          }}
        />
      )}
    </View>
  );
}

function Card({
  title,
  detail,
  state,
  children,
  left,
  top,
  width,
  height,
  dimmed,
  onPress,
}: {
  title: string;
  detail: string;
  state?: MapLineState;
  children: ReactNode;
  left: number;
  top: number;
  width: number;
  height: number;
  dimmed?: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={state ? `${title}, ${STATE_LABEL[state]}. ${detail}` : `${title}. ${detail}`}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        {
          position: "absolute",
          left,
          top,
          width,
          height,
          flexDirection: "row",
          alignItems: "center",
          gap: space.lg,
          paddingHorizontal: space.lg,
          borderRadius: radius.card,
          borderCurve: "continuous",
          backgroundColor: colors.surface,
          boxShadow: colors.shadowCard,
          opacity: dimmed ? DISABLED_OPACITY.control : 1,
        },
        pressStyle({ pressed }),
      ]}
    >
      {children}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>
          {title}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The Computers screen's map: this phone across the top and every paired computer in a row below it, each line named
 * by the route it takes (LAN, Tailscale or the relay). Fits the screen's width, so it scrolls with the page.
 */
export function ComputerMap({
  hubName,
  hubLabel,
  machines,
  onOpen,
}: {
  hubName: string;
  hubLabel: string;
  machines: MapMachine[];
  onOpen: (id: string) => void;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [query, setQuery] = useState("");
  const layout = useMemo(() => (width ? layoutMachineRows(machines, width) : null), [machines, width]);
  const searching = query.trim().length > 0;
  const matching = useMemo(() => new Set(machines.filter((machine) => matchesMachine(machine, query)).map((machine) => machine.id)), [machines, query]);
  return (
    <View style={{ gap: space.md }}>
      {machines.length > 1 && (
        <Field
          label="Find a computer"
          hideLabel
          placeholder="Find a computer"
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
          leading={<Icon icon={Search01Icon} tone="ink3" size={18} />}
        />
      )}
      <View
        testID="computer-map"
        onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
        style={{
          height: layout?.height ?? 0,
          borderRadius: radius.card,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: colors.canvas,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
        }}
      >
        {layout && (
          <>
            <Svg
              width={layout.width}
              height={layout.height}
              style={{ position: "absolute" }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {layout.edges.map((edge) => {
                const color = stroke(colors, edge.state);
                const end = layout.machines.find((machine) => machine.id === edge.id)!.rect.x;
                return (
                  <G
                    key={edge.id}
                    opacity={searching && !matching.has(edge.id) ? DISABLED_OPACITY.control : 1}
                    fill="none"
                    stroke={color}
                    strokeWidth={edge.state === "active" ? 2 : 1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <Path d={edge.path} strokeDasharray={DASH[edge.state]} />
                    <Path d={`M ${end - 6} ${edge.mid.y - 4} L ${end - 1} ${edge.mid.y} L ${end - 6} ${edge.mid.y + 4}`} />
                  </G>
                );
              })}
            </Svg>
            {layout.edges.map((edge) => {
              const look = pill(colors, edge.state);
              const room = (edge.mid.x - layout.hub.x - ROW_SIZES.trunkInset - ROW_SIZES.corner) * 2 - space.xs;
              return (
                <View
                  key={edge.id}
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: edge.mid.x - room / 2,
                    top: edge.mid.y - 10,
                    width: room,
                    height: 20,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: searching && !matching.has(edge.id) ? DISABLED_OPACITY.control : 1,
                  }}
                >
                  <View style={{ borderRadius: radius.full, backgroundColor: colors.surface }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        paddingHorizontal: space.sm,
                        borderRadius: radius.full,
                        overflow: "hidden",
                        backgroundColor: look.backgroundColor,
                        color: look.color,
                        fontSize: type.caption2,
                        lineHeight: lineHeight.subheadline,
                        fontWeight: "500",
                      }}
                    >
                      {edge.label}
                    </Text>
                  </View>
                </View>
              );
            })}
            <Card title={hubName} detail={hubLabel} left={layout.hub.x} top={layout.hub.y} width={layout.hub.width} height={layout.hub.height}>
              <Tile kind={machineKindOf(hubName, { phone: true })} hub />
            </Card>
            {layout.machines.map((machine) => (
              <Card
                key={machine.id}
                title={machine.name}
                detail={machine.detail}
                state={machine.state}
                left={machine.rect.x}
                top={machine.rect.y}
                width={machine.rect.width}
                height={machine.rect.height}
                dimmed={searching && !matching.has(machine.id)}
                onPress={() => onOpen(machine.id)}
              >
                <Tile kind={machine.kind} state={machine.state} />
              </Card>
            ))}
          </>
        )}
      </View>
      <View
        accessibilityLabel={`Lines: ${LEGEND.map((item) => `${item.label} ${STATE_LABEL[item.state]}`).join(", ")}`}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, paddingHorizontal: space.lg }}
      >
        {LEGEND.map((item) => (
          <View key={item.state} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Svg width={20} height={10}>
              <Path d="M 2 5 L 18 5" stroke={stroke(colors, item.state)} strokeWidth={1.6} strokeDasharray={DASH[item.state]} />
            </Svg>
            <Text style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>{item.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const VIEW_KEY = "milagre.computers-view.v1";
let savedView: "map" | "list" = "map";
let viewLoaded = false;
const viewListeners = new Set<() => void>();

/** Map or List on the Computers screen, kept on this phone. */
export function useComputersView(): ["map" | "list", (view: "map" | "list") => void] {
  useEffect(() => {
    if (viewLoaded) return;
    viewLoaded = true;
    void SecureStore.getItemAsync(VIEW_KEY)
      .then((saved) => {
        if (saved !== "list") return undefined;
        savedView = "list";
        viewListeners.forEach((listener) => listener());
        return undefined;
      })
      .catch(() => {});
  }, []);
  const view = useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    () => savedView,
  );
  return [
    view,
    (next) => {
      savedView = next;
      viewListeners.forEach((listener) => listener());
      void SecureStore.setItemAsync(VIEW_KEY, next, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => {});
    },
  ];
}
