import { Children, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { mcpSourceRank, mcpSummary, mcpTransportLine, type McpRow } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { useSession } from "./session";
import { Icon } from "./icons";
import { useMcp } from "./use-mcp";
import { useStyles } from "./ui";
import { useTheme } from "./theme";

const openServer = (row: McpRow) => router.push({ pathname: "/mcp-server", params: { name: row.name } });

/** Settings › MCP for the connected Mac: every account's servers, checked now. */
export function McpSection() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { client, hostName } = useSession();
  const mcp = useMcp();
  const [open, setOpen] = useState(false);
  const { attention, user, other } = mcp.groups;
  // Sign-in rows from a project or plugin sit with their source; the top list is for the servers you add yourself.
  const signIn = attention.filter((row) => !row.source);
  const groups = new Map<string, McpRow[]>();
  for (const group of other) groups.set(group.source, [...group.rows]);
  for (const row of attention) if (row.source) groups.set(row.source, [...(groups.get(row.source) ?? []), row]);
  const sources = [...groups]
    .map(([source, rows]) => ({ source, rows: rows.toSorted((a, b) => a.name.localeCompare(b.name)) }))
    .toSorted((a, b) => mcpSourceRank(a.source) - mcpSourceRank(b.source) || a.source.localeCompare(b.source));
  const outside = sources.reduce((total, group) => total + group.rows.length, 0);
  const empty = !!mcp.entries && !mcp.checking && !signIn.length && !user.length && !outside && !mcp.problems.length;

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6, paddingHorizontal: 4 }}>
        <Text accessibilityRole="header" style={styles.title}>
          MCP
        </Text>
        <Text style={styles.muted}>
          {client
            ? `Servers Chats load on ${hostName || "this computer"}. ${mcp.checking ? "Checking…" : "Checked just now."}`
            : "Connect to a computer to see its MCP servers."}
        </Text>
      </View>
      {mcp.error ? (
        <Text accessibilityRole="alert" selectable style={[styles.text, { color: colors.error }]}>
          {mcp.error}
        </Text>
      ) : null}
      {mcp.problems.map((check) => (
        <Text key={`${check.provider}:${check.accountId}`} style={styles.muted}>
          {providerName(check.provider)} · {check.label}: {check.problem}
        </Text>
      ))}
      {signIn.length ? (
        <Group title="Needs sign-in">
          {signIn.map((row) => (
            <View key={row.name} style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 10 }}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  borderCurve: "continuous",
                  backgroundColor: colors.orangeTint,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon icon={Key01Icon} tone="orange" size={18} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={[styles.text, { fontWeight: "500" }]}>
                  {row.name}
                </Text>
                <Text numberOfLines={1} style={styles.caption}>
                  {mcpTransportLine(row)}
                </Text>
              </View>
              <Text style={[styles.caption, { fontSize: 13 }]}>On the Mac</Text>
            </View>
          ))}
        </Group>
      ) : null}
      {user.length ? (
        <Group title="Your servers">
          {user.map((row) => (
            <ServerRow key={row.name} row={row} />
          ))}
        </Group>
      ) : null}
      {outside ? (
        <View style={{ gap: 10 }}>
          <View style={cardStyle(colors)}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Projects and plugins, ${outside}`}
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen(!open)}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 56, opacity: pressed ? 0.5 : 1 })}
            >
              <Text style={[styles.text, { flex: 1, fontWeight: "500" }]}>Projects and plugins</Text>
              <Text style={[styles.muted, { fontSize: 17 }]}>{outside}</Text>
              <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={16} />
            </Pressable>
          </View>
          {open ? (
            <>
              <Text style={[styles.caption, { paddingHorizontal: 4 }]}>Set up in a project, a plugin or claude.ai. Change them there.</Text>
              {sources.map((group) => (
                <Group key={group.source} title={group.source}>
                  {group.rows.map((row) => (
                    <ServerRow key={row.name} row={row} compact />
                  ))}
                </Group>
              ))}
            </>
          ) : null}
        </View>
      ) : null}
      {empty ? <Text style={styles.muted}>No MCP servers yet. Tap + to add one, or use the Claude or Codex CLI on the Mac.</Text> : null}
    </View>
  );
}

const cardStyle = (colors: ReturnType<typeof useTheme>["colors"]) =>
  ({
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderCurve: "continuous",
    overflow: "hidden",
    paddingHorizontal: 16,
  }) as const;

/** A small caps header over a grouped card; rows are separated by hairlines. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={[styles.section, { paddingHorizontal: 4 }]}>
        {title}
      </Text>
      <View style={cardStyle(colors)}>
        {Children.toArray(children).map((child, index) => (
          <View key={(child as { key?: string }).key ?? String(index)}>
            {index > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line }} /> : null}
            {child}
          </View>
        ))}
      </View>
    </View>
  );
}

function ServerRow({ row, compact = false }: { row: McpRow; compact?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const failed = row.chips.find((chip) => chip.state === "failed");
  const kind = row.everywhere ? "Everywhere" : row.transport === "command" ? "Command" : row.transport === "url" ? "URL" : "claude.ai";
  const line = failed ? `${providerName(failed.provider)} failed · ${mcpSummary(row)}` : `${kind} · ${mcpSummary(row)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.name}. ${line}`}
      onPress={() => openServer(row)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: compact ? 52 : 60,
        paddingVertical: 10,
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[styles.text, { fontWeight: "500" }]}>
          {row.name}
        </Text>
        <Text numberOfLines={1} style={[styles.caption, { fontSize: 13 }, failed ? { color: colors.red } : null]}>
          {line}
        </Text>
      </View>
      {failed ? <Icon icon={Alert02Icon} tone="red" size={20} /> : null}
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </Pressable>
  );
}
