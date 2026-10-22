import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Briefcase01Icon, UserIcon, UserMultipleIcon, CheckmarkCircle02Icon, CircleIcon, MoreVerticalIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { AccountsSnapshot, ModelProvider } from "@milagre/shared/model";
import { accountType, providerName } from "@milagre/shared/providers";
import { useSession } from "./session";
import { Icon, ProviderLogo } from "./icons";
import { IconButton, PullDown, useStyles } from "./ui";
import { useTheme } from "./theme";

export function AccountsSection() {
  const session = useSession();
  return <AccountsForComputer key={session.client?.url || "disconnected"} />;
}

export function AccountsForComputer() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const client = session.client;
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    (refresh = false) => {
      if (!client) return Promise.resolve();
      return client
        .call<AccountsSnapshot>("accounts:list", [refresh])
        .then((value) => {
          setSnapshot(value);
          setError("");
        })
        .catch(() => setError("Could not load accounts. Check the computer connection, then refresh."));
    },
    [client],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const signingIn = snapshot?.providers.some((p) => p.accounts.some((a) => a.state === "signing-in"));
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [load, signingIn]);
  const act = async (action: "select" | "login" | "cancel" | "remove", provider: ModelProvider, value: string) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      setSnapshot(await client.call<AccountsSnapshot>(`accounts:${action}`, [provider, value]));
      if (action === "select" || action === "remove") void session.refreshProviders();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update this account. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const providers = snapshot?.providers.filter((group) => group.installed !== false);
  if (!client) return <Text style={styles.muted}>Connect to a computer to manage its accounts.</Text>;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={[styles.muted, { flex: 1 }]}>Tap an account to switch.</Text>
        <IconButton
          label="Refresh accounts"
          icon={RefreshIcon}
          disabled={busy}
          size={44}
          onPress={() => {
            setBusy(true);
            void load(true).finally(() => setBusy(false));
          }}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" selectable style={styles.text}>
          {error}
        </Text>
      ) : null}
      {!snapshot && !error ? <Text style={styles.muted}>Checking accounts...</Text> : null}
      {providers?.map((group) => (
        <View key={group.provider} style={{ gap: 8 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 4,
            }}
          >
            <ProviderLogo provider={group.provider} size={18} />
            <Text accessibilityRole="header" style={[styles.text, { fontWeight: "600" }]}>
              {providerName(group.provider)}
            </Text>
          </View>
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 14,
              borderCurve: "continuous",
              overflow: "hidden",
              borderWidth: 1,
              borderColor: colors.line,
            }}
          >
            {group.accounts.map((account, index) => {
              const selected = group.selectedId === account.id;
              const name = account.email || account.label;
              const type = accountType(account.plan);
              const typeIcon = type === "Business" ? Briefcase01Icon : type === "Team" ? UserMultipleIcon : UserIcon;
              const details = [
                account.state === "signed-out"
                  ? "Not signed in"
                  : account.state === "signing-in"
                    ? "Finish sign-in on computer"
                    : account.state === "unknown"
                      ? "Not checked"
                      : null,
                account.email && account.label !== account.email ? account.label : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <View
                  key={account.id}
                  style={{
                    borderTopWidth: index ? 1 : 0,
                    borderColor: colors.line,
                    backgroundColor: selected ? colors.hover : undefined,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityLabel={name}
                      accessibilityHint={`${type ? `${type} account. ` : ""}Switches this provider across Projects on your computer`}
                      accessibilityState={{
                        checked: selected,
                        disabled: busy || account.state !== "ready",
                      }}
                      disabled={busy || account.state !== "ready"}
                      onPress={() => {
                        if (!selected) void act("select", group.provider, account.id);
                      }}
                      style={({ pressed }) => ({
                        flex: 1,
                        minWidth: 0,
                        minHeight: 66,
                        paddingVertical: 12,
                        paddingHorizontal: 12,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 10,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Icon icon={selected ? CheckmarkCircle02Icon : CircleIcon} tone={selected ? "ink" : "ink3"} size={20} />
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.text,
                              {
                                flexShrink: 1,
                                fontSize: 15,
                                fontWeight: selected ? "600" : "400",
                              },
                            ]}
                          >
                            {name}
                          </Text>
                          {type ? <Icon icon={typeIcon} tone="ink3" size={15} /> : null}
                        </View>
                        {details ? (
                          <Text numberOfLines={1} style={styles.caption}>
                            {details}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                    {(account.id !== "default" || group.provider === "antigravity") && (
                      <PullDown
                        label={`Actions for ${name}`}
                        title={name}
                        style={{ padding: 4 }}
                        nativeTrigger={{
                          systemImage: "ellipsis",
                          iconSize: 14,
                          menuTint: colors.ink,
                          rotation: 90,
                          disabled: busy,
                        }}
                        sections={[
                          {
                            items: [
                              account.state === "signing-in"
                                ? {
                                    id: "cancel",
                                    title: "Cancel sign-in",
                                    systemImage: "xmark",
                                    disabled: busy,
                                  }
                                : {
                                    id: "login",
                                    title: "Re-authenticate",
                                    subtitle: "Finish on your computer",
                                    systemImage: "arrow.clockwise",
                                    disabled: busy || signingIn,
                                  },
                              ...(account.id === "default"
                                ? []
                                : [
                                    {
                                      id: "remove",
                                      title: "Remove",
                                      systemImage: "trash",
                                      disabled: busy,
                                    },
                                  ]),
                            ],
                          },
                        ]}
                        onSelect={(action) => {
                          if (action === "login" || action === "cancel" || action === "remove") void act(action, group.provider, account.id);
                        }}
                      >
                        <View
                          style={{
                            width: 44,
                            height: 48,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Icon icon={MoreVerticalIcon} tone="ink2" size={14} />
                        </View>
                      </PullDown>
                    )}
                  </View>
                  {account.message && account.state !== "signing-in" ? (
                    <Text
                      accessibilityRole={account.state === "error" ? "alert" : undefined}
                      style={[styles.caption, { paddingHorizontal: 12, paddingBottom: 10 }]}
                    >
                      {account.message}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      ))}
      <Text style={styles.caption}>Add accounts on {session.hostName || "your computer"}. Running replies keep their current account.</Text>
      <Text style={styles.caption}>Remove keeps the local profile. Removing the active account switches to the connected CLI account.</Text>
    </View>
  );
}
