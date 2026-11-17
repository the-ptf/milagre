import { DoneRetention } from "./mac-settings-sections";
import { SnoozeSection } from "./snooze-settings-section";
import { useContextSettings } from "./context-settings";
import { FOLLOW_UP_OPTIONS, type FollowUps } from "@milagre/shared/queued-messages";
import { Text, View } from "react-native";
import { CHAT_LIST_TITLE, type ChatList, type ToolCallDisplay } from "@milagre/shared/chat-display";
import { CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { useChatList, useExpandReasoning, useToolCallDisplay } from "./chat-display-setting";
import { saveChatRowShow, useChatRowShow } from "./chat-row-store";
import {
  ByProjectPreview,
  ChoiceCards,
  CompactToolsPreview,
  ExpandedReasoningPreview,
  FoldedReasoningPreview,
  FullToolsPreview,
  OneListPreview,
  SampleChatRow,
  TreePreview,
} from "./chat-display-choices";
import { ListRow, Toggle, showActions, useStyles } from "./ui";
import { radius, space } from "./design-tokens";

const ROW_FIELDS = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer");

export function ChatDisplaySection() {
  const styles = useStyles();
  const [expandReasoning, setExpandReasoning] = useExpandReasoning();
  const [toolCallDisplay, setToolCallDisplay] = useToolCallDisplay();
  const [chatList, setChatList] = useChatList();
  const rowShow = useChatRowShow();
  return (
    <View style={{ gap: space.md }}>
      <FollowUpSetting />
      <Text style={styles.section}>{CHAT_LIST_TITLE}</Text>
      <ChoiceCards<ChatList>
        label={CHAT_LIST_TITLE}
        value={chatList}
        onChange={setChatList}
        options={[
          { value: "list", title: "One list", description: "Newest first, Project on each row.", preview: <OneListPreview /> },
          { value: "grouped", title: "By Project", description: "A group per Project that folds.", preview: <ByProjectPreview /> },
          {
            value: "tree",
            title: "Tree",
            description: "Each Project with its Worktrees, each Link with its Projects.",
            preview: <TreePreview />,
          },
        ]}
      />
      <Text style={[styles.section, { marginTop: space.xl }]}>Rows show</Text>
      <View style={[styles.card, { gap: 4 }]}>
        <SampleChatRow show={rowShow} />
        <View style={[styles.separator, { marginVertical: 8 }]} />
        {ROW_FIELDS.map((field) => (
          <Toggle
            key={field.id}
            title={field.label}
            selected={rowShow[field.id]}
            onPress={() => saveChatRowShow({ ...rowShow, [field.id]: !rowShow[field.id] })}
          />
        ))}
      </View>
      <Text style={[styles.section, { marginTop: space.xl }]}>Reasoning</Text>
      <ChoiceCards<"folded" | "expanded">
        label="Reasoning"
        value={expandReasoning ? "expanded" : "folded"}
        onChange={(value) => setExpandReasoning(value === "expanded")}
        options={[
          { value: "folded", title: "Folded", description: "Thinking stays in its row until you open it.", preview: <FoldedReasoningPreview /> },
          { value: "expanded", title: "Expanded", description: "Thinking shows open above each answer.", preview: <ExpandedReasoningPreview /> },
        ]}
      />
      <Text style={[styles.section, { marginTop: space.xl }]}>Tool calls</Text>
      <ChoiceCards<ToolCallDisplay>
        label="Tool calls"
        value={toolCallDisplay}
        onChange={setToolCallDisplay}
        options={[
          { value: "compact", title: "Compact", description: "One line per reply.", preview: <CompactToolsPreview /> },
          { value: "full", title: "Full detail", description: "Each call on its own row.", preview: <FullToolsPreview /> },
        ]}
      />
      <SnoozeSection />
      <DoneRetention />
    </View>
  );
}

function FollowUpSetting() {
  const styles = useStyles();
  const host = useContextSettings();
  const current = FOLLOW_UP_OPTIONS.find((option) => option.value === host.settings.followUps) ?? FOLLOW_UP_OPTIONS[0];
  const disabled = !host.ready || host.saving;
  return (
    <>
      <Text style={styles.section}>Messages during a turn</Text>
      <View style={[styles.card, { paddingVertical: 0, borderRadius: radius.card }]}>
        <ListRow
          inlineSubtitle
          title="While the agent works"
          subtitle={current.label}
          disabled={disabled}
          onPress={() =>
            showActions({
              title: "Messages during a turn",
              actions: FOLLOW_UP_OPTIONS.map((option) => ({
                id: option.value,
                title: option.value === current.value ? `${option.label} ✓` : option.label,
              })),
              onSelect: (value) => void host.save({ followUps: value as FollowUps }),
            })
          }
        />
      </View>
      <Text style={styles.muted}>{current.description}</Text>
      {host.error ? (
        <Text accessibilityRole="alert" style={styles.muted}>
          {host.error}
        </Text>
      ) : null}
    </>
  );
}
