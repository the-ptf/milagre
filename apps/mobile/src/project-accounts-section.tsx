import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowDown01Icon, Tick02Icon, Briefcase01Icon, UserIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import type { ModelProvider, ProjectAccountScope, ProjectAccountsSnapshot } from "@milagre/shared/model";
import { accountType, providerName } from "@milagre/shared/providers";
import { CHATS_ACCOUNT_DETAIL } from "@milagre/shared/chats-home";
import { useSession } from "./session";
import { Icon, ProviderLogo } from "./icons";
import { ChatsHomeIcon, ProjectIcon, ProjectIcons } from "./project-icon";
import { ListRow, PageScroll, PullDown, useStyles } from "./ui";
import { useTheme, type Palette } from "./theme";

const statusLabel = (state: string, message?: string) =>
  state === "signed-out"
    ? "Not signed in"
    : state === "signing-in"
      ? "Finish sign-in on computer"
      : state === "unknown"
        ? "Not checked"
        : message || "Account unavailable";

const dividerFor = (colors: Palette) => ({ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line });

export function ProjectAccountsSection() {
  const session = useSession();
  return <ProjectAccountsForComputer key={session.client?.url || "disconnected"} />;
}

// The same choice inside a Project's own settings, fixed to that Project.
export function ProjectAccountsGroup({ path }: { path: string }) {
  const styles = useStyles();
  const session = useSession();
  if (!session.client) return null;
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>Accounts</Text>
      <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
        <ProjectAccountRows key={`${session.client.url}:${path}`} scopeKey={path} />
      </View>
      <Footnote />
    </View>
  );
}

function Footnote() {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Text style={[styles.caption, { lineHeight: 17 }]}>
      Running turns keep their original account. The next turn uses the one chosen here.{" "}
      <Text accessibilityRole="link" style={{ color: colors.ink2, textDecorationLine: "underline" }} onPress={() => router.push("/accounts")}>
        Manage saved accounts
      </Text>
    </Text>
  );
}

/* One row per provider. The row shows the account the next turn uses;
 * a second line appears only when that account needs attention. */
function ProjectAccountRows({ scopeKey }: { scopeKey: string }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const client = session.client;
  const [snapshot, setSnapshot] = useState<ProjectAccountsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  // Cleared on unmount so a late reply from a previous Project or Link changes nothing.
  const activeScope = useRef(scopeKey);
  useEffect(() => {
    activeScope.current = scopeKey;
    return () => {
      activeScope.current = "";
    };
  }, [scopeKey]);
  const load = useCallback(
    async (refresh = false) => {
      if (!client || !scopeKey) return;
      const version = ++request.current;
      try {
        const value = await client.call<ProjectAccountsSnapshot>("accounts:scope", [scopeKey, refresh]);
        if (version === request.current && activeScope.current === scopeKey) {
          setSnapshot(value);
          setError("");
        }
      } catch {
        if (version === request.current && activeScope.current === scopeKey) setError("Could not load project accounts. Try refreshing.");
      }
    },
    [client, scopeKey],
  );
  const invalidate = useCallback(() => {
    request.current++;
  }, []);
  // This effect fetches the scope's accounts from the connected computer.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return invalidate;
  }, [load, invalidate, session.providerRevision, retry]);
  const visible = snapshot?.scopeKey === scopeKey ? snapshot : null;
  const { refreshProviders } = session;
  const signingIn = visible?.providers.some((group) => group.accounts.some((account) => account.state === "signing-in"));
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(() => {
      void load(true);
      void refreshProviders();
    }, 1500);
    return () => clearInterval(timer);
  }, [load, signingIn, refreshProviders]);
  const assign = async (provider: ModelProvider, id: string | null) => {
    if (!client || busy) return;
    const version = ++request.current;
    setBusy(true);
    setError("");
    try {
      const value = await client.call<ProjectAccountsSnapshot>("accounts:assign", [scopeKey, provider, id]);
      if (version === request.current && activeScope.current === scopeKey) setSnapshot(value);
      void refreshProviders();
    } catch (reason) {
      if (activeScope.current === scopeKey) setError(reason instanceof Error ? reason.message : "Could not update this account. Try again.");
    } finally {
      if (activeScope.current === scopeKey) setBusy(false);
    }
  };
  const reauthenticate = async (provider: ModelProvider, id: string) => {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.call("accounts:login", [provider, id]);
      if (activeScope.current !== scopeKey) return;
      await load();
      void refreshProviders();
    } catch (reason) {
      if (activeScope.current === scopeKey) setError(reason instanceof Error ? reason.message : "Could not start sign-in. Try again.");
    } finally {
      if (activeScope.current === scopeKey) setBusy(false);
    }
  };
  if (error)
    return (
      <View style={{ paddingVertical: 8 }}>
        <Text accessibilityRole="alert" style={[styles.text, { color: colors.red }]}>
          {error}
        </Text>
        <ListRow compact title="Retry" onPress={() => setRetry((value) => value + 1)} />
      </View>
    );
  if (!visible) return <Text style={[styles.muted, { paddingVertical: 12 }]}>Checking accounts...</Text>;
  return visible.providers.map((group, index) => {
    const effective = group.accounts.find((account) => account.id === group.effectiveId);
    const fallback = group.accounts.find((account) => account.id === group.defaultId);
    const missing = group.accountId !== null && (!effective || effective.missing === true);
    const shown = group.accountId === null ? fallback : effective;
    const type = accountType(shown?.plan);
    const typeIcon = type === "Business" ? Briefcase01Icon : type === "Team" ? UserMultipleIcon : UserIcon;
    const name = providerName(group.provider);
    const attention = missing
      ? "The assigned account is unavailable. Choose another saved account."
      : effective && effective.state !== "ready"
        ? statusLabel(effective.state, effective.message)
        : "";
    return (
      <View key={group.provider} style={[{ paddingVertical: 10, gap: 6 }, index > 0 && dividerFor(colors)]}>
        <PullDown
          label={`${name} account`}
          sections={[
            {
              items: [
                {
                  id: "__default__",
                  title: `Use computer default${fallback?.email ? ` · ${fallback.email}` : ""}`,
                  systemImage: "desktopcomputer",
                  checked: group.accountId === null,
                  disabled: busy,
                },
                ...group.accounts
                  .filter((account) => !account.missing)
                  .map((account) => ({
                    id: account.id,
                    title: account.email || account.label,
                    subtitle: account.state === "ready" ? undefined : statusLabel(account.state, account.message),
                    systemImage: accountType(account.plan) === "Business" ? "briefcase" : accountType(account.plan) === "Team" ? "person.2" : "person",
                    checked: group.accountId === account.id,
                    disabled: busy || account.state !== "ready",
                  })),
              ],
            },
          ]}
          onSelect={(id) => {
            void assign(group.provider, id === "__default__" ? null : id);
          }}
        >
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center", minHeight: 44 }}>
            <ProviderLogo provider={group.provider} size={20} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.text, { fontWeight: "500", fontSize: 15, lineHeight: 20 }]}>{name}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {type ? <Icon icon={typeIcon} tone="ink3" size={13} /> : null}
                <Text numberOfLines={1} style={[styles.caption, { flexShrink: 1, fontSize: 13, color: missing ? colors.red : colors.ink2 }]}>
                  {missing ? "Unavailable account" : shown?.email || shown?.label || "No computer default"}
                </Text>
                {group.accountId === null ? (
                  <Text style={[styles.caption, { fontSize: 11, backgroundColor: colors.line, paddingHorizontal: 5, borderRadius: 4, overflow: "hidden" }]}>
                    Default
                  </Text>
                ) : null}
              </View>
            </View>
            <Icon icon={ArrowDown01Icon} tone="ink3" size={18} />
          </View>
        </PullDown>
        {attention ? (
          <Text accessibilityRole="alert" style={[styles.caption, { color: colors.red, paddingLeft: 32 }]}>
            {attention}
          </Text>
        ) : effective?.message ? (
          <Text style={[styles.caption, { paddingLeft: 32 }]}>{effective.message}</Text>
        ) : null}
        {effective && !missing && effective.state !== "ready" && effective.id !== "default" ? (
          <View style={{ paddingLeft: 32 }}>
            <ListRow
              compact
              title={effective.state === "signing-in" ? "Finish sign-in on computer" : "Re-authenticate"}
              disabled={busy || effective.state === "signing-in"}
              onPress={() => {
                void reauthenticate(group.provider, effective.id);
              }}
            />
          </View>
        ) : null}
      </View>
    );
  });
}

function ProjectAccountsForComputer() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const client = session.client;
  const [scopes, setScopes] = useState<ProjectAccountScope[]>([]);
  const [scopeKey, setScopeKey] = useState(session.snapshot?.project.path || "");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client
      .call<ProjectAccountScope[]>("accounts:scopes")
      .then((value) => {
        if (!live) return;
        setScopes(value);
        setError("");
        setScopeKey((current) => (value.some((scope) => scope.key === current) ? current : value[0]?.key || ""));
      })
      .catch(() => {
        if (live) setError("Could not load Projects & Links. Check the computer connection.");
      });
    return () => {
      live = false;
    };
  }, [client, retry]);
  const selected = scopes.find((scope) => scope.key === scopeKey);
  // The Chats home has no repository picture of its own to show: it wears the Chats group's mark.
  const photo = (scope: ProjectAccountScope) =>
    scope.chatsHome ? (
      <ChatsHomeIcon />
    ) : scope.kind === "link" ? (
      <ProjectIcons client={client} projects={scope.projects} />
    ) : (
      <ProjectIcon client={client} path={scope.projects[0]?.path || scope.key} />
    );
  if (!client) return <Text style={styles.muted}>Connect to a computer to choose project accounts.</Text>;
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.caption}>Choose which saved accounts a Project or Link uses on this computer.</Text>
      <View style={[styles.card, { paddingVertical: 4, gap: 0 }]}>
        <ListRow
          compact
          title={selected?.name || "Choose a Project or Link"}
          subtitle={
            selected?.kind === "link"
              ? "Link · accounts are independent of its Projects"
              : selected?.chatsHome
                ? CHATS_ACCOUNT_DETAIL
                : selected
                  ? "Project"
                  : undefined
          }
          leading={selected ? photo(selected) : undefined}
          trailing={<Icon icon={ArrowDown01Icon} tone="ink3" size={18} />}
          onPress={() => setExpanded((value) => !value)}
        />
        {expanded ? (
          <PageScroll nestedScrollEnabled style={{ maxHeight: 280 }} contentContainerStyle={{ padding: 0 }}>
            {(["project", "link"] as const).map((kind) => (
              <View key={kind}>
                {scopes.some((scope) => scope.kind === kind) ? <Text style={styles.caption}>{kind === "project" ? "Projects" : "Links"}</Text> : null}
                {scopes
                  .filter((scope) => scope.kind === kind)
                  .map((scope) => (
                    <ListRow
                      key={scope.key}
                      compact
                      title={scope.name}
                      leading={photo(scope)}
                      trailing={scope.key === scopeKey ? <Icon icon={Tick02Icon} size={18} /> : undefined}
                      onPress={() => {
                        setScopeKey(scope.key);
                        setExpanded(false);
                      }}
                    />
                  ))}
              </View>
            ))}
          </PageScroll>
        ) : null}
        <View style={dividerFor(colors)}>
          {error ? (
            <View style={{ paddingVertical: 8 }}>
              <Text accessibilityRole="alert" style={[styles.text, { color: colors.red }]}>
                {error}
              </Text>
              <ListRow compact title="Retry" onPress={() => setRetry((value) => value + 1)} />
            </View>
          ) : scopeKey ? (
            <ProjectAccountRows key={scopeKey} scopeKey={scopeKey} />
          ) : (
            <Text style={[styles.muted, { paddingVertical: 12 }]}>Open a Project on your computer to choose its accounts.</Text>
          )}
        </View>
      </View>
      <Footnote />
    </View>
  );
}
