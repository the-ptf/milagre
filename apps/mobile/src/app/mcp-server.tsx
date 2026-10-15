import { useState } from "react";
import { Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { mcpChipLine, mcpEditTarget, mcpRemoveTargets, mcpTransportLine } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { useMcp } from "../use-mcp";
import { Button, PageScroll, Toggle, useStyles } from "../ui";
import { useTheme } from "../theme";
import { confirm } from "../confirm-store";

/** One server: a switch per account, and Edit and Remove for URL servers added in Milagre or a provider's user config. */
export default function McpServerScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const mcp = useMcp();
  const styles = useStyles();
  const { colors } = useTheme();
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
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
    if (!row || removing) return;
    setRemoving(true);
    setError("");
    try {
      if (!(await confirm(`Remove ${row.name}?`, "Chats stop loading it.", "Remove"))) return;
      await mcp.remove(row.name, mcpRemoveTargets(row));
      router.back();
    } catch (cause) {
      fail(cause);
    } finally {
      setRemoving(false);
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
          {row.chips.map((chip, index) => {
            // While the write runs the switch shows the value it was flipped to, and ignores taps.
            const pending = mcp.pending(chip, row.name);
            const on = pending ?? chip.state !== "disabled";
            return (
              <View key={`${chip.provider}:${chip.accountId}`} style={{ borderTopWidth: index ? 1 : 0, borderColor: colors.line, paddingVertical: 8, gap: 2 }}>
                <Toggle
                  title={`${providerName(chip.provider)} · ${chip.label}`}
                  selected={on}
                  disabled={pending !== undefined}
                  tint={colors.ink}
                  onPress={() => {
                    setError("");
                    void mcp.toggle(chip, row.name, !on)?.catch(fail);
                  }}
                />
                <Text style={[styles.muted, { color: chip.state === "failed" ? colors.red : colors.ink2, paddingBottom: 6 }]} selectable>
                  {chip.state === "needs-sign-in" ? "Needs sign-in. Sign in on the Mac." : mcpChipLine(chip)}
                </Text>
              </View>
            );
          })}
        </View>
        {error ? (
          <Text accessibilityRole="alert" selectable style={[styles.text, { color: colors.error }]}>
            {error}
          </Text>
        ) : null}
        {row.editable && row.transport === "url" ? (
          <View style={{ gap: 10 }}>
            <Button title="Edit" secondary onPress={() => router.push({ pathname: "/mcp-add", params: { name: row.name, target: mcpEditTarget(row) } })} />
            <Button title="Remove" secondary destructive loading={removing} onPress={() => void remove()} />
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
