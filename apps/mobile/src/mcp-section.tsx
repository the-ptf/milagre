import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { mcpSourceRank, mcpSummary, mcpTransportLine, type McpRow } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { useSession } from "./session";
import { Icon } from "./icons";
import { useMcp } from "./use-mcp";
import { EmptyState, Group, InlineError, ListRow, pressStyle, useStyles } from "./ui";
import { radius } from "./design-tokens";
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
  // Your own servers that need sign-in are listed in Your servers too (user holds every editable row).
  const signIn = attention.filter((row) => !row.source);
  const groups = new Map<string, McpRow[]>();
  for (const group of other) groups.set(group.source, [...group.rows]);
  for (const row of attention) if (row.source) groups.set(row.source, [...(groups.get(row.source) ?? []), row]);
  // Copy then sort: this Hermes build has no Array#toSorted, and these arrays are copies already.
  /* oxlint-disable unicorn/no-array-sort */
  const sources = [...groups]
    .map(([source, rows]) => ({ source, rows: [...rows].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => mcpSourceRank(a.source) - mcpSourceRank(b.source) || a.source.localeCompare(b.source));
  /* oxlint-enable unicorn/no-array-sort */
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
      <InlineError message={mcp.error} />
      {mcp.problems.map((check) => (
        <Text key={`${check.provider}:${check.accountId}`} style={styles.muted}>
          {providerName(check.provider)} · {check.label}: {check.problem}
        </Text>
      ))}
      {signIn.length ? (
        <Group title="Needs sign-in" inset={0}>
          {signIn.map((row) => (
            // Tappable like any row: the detail screen has the switches, and Edit and Remove for your own servers.
            <ListRow
              key={row.name}
              title={row.name}
              subtitle={mcpTransportLine(row)}
              value="On the Mac"
              onPress={() => openServer(row)}
              leading={
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: radius.control,
                    borderCurve: "continuous",
                    backgroundColor: colors.orangeTint,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon icon={Key01Icon} tone="orange" size={18} />
                </View>
              }
            />
          ))}
        </Group>
      ) : null}
      {user.length ? (
        <Group title="Your servers" inset={0}>
          {user.map((row) => (
            <ServerRow key={row.name} row={row} />
          ))}
        </Group>
      ) : null}
      {outside ? (
        <View style={{ gap: 12 }}>
          <Group>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Projects and plugins, ${outside}`}
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen(!open)}
              style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52 }, pressStyle({ pressed, kind: "row" })]}
            >
              <Text style={[styles.text, { flex: 1 }]}>Projects and plugins</Text>
              <Text style={[styles.text, { color: colors.ink3 }]}>{outside}</Text>
              <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={16} />
            </Pressable>
          </Group>
          {open ? (
            <>
              <Text style={[styles.footnote, { paddingHorizontal: 16 }]}>Set up in a Project, a plugin or claude.ai. Change them there.</Text>
              {sources.map((group) => (
                <Group key={group.source} title={group.source} inset={0}>
                  {group.rows.map((row) => (
                    <ServerRow key={row.name} row={row} />
                  ))}
                </Group>
              ))}
            </>
          ) : null}
        </View>
      ) : null}
      {empty ? <EmptyState title="No MCP servers yet">Tap + to add one, or use the Claude or Codex CLI on the Mac.</EmptyState> : null}
    </View>
  );
}

/** A server: its name, how it runs and where it loads (redInk when a provider failed to load it). */
function ServerRow({ row }: { row: McpRow }) {
  const failed = row.chips.find((chip) => chip.state === "failed");
  const kind = row.everywhere ? "Everywhere" : row.transport === "command" ? "Command" : row.transport === "url" ? "URL" : "claude.ai";
  const line = failed ? `${providerName(failed.provider)} failed · ${mcpSummary(row)}` : `${kind} · ${mcpSummary(row)}`;
  return (
    <ListRow
      title={row.name}
      subtitle={line}
      subtitleTone={failed ? "redInk" : "ink3"}
      onPress={() => openServer(row)}
      trailing={
        <>
          {failed ? <Icon icon={Alert02Icon} tone="red" size={20} /> : null}
          <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
        </>
      }
    />
  );
}
