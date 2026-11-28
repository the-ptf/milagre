import { Text, View } from "react-native";
import { router } from "expo-router";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import {
  connectorAccessGroups,
  connectorAccessKey,
  connectorAccountName,
  connectorAllows,
  connectorStateLine,
  connectorSubtitle,
  type ConnectorSummary,
} from "@milagre/shared/connectors";
import { confirm } from "./confirm-store";
import { ConnectorTile } from "./connector-tile";
import { radius, space } from "./design-tokens";
import { Icon } from "./icons";
import { LinearSection } from "./linear-section";
import { useTheme } from "./theme";
import { Group, InlineError, ListRow, useStyles } from "./ui";
import { useConnectors } from "./use-connectors";

function Note({ connector, hostName }: { connector: ConnectorSummary; hostName: string }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const failed = connector.state === "failed";
  if (!failed && connector.state !== "needs-sign-in" && connector.state !== "needs-app") return null;
  const text = failed
    ? connectorStateLine(connector)
    : connector.state === "needs-app"
      ? `${connector.name} needs an app of its own. Add it in Milagre on ${hostName || "your computer"}.`
      : `Milagre isn't signed in to ${connector.name}. Sign in from Milagre on ${hostName || "your computer"}, where the sign-in page opens.`;
  return (
    <View
      accessibilityRole="alert"
      style={{ padding: space.lg, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: failed ? colors.redTint : colors.orangeTint }}
    >
      <Text style={[styles.muted, { color: failed ? colors.redInk : colors.orangeInk }]}>{text}</Text>
    </View>
  );
}

/** One connector's page: what it needs, its mailboxes or Linear settings, which accounts may use it, and remove. */
export function ConnectorDetail({ id }: { id: string }) {
  const styles = useStyles();
  const { client, hostName, connectors, accounts, error, act, setUpEmail } = useConnectors();
  const connector = connectors?.find((item) => item.id === id);
  if (!client || !connectors) return null;
  if (!connector) return <Text style={styles.muted}>This connector is no longer on {hostName || "the computer"}.</Text>;
  const forget = async (mailbox: string) => {
    if (await confirm(`Forget ${mailbox}?`, "Agents can no longer read its sign-in codes.", "Forget")) void act("email:disconnect", [mailbox]);
  };
  const remove = async () => {
    if (!(await confirm(`Remove ${connector.name}?`, "Chats lose its tools and Milagre signs out of it.", "Remove"))) return;
    await act("connectors:remove", [connector.id]);
    router.back();
  };
  const signsIn = connector.kind === "url" && connector.state !== "needs-sign-in" && connector.state !== "needs-app";
  return (
    <View style={{ gap: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
        <ConnectorTile connector={connector} size={56} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" style={styles.subtitle} numberOfLines={2}>
            {connector.name}
          </Text>
          <Text style={styles.footnote} numberOfLines={1}>
            {connector.kind === "linear" || connector.kind === "email" ? "Built in" : connectorSubtitle(connector)} · {connectorStateLine(connector)}
          </Text>
        </View>
      </View>
      <InlineError message={error} />
      <Note connector={connector} hostName={hostName} />
      {connector.kind === "email" ? (
        <Group title="Mailboxes" inset={0}>
          {(connector.mailboxes ?? []).map((mailbox) => (
            <ListRow
              key={mailbox.address}
              title={mailbox.address}
              subtitle={`${mailbox.host}:${mailbox.port}`}
              value="Forget"
              chevron={false}
              onPress={() => void forget(mailbox.address)}
            />
          ))}
          <ListRow title="Set up another mailbox" leading={<Icon icon={SparklesIcon} tone="ink2" size={20} />} onPress={() => void setUpEmail()} />
        </Group>
      ) : null}
      {connector.kind === "linear" ? <LinearSection /> : null}
      {connectorAccessGroups(connector).map((group) => (
        <Group key={group.id ?? connector.id} title={group.id ? `${group.name} · Available to` : "Available to"} inset={0}>
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
                  onChange: () => void act("connectors:access", [connector.id, account.provider, account.accountId, !on, ...(group.id ? [group.id] : [])]),
                }}
              />
            );
          })}
        </Group>
      ))}
      <Group inset={0}>
        {signsIn ? <ListRow title="Sign out" chevron={false} onPress={() => void act("connectors:sign-out", [connector.id])} /> : null}
        {connector.kind !== "linear" ? (
          <ListRow title={connector.kind === "email" ? "Forget all mailboxes" : "Remove"} destructive chevron={false} onPress={() => void remove()} />
        ) : null}
      </Group>
    </View>
  );
}
