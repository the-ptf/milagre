import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useFocusEffect } from "expo-router";
import { Globe02Icon } from "@hugeicons/core-free-icons";
import {
  CONNECTORS_HINT,
  CONNECTORS_TITLE,
  CONNECTOR_ON_COMPUTER,
  connectorAccessKey,
  connectorAccountName,
  connectorAllows,
  connectorPreset,
  connectorReach,
  connectorStateLine,
  type ConnectorSummary,
} from "@milagre/shared/connectors";
import type { McpAccount } from "@milagre/shared/mcp";
import { confirm } from "./confirm-store";
import { Icon } from "./icons";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { Group, InlineError, ListRow, useStyles } from "./ui";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function Tile({ connector }: { connector: ConnectorSummary }) {
  const { colors } = useTheme();
  const iconPath = connectorPreset(connector)?.iconPath;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {iconPath ? (
        <Svg width={20} height={20} viewBox="0 0 24 24">
          <Path d={iconPath} fill={colors.ink} />
        </Svg>
      ) : (
        <Icon icon={Globe02Icon} tone="ink2" size={20} />
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
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const [list, found] = await Promise.all([
        client.call<ConnectorSummary[]>("connectors:list", []),
        client.call<McpAccount[]>("mcp:accounts", []).catch(() => [] as McpAccount[]),
      ]);
      setConnectors(list);
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
      {selected ? (
        <>
          <Group title={`${selected.name} · Available to`} inset={0}>
            {accounts.map((account) => {
              const on = connectorAllows(selected, account.provider, account.accountId);
              return (
                <ListRow
                  key={connectorAccessKey(account.provider, account.accountId)}
                  title={connectorAccountName(account)}
                  toggle={{
                    value: on,
                    label: `${selected.name} for ${connectorAccountName(account)}`,
                    onChange: () => act("connectors:access", [selected.id, account.provider, account.accountId, !on]),
                  }}
                />
              );
            })}
          </Group>
          <Group inset={0}>
            {selected.state !== "needs-sign-in" ? <ListRow title="Sign out" chevron={false} onPress={() => act("connectors:sign-out", [selected.id])} /> : null}
            <ListRow title="Remove" destructive chevron={false} onPress={() => void remove(selected)} />
          </Group>
        </>
      ) : null}
      <Text style={[styles.footnote, { paddingHorizontal: 16 }]}>{CONNECTOR_ON_COMPUTER}</Text>
    </View>
  );
}
