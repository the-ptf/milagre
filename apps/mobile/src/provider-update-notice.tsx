import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, useWindowDimensions, type GestureResponderEvent } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Cancel01Icon, CheckmarkCircle02Icon, Download04Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProviderUpdates, type ProviderUpdateTransport } from "@milagre/shared/use-provider-updates";
import { downloadPercent, installedLine, progressLine, updatePill, type ProviderUpdateItem } from "@milagre/shared/provider-update-view";
import type { ProviderUpdate } from "@milagre/shared/model";
import { providerName } from "@milagre/shared/providers";
import { useSession } from "./session";
import { savedProviderUpdateDismissals } from "./hosts-native";
import { Icon, ProviderLogo, SpinnerRing } from "./icons";
import { ProgressSweep } from "./progress-sweep";
import { StatusPill } from "./status-pill";
import { IconButton, InlineError, PillButton, ProgressBar, announce, useAnnounce } from "./ui";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";

const DONE_LINGER_MS = 4000;
const DONE_CLOSE_MS = 1600;

type Updates = ReturnType<typeof useProviderUpdates>;
type Context = { updates: Updates; open: boolean; setOpen: (open: boolean) => void; host: string; anchor: number | null; setAnchor: (top: number) => void };
const ProviderUpdates = createContext<Context | null>(null);

/** Keeps the connected computer's CLI updates for the composer's update chip and the card it opens. */
export function ProviderUpdatesProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const { client, refreshProviders } = session;
  const refreshRef = useRef(refreshProviders);
  useEffect(() => {
    refreshRef.current = refreshProviders;
  }, [refreshProviders]);
  const transport = useMemo<ProviderUpdateTransport | null>(
    () =>
      client
        ? {
            read: () => client.call<ProviderUpdate[]>("agent:provider-updates"),
            install: async (update) => {
              const result = await client.call<{ ok: boolean; error?: string; log?: string }>("agent:update-cli", [update.provider, update.version]);
              if (result.ok) void refreshRef.current();
              return result;
            },
            dismissals: {
              load: () => savedProviderUpdateDismissals.load(client.url),
              add: (key: string) => savedProviderUpdateDismissals.add(client.url, key),
            },
            watch: (listener) => {
              const live = client.live("", {
                onSignal: (signal) => {
                  if (signal === "provider-updates") listener();
                },
                onStatus: () => {},
              });
              return () => live.close();
            },
          }
        : null,
    [client],
  );
  const updates = useProviderUpdates(transport);
  const [wantOpen, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<number | null>(null);
  const { items, clearDone } = updates;
  const open = wantOpen && items.length > 0;
  const allDone = items.length > 0 && items.every((item) => item.status === "done");
  const single = items.length === 1;
  useEffect(() => {
    if (!allDone || (open && !single)) return;
    const timer = open ? setTimeout(() => setOpen(false), DONE_CLOSE_MS) : setTimeout(clearDone, DONE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [allDone, open, single, clearDone]);
  useEffect(() => {
    if (!open && items.some((item) => item.status === "done") && !allDone) clearDone();
  }, [open, items, allDone, clearDone]);
  const value = useMemo(
    () => ({ updates, open, setOpen, host: session.hostName || "your computer", anchor, setAnchor }),
    [updates, open, session.hostName, anchor],
  );
  return (
    <ProviderUpdates.Provider value={value}>
      {children}
      <ProviderUpdateCard />
    </ProviderUpdates.Provider>
  );
}

/** The update chip on the composer's chip row; tapping it opens the card. */
export function ProviderUpdatePill() {
  const context = useContext(ProviderUpdates);
  const { colors } = useTheme();
  const pill = context ? updatePill(context.updates.items) : null;
  useAnnounce(pill?.kind === "available" ? `Update available: ${pill.label}` : null);
  if (!context || !pill) return null;
  const toggle = ({ nativeEvent }: GestureResponderEvent) => {
    if (!context.open) context.setAnchor(nativeEvent.pageY - nativeEvent.locationY);
    context.setOpen(!context.open);
  };
  if (pill.kind === "updating")
    return (
      <StatusPill
        label={pill.label}
        count={pill.percent ?? undefined}
        suffix={pill.percent === null ? undefined : "%"}
        leading={<SpinnerRing size={12} />}
        expanded={context.open}
        onPress={toggle}
      />
    );
  if (pill.kind === "failed")
    return (
      <StatusPill
        label={pill.label}
        tone="red"
        leading={<View style={{ width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.red }} />}
        expanded={context.open}
        onPress={toggle}
      />
    );
  if (pill.kind === "done") return <StatusPill label={pill.label} icon={Tick02Icon} tone="green" expanded={context.open} onPress={toggle} />;
  return (
    <StatusPill
      label={pill.label}
      tone="ink"
      leading={
        <View style={{ flexDirection: "row" }}>
          {pill.providers.map((provider, index) => (
            <View key={provider} style={{ marginLeft: index ? -4 : 0, borderRadius: radius.full, backgroundColor: colors.surface }}>
              <ProviderLogo provider={provider} size={12} />
            </View>
          ))}
        </View>
      }
      accessibilityHint="Shows the update"
      expanded={context.open}
      onPress={toggle}
    />
  );
}

function Progress({ item }: { item: ProviderUpdateItem }) {
  const { colors } = useTheme();
  const percent = downloadPercent(item.progress);
  const line = progressLine(item.progress);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          {percent === null ? (
            <ProgressSweep accessibilityLabel={`${providerName(item.provider)} update`} valueText={line} />
          ) : (
            <ProgressBar value={percent / 100} accessibilityLabel={`${providerName(item.provider)} update`} valueText={line} />
          )}
        </View>
        {percent !== null && <Text style={{ color: colors.ink2, fontSize: type.footnote, fontVariant: ["tabular-nums"] }}>{percent}%</Text>}
      </View>
      <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontVariant: ["tabular-nums"] }}>{line}</Text>
      {item.command && (
        <Text style={{ color: colors.ink3, fontFamily: "Menlo", fontSize: type.caption2, lineHeight: lineHeight.caption2 }}>$ {item.command}</Text>
      )}
    </View>
  );
}

function SingleBody({ item, host, onInstall }: { item: ProviderUpdateItem; host: string; onInstall: () => void }) {
  const { colors } = useTheme();
  const body = { color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline };
  return (
    <>
      {item.status === "available" && <Text style={body}>{installedLine(item, host)}</Text>}
      {item.status === "updating" && <Progress item={item} />}
      {item.status === "done" && <Text style={body}>New Chats start on {item.version}.</Text>}
      {item.status === "failed" && (
        <View style={{ gap: 8 }}>
          <InlineError message={item.error} />
          {item.log && (
            <Text
              selectable
              numberOfLines={6}
              style={{
                fontFamily: "Menlo",
                fontSize: type.caption2,
                lineHeight: lineHeight.caption2,
                color: colors.ink2,
                backgroundColor: colors.inset,
                borderRadius: radius.control,
                padding: space.lg,
              }}
            >
              {item.log}
            </Text>
          )}
        </View>
      )}
      {(item.status === "available" || item.status === "failed") && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {item.status === "failed" && item.command && (
            <View style={{ flex: 1 }}>
              <PillButton
                title="Copy command"
                secondary
                onPress={() => void Clipboard.setStringAsync(item.command ?? "").then(() => announce("Command copied."))}
              />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <PillButton title={item.status === "failed" ? "Try again" : "Update"} onPress={onInstall} />
          </View>
        </View>
      )}
    </>
  );
}

function Row({ item, locked, onInstall }: { item: ProviderUpdateItem; locked: boolean; onInstall: () => void }) {
  const { colors } = useTheme();
  const percent = downloadPercent(item.progress);
  const small = { fontSize: type.footnote, lineHeight: lineHeight.footnote };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 44 }}>
      <ProviderLogo provider={item.provider} size={20} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>
          {providerName(item.provider)} {item.version}
        </Text>
        <Text numberOfLines={1} style={{ ...small, color: item.status === "failed" ? colors.redInk : colors.ink3 }}>
          {item.status === "failed" ? item.error : `${item.installedVersion} → ${item.version}`}
        </Text>
      </View>
      {(item.status === "available" || item.status === "failed") && (
        <PillButton title={item.status === "failed" ? "Retry" : "Update"} size="small" secondary disabled={locked} onPress={onInstall} />
      )}
      {item.status === "updating" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <SpinnerRing size={12} />
          <Text style={{ ...small, color: colors.ink3, fontVariant: ["tabular-nums"] }}>{percent === null ? "Installing" : `${percent}%`}</Text>
        </View>
      )}
      {item.status === "done" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon icon={Tick02Icon} tone="green" size={12} />
          <Text style={{ ...small, color: colors.greenInk }}>Updated</Text>
        </View>
      )}
    </View>
  );
}

function cardTitle(items: ProviderUpdateItem[]) {
  const [only] = items;
  if (only && items.length === 1) {
    const name = providerName(only.provider);
    if (only.status === "updating") return `Updating ${name}`;
    if (only.status === "done") return `${name} ${only.version} installed`;
    if (only.status === "failed") return `${name} update failed`;
    return `${name} ${only.version}`;
  }
  const pending = items.filter((item) => item.status !== "done").length;
  return pending ? `${pending} updates` : "Everything is up to date";
}

function ProviderUpdateCard() {
  const context = useContext(ProviderUpdates);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  if (!context?.open || !context.updates.items.length) return null;
  const { updates, host, setOpen } = context;
  const { items } = updates;
  const [only] = items;
  const single = items.length === 1 ? only : undefined;
  const updating = items.some((item) => item.status === "updating");
  const left = items.filter((item) => item.status === "available" || item.status === "failed");
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", inset: 0, zIndex: 50 }}>
      <Pressable accessibilityLabel="Close update" style={{ position: "absolute", inset: 0 }} onPress={() => setOpen(false)} />
      <View
        accessibilityViewIsModal
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: context.anchor === null ? Math.max(insets.bottom, 16) + 160 : height - context.anchor + space.md,
          borderRadius: radius.sheet,
          borderCurve: "continuous",
          boxShadow: colors.shadowRaised,
          backgroundColor: colors.surface,
          padding: 16,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          {single?.status === "done" ? (
            <Icon icon={CheckmarkCircle02Icon} tone="green" size={20} />
          ) : single ? (
            <ProviderLogo provider={single.provider} size={20} />
          ) : (
            <Icon icon={Download04Icon} tone="ink2" size={20} />
          )}
          <Text accessibilityRole="header" style={{ flex: 1, color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600" }}>
            {cardTitle(items)}
          </Text>
          {!updating && (
            <IconButton
              label="Dismiss update"
              icon={Cancel01Icon}
              onPress={() => {
                updates.dismiss();
                setOpen(false);
              }}
            />
          )}
        </View>
        {single ? (
          <SingleBody item={single} host={host} onInstall={() => void updates.install(single.provider)} />
        ) : (
          <>
            <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, marginTop: -6 }}>On {host}</Text>
            <View>
              {items.map((item) => (
                <Row key={item.provider} item={item} locked={updating} onInstall={() => void updates.install(item.provider)} />
              ))}
            </View>
            {left.length > 0 && (
              <PillButton
                title={left.length === items.length ? "Update all" : `Update ${left.length} more`}
                disabled={updating}
                onPress={() => void updates.installAll()}
              />
            )}
          </>
        )}
      </View>
    </View>
  );
}
