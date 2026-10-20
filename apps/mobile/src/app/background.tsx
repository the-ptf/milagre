import { useState } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { BACKGROUND_ITEM_LABELS, backgroundItems, type BackgroundItem } from "@milagre/shared/chat-activity";
import type { Subagent } from "@milagre/shared/model";
import { useChatPorts } from "../ports";
import { useSession } from "../session";
import { WholeSubagentDetail } from "../subagent-glance";
import { TaskOutput } from "../task-output";
import { CircleButton, ListRow, PageScroll, useStyles } from "../ui";
import { useTheme } from "../theme";

/** The phone's counterpart to the expanded background line on desktop. */
export default function BackgroundSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const project = session.snapshot?.project;
  const chat = project?.state.sessions[Number(id)];
  const chatKey = `${project?.path}#${id}`;
  // A command serving one of the Chat's ports is in Ports instead.
  const { ports } = useChatPorts(project ? session.client : null, chatKey);
  const items = backgroundItems(chat, ports);
  const [selection, setSelected] = useState<(BackgroundItem & { chatKey: string }) | null>(null);
  const selected = selection?.chatKey === chatKey ? selection : null;
  const current = items.find((item) => item.type === selected?.type && item.id === selected.id);
  const child = current ?? (selected?.type === "command" ? selected : undefined);
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0, paddingBottom: 40 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
        <CircleButton
          label={child ? "Back to tasks" : "Close"}
          icon={child ? ArrowLeft01Icon : Cancel01Icon}
          onPress={() => (child ? setSelected(null) : router.back())}
        />
        <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 17, fontWeight: "600", textAlign: "center" }}>
          {child?.title ?? "Background tasks"}
        </Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 8 }}>
        {child && !current && <Text style={styles.muted}>No longer running</Text>}
        {child ? (
          child.agent ? (
            <WholeSubagentDetail
              agent={child.agent}
              read={() => session.client!.call("chat:subagent", [project!.path, Number(id), child.id]) as Promise<Subagent>}
            />
          ) : child.type === "command" ? (
            <TaskOutput key={`${chatKey}:${child.id}`} chatKey={chatKey} taskId={child.id} running={Boolean(current)} />
          ) : (
            <Text style={styles.muted}>This task reports its progress back to the Chat.</Text>
          )
        ) : (
          <>
            {!items.length && <Text style={styles.muted}>No background tasks running.</Text>}
            {items.map((item) => (
              <ListRow
                key={`${item.type}:${item.id}`}
                title={item.title}
                subtitle={`${BACKGROUND_ITEM_LABELS[item.type]} · Running`}
                onPress={() => setSelected({ ...item, chatKey })}
              />
            ))}
          </>
        )}
      </View>
    </PageScroll>
  );
}
