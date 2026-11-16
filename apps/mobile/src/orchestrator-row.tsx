import { Text, View } from "react-native";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon, SpinnerRing } from "./icons";
import { Mascot } from "./mascot";
import { useSession } from "./session";
import { promptText } from "./text-prompt";
import { useTheme } from "./theme";
import { ListRow } from "./ui";
import { useOrchestrator } from "./use-orchestrator";
import { useOrchestratorBoard } from "./use-orchestrator-board";

const NO_TASKS: OrchestratorTask[] = [];

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
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} />
          <Text style={[count, { color: colors.orangeInk }]}>{needs}</Text>
        </View>
      )}
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </View>
  );
}

/** The pinned Orchestrator row atop the Chats list, shown while the connected computer has it on. */
export function OrchestratorRow({ onOpen }: { onOpen: () => void }) {
  const session = useSession();
  const { snapshot, store } = useOrchestrator(session.client);
  const enabled = !!snapshot?.settings.enabled;
  const { counts } = useOrchestratorBoard(enabled ? snapshot.tasks : NO_TASKS);
  if (!enabled) return null;
  const subtitle =
    counts.needs > 0
      ? `${counts.needs} need${counts.needs === 1 ? "s" : ""} you`
      : counts.running > 0
        ? `${counts.running} running`
        : "Ask anything, I'll route it";
  return (
    <View style={{ paddingHorizontal: space.gutter }}>
      <ListRow
        title={snapshot.settings.name}
        subtitle={subtitle}
        onPress={onOpen}
        onLongPress={() =>
          void promptText("Rename", { value: snapshot.settings.name }).then((name) => {
            const next = name?.replace(/\s+/g, " ").trim();
            if (next && next !== snapshot.settings.name) void store?.saveSettings({ name: next }).catch(() => {});
          })
        }
        leading={<Mascot size={32} color={snapshot.settings.mascotColor} />}
        trailing={<Counts running={counts.running} needs={counts.needs} />}
      />
    </View>
  );
}
