import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { router, useFocusEffect } from "expo-router";
import { CommandLineIcon, Globe02Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import {
  CONNECTORS_HINT,
  CONNECTORS_TITLE,
  CONNECTOR_ON_COMPUTER,
  connectorAccessGroups,
  connectorAccessKey,
  connectorAccountName,
  connectorAllows,
  connectorPreset,
  connectorReach,
  connectorStateLine,
  connectorMovedNote,
  CONNECTOR_PRESETS,
  type ConnectorSummary,
} from "@milagre/shared/connectors";
import type { McpAccount } from "@milagre/shared/mcp";
import { EMAIL_CONFIGURE_HINT, emailSetupPrompt } from "@milagre/shared/email";
import { confirm } from "./confirm-store";
import { LinearSection } from "./linear-section";
import { Icon } from "./icons";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { Group, InlineError, ListRow, useStyles } from "./ui";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function Tile({ connector }: { connector: ConnectorSummary }) {
  const { colors } = useTheme();
  const iconPath = connector.kind === "linear" ? CONNECTOR_PRESETS.find((preset) => preset.id === "linear")?.iconPath : connectorPreset(connector)?.iconPath;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {iconPath ? (
        <Svg width={20} height={20} viewBox="0 0 24 24">
          <Path d={iconPath} fill={colors.ink} />
        </Svg>
      ) : (
        <Icon icon={connector.kind === "email" ? Mail01Icon : connector.kind === "command" ? CommandLineIcon : Globe02Icon} tone="ink2" size={20} />
      )}
    </View>
  );
}

/** The computer's Connectors: which Accounts reach each, sign out and remove. Adding and signing in happen on the computer, where the browser returns. */
export function ConnectorsSection() {
  const styles = useStyles();
  const { client, hostName } = useSession();
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [accounts, setAccounts] = useState<McpAccount[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [moved, setMoved] = useState<string[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const [list, found, movedHere] = await Promise.all([
        client.call<ConnectorSummary[]>("connectors:list", []),
        client.call<McpAccount[]>("mcp:accounts", []).catch(() => [] as McpAccount[]),
        client.call<string[]>("connectors:moved", []).catch(() => [] as string[]),
      ]);
      setConnectors(list);
      setMoved(movedHere);
      setAccounts(found);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const act = (method: string, args: unknown[]) => {
    if (!client) return;
    setError("");
    void client.call(method, args).then(load, (cause: unknown) => setError(messageOf(cause)));
  };
  /** Configure for me: a Chat without a Project on the computer, with the email setup prompt ready to send. */
  const setUpEmail = async () => {
    if (!client) return;
    setError("");
    try {
      const home = await client.chatsHome();
      if (!home) throw new Error("This computer can't start a Chat without a Project. Update Milagre on it.");
      const projectPath = home.exists ? home.path : (await client.ensureChatsHome()).path;
      router.dismissAll();
      router.replace({ pathname: "/chat", params: { projectPath, hostId: client.url, prefill: emailSetupPrompt("") } });
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const forget = async (mailbox: string) => {
    if (await confirm(`Forget ${mailbox}?`, "Agents can no longer read its sign-in codes.", "Forget")) act("email:disconnect", [mailbox]);
  };
  const remove = async (connector: ConnectorSummary) => {
    if (await confirm(`Remove ${connector.name}?`, "Chats lose its tools and Milagre signs out of it.", "Remove")) act("connectors:remove", [connector.id]);
  };

  if (!client) return null;
  const selected = connectors?.find((connector) => connector.id === open);
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={styles.title}>
          {CONNECTORS_TITLE}
        </Text>
        <Text style={styles.muted}>
          {CONNECTORS_HINT} Sign-ins stay on {hostName || "the computer"}.
        </Text>
      </View>
      <InlineError message={error} />
      {moved.length ? (
        <Group inset={0}>
          <ListRow title={connectorMovedNote(moved)} titleLines={4} chevron={false} value="Got it" onPress={() => act("connectors:dismiss-moved", [])} />
        </Group>
      ) : null}
      {connectors?.length ? (
        <Group inset={0}>
          {connectors.map((connector) => (
            <ListRow
              key={connector.id}
              title={connector.name}
              subtitle={`${connectorStateLine(connector)} · ${connectorReach(connector, accounts)}`}
              subtitleTone={connector.state === "failed" ? "redInk" : "ink3"}
              leading={<Tile connector={connector} />}
              selected={open === connector.id}
              onPress={() => setOpen(open === connector.id ? null : connector.id)}
            />
          ))}
        </Group>
      ) : connectors ? (
        <Text style={styles.muted}>No connectors on {hostName || "this computer"} yet.</Text>
      ) : null}
      <Group inset={0}>
        <ListRow title="Set up email" subtitle={EMAIL_CONFIGURE_HINT} subtitleLines={3} onPress={() => void setUpEmail()} />
      </Group>
      {selected ? (
        <>
          {connectorAccessGroups(selected).map((group) => (
            <Group key={group.id ?? selected.id} title={`${group.name} · Available to`} inset={0}>
              {accounts.map((account) => {
                const on = connectorAllows(group, account.provider, account.accountId);
                const label = connectorAccountName(account);
                return (
                  <ListRow
                    key={connectorAccessKey(account.provider, account.accountId)}
                    title={label}
                    toggle={{
                      value: on,
                      label: `${group.name} for ${label}`,
                      onChange: () => act("connectors:access", [selected.id, account.provider, account.accountId, !on, ...(group.id ? [group.id] : [])]),
                    }}
                  />
                );
              })}
            </Group>
          ))}
          {selected.kind === "linear" ? <LinearSection /> : null}
          {selected.kind === "email" ? (
            <Group title="Mailboxes" inset={0}>
              {(selected.mailboxes ?? []).map((mailbox) => (
                <ListRow
                  key={mailbox.address}
                  title={mailbox.address}
                  subtitle={`${mailbox.host}:${mailbox.port}`}
                  value="Forget"
                  chevron={false}
                  onPress={() => void forget(mailbox.address)}
                />
              ))}
            </Group>
          ) : null}
          <Group inset={0}>
            {selected.kind === "url" && selected.state !== "needs-sign-in" && selected.state !== "needs-app" ? (
              <ListRow title="Sign out" chevron={false} onPress={() => act("connectors:sign-out", [selected.id])} />
            ) : null}
            {selected.kind !== "linear" ? <ListRow title="Remove" destructive chevron={false} onPress={() => void remove(selected)} /> : null}
          </Group>
        </>
      ) : null}
      <Text style={[styles.footnote, { paddingHorizontal: 16 }]}>{CONNECTOR_ON_COMPUTER}</Text>
    </View>
  );
}
