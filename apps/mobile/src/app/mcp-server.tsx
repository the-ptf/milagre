import { useState } from "react";
import { Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { mcpChipLine, mcpTransportLine, type McpRow, type McpTarget } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { useMcp } from "../use-mcp";
import { Button, PageScroll, Toggle, useStyles } from "../ui";
import { useTheme } from "../theme";
import { confirm } from "../confirm-store";

/** Where an editable server is saved: Milagre's own list, or the provider config that holds it. */
const targetOf = (row: McpRow): McpTarget =>
  row.everywhere ? "everywhere" : ((row.chips.find((chip) => chip.scope === "user")?.provider as McpTarget | undefined) ?? "everywhere");

/** One server: a switch per account, and Edit and Remove for URL servers added in Milagre or a provider's user config. */
export default function McpServerScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const mcp = useMcp();
  const styles = useStyles();
  const { colors } = useTheme();
  const [error, setError] = useState("");
  const { attention, user, other } = mcp.groups;
  const row = [...attention, ...user, ...other.flatMap((group) => group.rows)].find((item) => item.name === name);
  if (!row)
    return (
      <>
        <Stack.Screen options={{ title: name ?? "MCP" }} />
        <PageScroll>
          <Text style={styles.muted}>{mcp.checking ? "Checking…" : "This server is no longer there."}</Text>
        </PageScroll>
      </>
    );
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not reach the computer.");
  async function remove() {
    if (!row || !(await confirm(`Remove ${row.name}?`, "Chats stop loading it.", "Remove"))) return;
    try {
      await mcp.remove(row.name, targetOf(row));
      router.back();
    } catch (cause) {
      fail(cause);
    }
  }
  return (
    <>
      <Stack.Screen options={{ title: row.name }} />
      <PageScroll>
        <Text selectable style={[styles.muted, { paddingHorizontal: 4 }]}>
          {mcpTransportLine(row)}
        </Text>
        <View style={{ backgroundColor: colors.surface, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 16 }}>
          {row.chips.map((chip, index) => (
            <View key={`${chip.provider}:${chip.accountId}`} style={{ borderTopWidth: index ? 1 : 0, borderColor: colors.line, paddingVertical: 8, gap: 2 }}>
              <Toggle
                title={`${providerName(chip.provider)} · ${chip.label}`}
                selected={chip.state !== "disabled"}
                tint={colors.ink}
                onPress={() => {
                  setError("");
                  void mcp.toggle(chip, row.name, chip.state === "disabled")?.catch(fail);
                }}
              />
              <Text style={[styles.muted, { color: chip.state === "failed" ? colors.red : colors.ink2, paddingBottom: 6 }]} selectable>
                {chip.state === "needs-sign-in" ? "Needs sign-in. Sign in on the Mac." : mcpChipLine(chip)}
              </Text>
            </View>
          ))}
        </View>
        {error ? (
          <Text accessibilityRole="alert" selectable style={[styles.text, { color: colors.error }]}>
            {error}
          </Text>
        ) : null}
        {row.editable && row.transport === "url" ? (
          <View style={{ gap: 10 }}>
            <Button title="Edit" secondary onPress={() => router.push({ pathname: "/mcp-add", params: { name: row.name, target: targetOf(row) } })} />
            <Button title="Remove" secondary destructive onPress={() => void remove()} />
          </View>
        ) : row.editable ? (
          <Text style={[styles.muted, { paddingHorizontal: 4 }]}>Edit on the Mac.</Text>
        ) : (
          <Text style={[styles.muted, { paddingHorizontal: 4 }]}>Set up outside Milagre. Change it where it is defined.</Text>
        )}
      </PageScroll>
    </>
  );
}
