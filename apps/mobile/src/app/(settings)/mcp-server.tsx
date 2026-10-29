import { useState } from "react";
import { Pressable, Text, View, type StyleProp, type TextStyle } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { mcpChipLine, mcpEditTarget, mcpRemoveTargets, mcpTargetPlaces, mcpTransportLine } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { useMcp } from "../../use-mcp";
import { Button, PageScroll, Toggle, useStyles } from "../../ui";
import { useTheme } from "../../theme";
import { confirm } from "../../confirm-store";

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
      const targets = mcpRemoveTargets(row);
      if (!(await confirm(`Remove ${row.name}?`, `Removes it from ${mcpTargetPlaces(targets)}. Chats stop loading it.`, "Remove"))) return;
      await mcp.remove(row.name, targets);
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
                  // Off in the provider's own config: Milagre's switch can't turn it on.
                  disabled={pending !== undefined || chip.disabledBy === "provider"}
                  tint={colors.ink}
                  onPress={() => {
                    setError("");
                    void mcp.toggle(chip, row.name, !on)?.catch(fail);
                  }}
                />
                <View style={{ paddingBottom: 6 }}>
                  <ChipLine
                    text={chip.state === "needs-sign-in" ? "Needs sign-in. Sign in on the Mac." : mcpChipLine(chip)}
                    style={[styles.muted, { color: chip.state === "failed" ? colors.redInk : colors.ink2 }]}
                  />
                </View>
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

/** An account's line, cut at three lines (Codex errors run long) with Show more / Show less. A hidden copy without the
 * limit measures the full text, so the button only appears when three lines really cut it. */
function ChipLine({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const { colors } = useTheme();
  const [lines, setLines] = useState(0);
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Text selectable numberOfLines={open ? undefined : 3} style={style}>
        {text}
      </Text>
      <Text
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        onTextLayout={(event) => setLines(event.nativeEvent.lines.length)}
        style={[style, { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 }]}
      >
        {text}
      </Text>
      {lines > 3 ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setOpen(!open)}
          style={({ pressed }) => ({ alignSelf: "flex-start", minHeight: 32, justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
        >
          <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "600" }}>{open ? "Show less" : "Show more"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
