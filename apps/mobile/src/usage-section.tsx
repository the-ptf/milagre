import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Text, View } from "react-native";
import { Stack } from "expo-router";
import { AlertCircleIcon, ComputerIcon, MoreHorizontalIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { ModelProvider, ProviderUsage, UsageSnapshot, UsageWindow } from "@milagre/shared/model";
import { providerName } from "@milagre/shared/providers";
import {
  accountUsageGroups,
  formatPercent,
  formatResetsAt,
  formatUpdatedAgo,
  overviewUpdatedAt,
  shownPercent,
  shownSuffix,
  usageTone,
  type UsageDisplay,
} from "@milagre/shared/usage";
import { useAccountUsage } from "@milagre/shared/use-account-usage";
import { Icon, ProviderLogo, SpinnerRing } from "./icons";
import { IconButton, PullDown, useStyles } from "./ui";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { useUsageDisplay } from "./usage-display-setting";
import { radius, type } from "./design-tokens";

function WindowRow({ window, now, display, stale }: { window: UsageWindow; now: number; display: UsageDisplay; stale?: boolean }) {
  const { colors } = useTheme();
  const percent = Math.max(0, Math.min(100, shownPercent(window.usedPercent, display)));
  const reset = formatResetsAt(window.resetsAt, now);
  const tone = usageTone(window.usedPercent);
  const ink = tone === "critical" ? colors.redInk : tone === "warning" ? colors.orangeInk : colors.ink;
  const fill = stale ? colors.ink3 : tone === "critical" ? colors.red : tone === "warning" ? colors.orange : colors.ink3;
  return (
    <View style={{ gap: 8, flexBasis: "45%", flexGrow: 1, minWidth: 132 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 4 }}>
        <Text style={{ color: colors.ink2, fontSize: type.footnote, flexShrink: 1 }}>{window.label}</Text>
        <Text selectable style={{ color: ink, fontSize: type.footnote, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {formatPercent(percent)} {shownSuffix(display)}
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`${window.label} usage`}
        accessibilityValue={{ min: 0, max: 100, now: percent, text: `${formatPercent(percent)} ${shownSuffix(display)}${reset ? `, ${reset}` : ""}` }}
        style={{ height: 4, borderRadius: radius.full, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.lineStrong }}
      >
        <View style={{ width: `${percent}%`, height: "100%", borderRadius: radius.full, borderCurve: "continuous", backgroundColor: fill }} />
      </View>
      {reset || window.detail ? (
        <Text selectable style={{ color: colors.ink3, fontSize: type.caption1 }}>
          {[window.detail, reset].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

function ProviderRows({
  provider,
  now,
  display = "used",
  onSetDefault,
  pending = false,
}: {
  provider: ProviderUsage;
  now: number;
  display?: UsageDisplay;
  onSetDefault?: () => void;
  pending?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const failed = provider.status === "error";
  const identity = provider.account;
  const stale = failed && provider.windows.length > 0;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text selectable style={{ color: colors.ink, fontSize: type.callout, fontWeight: "600", flexShrink: 1 }}>
              {identity?.label || "Account unavailable"}
            </Text>
            {identity?.default ? (
              <Text accessibilityLabel={`Computer default for ${providerName(provider.provider)}`} style={{ color: colors.ink2, fontSize: type.caption1 }}>
                Default
              </Text>
            ) : null}
          </View>
          {identity?.email ? (
            <Text selectable style={{ color: colors.ink3, fontSize: type.caption1 }}>
              {identity.email}
            </Text>
          ) : null}
          {stale ? (
            <Text selectable style={styles.caption}>
              Last known · {formatUpdatedAgo(provider.updatedAt, now)}
            </Text>
          ) : null}
        </View>
        {identity?.state === "ready" && !identity.default && onSetDefault ? (
          <PullDown
            label={`Actions for ${identity.label}`}
            style={{ width: 44, height: 44 }}
            nativeTrigger={{ systemImage: "ellipsis", disabled: pending, iconSize: 20 }}
            sections={[
              {
                items: [
                  {
                    id: "default",
                    title: "Set as default",
                    subtitle: "Computer default; Project and Link choices stay.",
                    systemImage: "star",
                    disabled: pending,
                  },
                ],
              },
            ]}
            onSelect={(id) => {
              if (id === "default" && !pending) onSetDefault();
            }}
          >
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={`Actions for ${identity.label}`}
              accessibilityState={{ disabled: pending, busy: pending }}
              style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
            >
              <Icon icon={MoreHorizontalIcon} size={20} tone="ink2" />
            </View>
          </PullDown>
        ) : null}
      </View>
      {provider.windows.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {provider.windows.map((window) => (
            <WindowRow key={window.id} window={window} now={now} display={display} stale={stale} />
          ))}
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon icon={AlertCircleIcon} size={16} tone="orange" />
          <Text style={{ color: colors.ink2, fontSize: type.footnote }}>Usage unavailable</Text>
        </View>
      )}
      {provider.bankedResets ? (
        <Text selectable style={styles.label}>
          Banked resets: {provider.bankedResets} left
        </Text>
      ) : null}
      {provider.message ? (
        <Text selectable accessibilityRole={failed ? "alert" : undefined} style={[styles.caption, { color: failed ? colors.orangeInk : colors.ink3 }]}>
          {provider.message}
        </Text>
      ) : null}
    </View>
  );
}

/** Plan usage, sourced only from the currently connected computer. Also used outside the router in the navigation panel. */
export function UsageSection({ header = false }: { header?: boolean }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const clientRef = useRef(session.client);
  useEffect(() => {
    clientRef.current = session.client;
  }, [session.client]);
  const source = useMemo(() => {
    const client = session.client;
    if (!client) return null;
    return {
      read: () => client.call<UsageSnapshot>("usage:accounts:read"),
      cached: () => client.call<UsageSnapshot>("usage:accounts:cached"),
      isActive: () => AppState.currentState === "active",
      subscribe: (usageChanged: () => void, accountsChanged: () => void) => {
        const live = client.live("", {
          onSignal: (signal) => {
            if (signal === "usage") usageChanged();
            if (signal === "accounts") accountsChanged();
          },
          onStatus: (open) => {
            if (open) accountsChanged();
          },
        });
        return () => live.close();
      },
    };
  }, [session.client]);
  const usage = useAccountUsage(source);
  const [display, setDisplay] = useUsageDisplay();
  const [now, setNow] = useState(Date.now);
  const [action, setAction] = useState<{ client: typeof session.client; pending: string | null; error: string }>({ client: null, pending: null, error: "" });
  const pending = action.client === session.client ? action.pending : null;
  const actionError = action.client === session.client ? action.error : "";
  useEffect(() => {
    const tick = () => {
      if (AppState.currentState === "active") setNow(Date.now());
    };
    const timer = setInterval(tick, 30_000);
    const subscription = AppState.addEventListener("change", tick);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  async function setDefault(provider: ModelProvider, id: string) {
    if (!session.client || pending) return;
    const client = session.client;
    setAction({ client, pending: `${provider}:${id}`, error: "" });
    try {
      await client.call("accounts:select", [provider, id]);
      if (clientRef.current !== client) return;
      await session.refreshProviders();
      if (clientRef.current === client) await usage.refreshAccounts();
    } catch (error) {
      if (clientRef.current === client)
        setAction({ client, pending: null, error: error instanceof Error ? error.message : "Couldn't change the computer default." });
    } finally {
      if (clientRef.current === client) setAction((before) => ({ ...before, pending: null }));
    }
  }
  const groups = accountUsageGroups(usage.snapshot);
  const updatedAt = overviewUpdatedAt(usage.snapshot);
  const refresh = (
    <IconButton
      label="Refresh plan usage"
      icon={RefreshIcon}
      size={44}
      loading={usage.loading}
      disabled={!session.client}
      onPress={() => void usage.refresh()}
    />
  );
  return (
    <View style={{ gap: 24 }}>
      {header ? (
        <Stack.Screen options={{ title: "Plan usage", headerRight: () => refresh }} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text accessibilityRole="header" style={styles.section}>
            Plan usage
          </Text>
          {refresh}
        </View>
      )}
      {session.hostName ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
          <Icon icon={ComputerIcon} size={16} tone="ink2" />
          <Text style={{ color: colors.ink2, fontSize: type.subheadline }}>{session.hostName}</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: colors.ink2, fontSize: type.footnote }}>{updatedAt ? formatUpdatedAgo(updatedAt, now) : ""}</Text>
        <PullDown
          label="Plan usage display"
          nativeTrigger={{ title: display === "remaining" ? "Remaining" : "Used", systemImage: "chevron.up.chevron.down", iconSize: 12 }}
          sections={[
            {
              items: [
                { id: "used", title: "Used", checked: display === "used" },
                { id: "remaining", title: "Remaining", checked: display === "remaining" },
              ],
            },
          ]}
          onSelect={(id) => {
            if (id === "used" || id === "remaining") setDisplay(id);
          }}
        >
          <View style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: colors.ink2, fontSize: type.footnote }}>{display === "remaining" ? "Remaining" : "Used"}</Text>
          </View>
        </PullDown>
      </View>
      {!session.client ? (
        <Text style={styles.muted}>Connect to a computer to see its plan usage.</Text>
      ) : !usage.snapshot && usage.loading ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <SpinnerRing size={18} />
          <Text style={styles.muted}>Checking account usage…</Text>
        </View>
      ) : groups.length ? (
        groups.map((group) => (
          <View key={group.provider} style={{ gap: 16 }}>
            <View
              accessibilityLabel={`${providerName(group.provider)}, ${group.accounts.length} accounts`}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <ProviderLogo provider={group.provider} size={16} />
              <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.body, fontWeight: "600" }}>
                {providerName(group.provider)}
              </Text>
              <Text style={{ color: colors.ink3, fontSize: type.footnote }}>{group.accounts.length}</Text>
            </View>
            {group.accounts.map((provider, index) => (
              <View key={provider.account!.id} style={{ gap: 16 }}>
                {index > 0 ? <View style={styles.separator} /> : null}
                <ProviderRows
                  provider={provider}
                  now={now}
                  display={display}
                  pending={pending !== null}
                  onSetDefault={session.client ? () => void setDefault(group.provider, provider.account!.id) : undefined}
                />
              </View>
            ))}
          </View>
        ))
      ) : !usage.error ? (
        <Text style={styles.muted}>No connected accounts. Sign in to a provider in Accounts to see its plan usage.</Text>
      ) : null}
      {usage.error || actionError ? (
        <Text selectable accessibilityRole="alert" style={[styles.muted, { color: colors.orangeInk }]}>
          {actionError || usage.error}
        </Text>
      ) : null}
    </View>
  );
}
