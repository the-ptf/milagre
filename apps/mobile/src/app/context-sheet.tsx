import { ContextBar } from "../context-bar";
import { useContextSettings } from "../context-settings";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { contextSummary } from "@milagre/shared/usage";
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
  const { settings } = useContextSettings();
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
  const canCompact = Boolean(chat) && providerCapabilities(chat?.provider ?? "claude").compact;
  const blocked = Boolean(session.error) || Boolean(chat?.archived);
  return (
    <View style={{ paddingTop: 28, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 4, gap: 16 }}>
      <Text selectable style={{ color: colors.ink2, fontSize: 13, fontVariant: ["tabular-nums"] }}>
        {tokens}
      </Text>
      <ContextBar percent={percent} settings={settings} />
      {canCompact && chatId && (
        <View style={{ gap: 8 }}>
          <PillButton
            tone="orange"
            title={run ? "Compact after turn" : "Compact now"}
            disabled={Boolean(blocked)}
            onPress={() => {
              composer.requestCompact(chatId);
              router.back();
            }}
          />
          {blocked && (
            <Text accessibilityLiveRegion="polite" style={[styles.muted, { textAlign: "center", fontSize: 13 }]}>
              Chat unavailable.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
