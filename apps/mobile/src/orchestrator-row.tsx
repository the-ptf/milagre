import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { needsYouLine, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon, SpinnerRing } from "./icons";
import { Mascot } from "./mascot";
import { useSession } from "./session";
import { promptText } from "./text-prompt";
import { useTheme } from "./theme";
import { ListRow, pressStyle } from "./ui";
import { useOrchestrator } from "./use-orchestrator";
import { columnItems } from "./orchestrator-board";
import { useOrchestratorBoard } from "./use-orchestrator-board";

const NO_TASKS: OrchestratorTask[] = [];
const TOWARD_YOU = { x: 0.6, y: 0 };

function openWaiting() {
  router.push("/orchestrator-waiting");
}

function Counts({ running, needs }: { running: number; needs: number }) {
  const { colors } = useTheme();
  const count = { fontSize: type.footnote, lineHeight: lineHeight.footnote, fontVariant: ["tabular-nums" as const] };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      {running > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <SpinnerRing size={12} />
          <Text style={[count, { color: colors.ink3 }]}>{running}</Text>
        </View>
      )}
      {needs > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Answer ${needs === 1 ? "the task that needs you" : `${needs} waiting tasks`}`}
          hitSlop={6}
          onPress={openWaiting}
          style={({ pressed }) => [
            { minHeight: 32, justifyContent: "center", paddingHorizontal: space.lg, borderRadius: radius.full, backgroundColor: colors.orangeTint },
            pressStyle({ pressed }),
          ]}
        >
          <Text style={{ color: colors.orangeInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
            {needs === 1 ? "Answer" : `${needs} waiting`}
          </Text>
        </Pressable>
      )}
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </View>
  );
}

function WaitingMascot({ name, color, needs }: { name: string; color: string; needs: number }) {
  const { colors } = useTheme();
  const mascot = <Mascot size={32} color={color} gaze={needs > 0 ? TOWARD_YOU : null} live={needs > 0} />;
  if (!needs) return mascot;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Answer what ${name} is asking`} onPress={openWaiting} hitSlop={8}>
      {mascot}
      <View
        style={{
          position: "absolute",
          left: 20,
          top: -9,
          minWidth: 18,
          height: 18,
          paddingHorizontal: space.xs,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.full,
          borderBottomLeftRadius: radius.chip,
          backgroundColor: colors.orange,
          borderWidth: 2,
          borderColor: colors.surface,
        }}
      >
        <Text
          maxFontSizeMultiplier={1.2}
          style={{ color: colors.onOrange, fontSize: type.caption2, lineHeight: lineHeight.caption2, fontWeight: "600", fontVariant: ["tabular-nums"] }}
        >
          {needs > 1 ? needs : "?"}
        </Text>
      </View>
    </Pressable>
  );
}

/** The pinned Orchestrator row atop the Chats list, shown while the connected computer has it on. */
export function OrchestratorRow({ onOpen }: { onOpen: () => void }) {
  const session = useSession();
  const { snapshot, store } = useOrchestrator(session.client);
  const enabled = !!snapshot?.settings.enabled;
  const { items, counts } = useOrchestratorBoard(enabled ? snapshot.tasks : NO_TASKS);
  if (!enabled) return null;
  const needs = needsYouLine(columnItems(items, "needs"));
  const subtitle = needs ?? (counts.running > 0 ? `${counts.running} running` : "Ask anything, I'll route it");
  return (
    <View style={{ paddingHorizontal: space.gutter }}>
      <ListRow
        title={snapshot.settings.name}
        subtitle={subtitle}
        subtitleLines={needs ? 2 : 1}
        onPress={onOpen}
        onLongPress={() =>
          void promptText("Rename", { value: snapshot.settings.name }).then((name) => {
            const next = name?.replace(/\s+/g, " ").trim();
            if (next && next !== snapshot.settings.name) void store?.saveSettings({ name: next }).catch(() => {});
          })
        }
        leading={<WaitingMascot name={snapshot.settings.name} color={snapshot.settings.mascotColor} needs={counts.needs} />}
        trailing={<Counts running={counts.running} needs={counts.needs} />}
      />
    </View>
  );
}
