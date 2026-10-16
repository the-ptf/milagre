import { useEffect } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { contextHint, contextSummary } from "@milagre/shared/usage";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import { useComposer, useSession } from "../session";
import { PillButton, useStyles } from "../ui";
import { useTheme } from "../theme";

/**
 * Desktop's context card as a sheet: how full the Chat's context window is. Reads the live numbers, so it fills while
 * a turn runs. On a Claude chat it offers Compact now, which the chat screen sends as `/compact` once the sheet closes.
 */
export default function ContextSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const composer = useComposer();
  const project = session.snapshot?.project;
  const chat = project && id ? project.state.sessions[Number(id)] : undefined;
  const chatId = project ? `${project.path}#${id}` : null;
  const run = chatId ? session.snapshot?.runs.runs[chatId] : undefined;
  const usage = (project && chat ? run?.contextUsage : undefined) ?? chat?.contextUsage;
  const missing = !usage || usage.size <= 0;
  // The Chat went away (another host, a reset session): nothing to show.
  useEffect(() => {
    if (missing) router.back();
  }, [missing]);
  if (missing) return null;
  const { percent, tokens } = contextSummary(usage);
  const hint = contextHint(percent);
  const canCompact = Boolean(chat) && providerCapabilities(chat?.provider ?? "claude").compact;
  const blocked = run ? "Wait for the agent to finish." : null;
  return (
    <View style={{ paddingTop: 28, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 4, gap: 16 }}>
      <Text accessibilityRole="header" style={styles.subtitle}>
        Context
      </Text>
      <View style={{ gap: 7 }}>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Context usage"
          accessibilityValue={{ min: 0, max: 100, now: percent, text: `${percent}% used, ${tokens}` }}
          style={{ height: 5, borderRadius: 3, overflow: "hidden", backgroundColor: colors.lineStrong }}
        >
          <View style={{ width: `${percent}%`, height: "100%", borderRadius: 3, backgroundColor: colors.ink }} />
        </View>
        <View style={[styles.row, { justifyContent: "space-between", gap: 4 }]}>
          <Text selectable style={{ color: colors.ink, fontSize: 14, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
            {percent}% used
          </Text>
          <Text selectable style={{ color: colors.ink2, fontSize: 14, fontVariant: ["tabular-nums"] }}>
            {tokens}
          </Text>
        </View>
      </View>
      {hint && <Text style={styles.muted}>{hint}</Text>}
      {canCompact && chatId && (
        <View style={{ gap: 8 }}>
          <PillButton
            title="Compact now"
            disabled={Boolean(blocked)}
            onPress={() => {
              composer.requestCompact(chatId);
              router.back();
            }}
          />
          {blocked && (
            <Text accessibilityLiveRegion="polite" style={[styles.muted, { textAlign: "center", fontSize: 13 }]}>
              {blocked}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
