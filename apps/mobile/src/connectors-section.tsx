import { Text, View } from "react-native";
import { router } from "expo-router";
import { GridViewIcon, Key01Icon } from "@hugeicons/core-free-icons";
import {
  CONNECTORS_HINT,
  CONNECTORS_TITLE,
  connectorMovedNote,
  connectorReach,
  connectorStateLine,
  searchConnectorPresets,
  type ConnectorSummary,
} from "@milagre/shared/connectors";
import { radius, space } from "./design-tokens";
import { ConnectorTile } from "./connector-tile";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { Group, InlineError, ListRow, useStyles } from "./ui";
import { useConnectors } from "./use-connectors";

const needsYou = (connector: ConnectorSummary) => connector.state === "needs-sign-in" || connector.state === "needs-app";

/** One line over the list for the first connector that needs you; the computer is where it signs in. */
function NeedsYouNote({ connectors, hostName }: { connectors: ConnectorSummary[]; hostName: string }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const waiting = connectors.filter(needsYou);
  if (!waiting.length) return null;
  const first = waiting[0]!;
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        gap: space.md,
        alignItems: "center",
        padding: space.lg,
        borderRadius: radius.card,
        borderCurve: "continuous",
        backgroundColor: colors.orangeTint,
      }}
    >
      <Icon icon={Key01Icon} color={colors.orangeInk} size={18} />
      <Text style={[styles.muted, { flex: 1, color: colors.orangeInk }]}>
        {first.name} needs you to {first.state === "needs-app" ? "add its app" : "sign in"} on {hostName || "the computer"}
        {waiting.length > 1 ? `, and ${waiting.length - 1} more` : ""}.
      </Text>
    </View>
  );
}

/** The computer's Connectors: a row each that opens its page, and Browse services for the catalog. */
export function ConnectorsSection() {
  const styles = useStyles();
  const { client, hostName, connectors, accounts, moved, error, act } = useConnectors();
  if (!client) return null;
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
          <ListRow title={connectorMovedNote(moved)} titleLines={4} chevron={false} value="Got it" onPress={() => void act("connectors:dismiss-moved", [])} />
        </Group>
      ) : null}
      {connectors ? <NeedsYouNote connectors={connectors} hostName={hostName} /> : null}
      {connectors?.length ? (
        <Group title={`Connected · ${connectors.length}`} inset={0}>
          {connectors.map((connector) => (
            <ListRow
              key={connector.id}
              title={connector.name}
              subtitle={`${connectorStateLine(connector)} · ${connectorReach(connector, accounts)}`}
              subtitleTone={needsYou(connector) ? "orangeInk" : connector.state === "failed" ? "redInk" : "ink3"}
              leading={<ConnectorTile connector={connector} />}
              onPress={() => router.push({ pathname: "/connector", params: { id: connector.id } })}
            />
          ))}
        </Group>
      ) : connectors ? (
        <Text style={styles.muted}>No connectors on {hostName || "this computer"} yet.</Text>
      ) : null}
      <Group inset={0}>
        <ListRow
          title="Browse services"
          subtitle={`Email, Notion, Sentry and ${searchConnectorPresets("").length - 3} more`}
          leading={<Icon icon={GridViewIcon} tone="ink" size={20} />}
          onPress={() => router.push("/connector-gallery")}
        />
      </Group>
    </View>
  );
}
