import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import type { ProviderUsage, UsageWindow } from "@milagre/shared/model";
import { providerName } from "@milagre/shared/providers";
import { formatPercent, formatResetsIn, formatUpdatedAgo } from "@milagre/shared/usage";
import { ProviderLogo, SpinnerRing } from "./icons";
import { IconButton, useStyles } from "./ui";
import { useSession } from "./session";
import { useUsage } from "./use-usage";
import { useTheme } from "./theme";

function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const reset = formatResetsIn(window.resetsAt, now);
  return (
    <View style={{ gap: 7 }}>
      <View style={[styles.row, { justifyContent: "space-between", gap: 4 }]}>
        <Text style={{ color: colors.ink2, fontSize: 14 }}>{window.label}</Text>
        <Text selectable style={{ color: colors.ink, fontSize: 14, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
          {formatPercent(percent)} used
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`${window.label} usage`}
        accessibilityValue={{ min: 0, max: 100, now: percent, text: `${formatPercent(percent)} used${reset ? `, ${reset}` : ""}` }}
        style={{ height: 5, borderRadius: 3, overflow: "hidden", backgroundColor: colors.lineStrong }}
      >
        <View style={{ width: `${percent}%`, height: "100%", borderRadius: 3, backgroundColor: colors.ink }} />
      </View>
      {reset || window.detail ? (
        <Text selectable style={styles.caption}>
          {[window.detail, reset].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

function ProviderRows({ provider, now }: { provider: ProviderUsage; now: number }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const failed = provider.status === "error";
  const account = provider.account?.email || provider.account?.label;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ProviderLogo provider={provider.provider} size={20} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text
            selectable
            accessibilityLabel={`${providerName(provider.provider)} usage: ${account || "Account unavailable"}`}
            style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}
          >
            {account || "Account unavailable"}
          </Text>
          <Text selectable style={styles.caption}>
            {failed && provider.windows.length ? "Last known · " : ""}
            {formatUpdatedAgo(provider.updatedAt, now)}
          </Text>
        </View>
      </View>
      {provider.windows.map((window) => (
        <WindowRow key={window.id} window={window} now={now} />
      ))}
      {provider.bankedResets ? (
        <Text selectable style={styles.label}>
          Banked resets: {provider.bankedResets} left
        </Text>
      ) : null}
      {provider.message ? (
        <Text
          selectable
          accessibilityRole={failed ? "alert" : undefined}
          style={[styles.caption, { color: failed ? colors.orangeInk : colors.ink2, lineHeight: 18 }]}
        >
          {provider.message}
        </Text>
      ) : null}
      {!provider.windows.length && !provider.message ? <Text style={styles.muted}>Usage is unavailable.</Text> : null}
    </View>
  );
}

/** Plan usage, sourced only from the currently connected computer. */
export function UsageSection() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const usage = useUsage(session.client, session.snapshot?.project.path, session.providerRevision);
  const [now, setNow] = useState(Date.now);
  // A plain effect: the section also shows in the navigation panel, which sits outside the router's screens.
  useEffect(() => {
    const tick = () => {
      if (AppState.currentState === "active") setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, 30000);
    const subscription = AppState.addEventListener("change", tick);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  const providers = usage.snapshot?.providers.filter((provider) => provider.status !== "unavailable") ?? [];
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 16 }}>
        <Text accessibilityRole="header" style={styles.section}>
          Plan usage
        </Text>
        {session.client ? (
          <IconButton label="Refresh plan usage" icon={RefreshIcon} size={44} loading={usage.loading} onPress={() => void usage.refresh()} />
        ) : null}
      </View>
      <View style={[styles.card, { gap: 20 }]}>
        {!session.client ? (
          <Text style={styles.muted}>Connect to a computer to see its plan usage.</Text>
        ) : !usage.snapshot && usage.loading ? (
          <View style={[styles.row, { gap: 10 }]}>
            <SpinnerRing size={18} />
            <Text style={styles.muted}>Checking usage...</Text>
          </View>
        ) : providers.length ? (
          providers.map((provider, index) => (
            <View key={provider.provider} style={{ gap: 20 }}>
              {index > 0 ? <View style={styles.separator} /> : null}
              <ProviderRows provider={provider} now={now} />
            </View>
          ))
        ) : !usage.error ? (
          <Text style={styles.muted}>No plan usage is available. Sign in to Claude, Codex or Antigravity on your computer, then refresh.</Text>
        ) : null}
        {usage.error ? (
          <Text selectable accessibilityRole="alert" style={[styles.muted, { color: colors.orangeInk }]}>
            {usage.error}
          </Text>
        ) : null}
      </View>
      {session.client ? (
        <Text style={[styles.caption, { paddingHorizontal: 16 }]}>
          From {session.hostName || "your computer"}. Limits are shared across its Projects and Chats.
        </Text>
      ) : null}
    </View>
  );
}
