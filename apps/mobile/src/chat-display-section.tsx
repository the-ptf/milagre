import { DoneRetention } from "./mac-settings-sections";
import { SNOOZE_DURATION_OPTIONS, snoozeDurationLabel } from "@milagre/shared/snooze";
import { useSnoozeMinutes } from "./snooze-setting";
import { Findable } from "./settings-find";
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
import { CheckRow, ListRow, Toggle, showActions, useStyles } from "./ui";
import { radius } from "./design-tokens";

// What a Chat row can show under its title; the computer is always on the phone's rows.
const ROW_FIELDS = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer");

/** Settings › Chat: desktop's Chat page, kept on this phone, plus the Mac's Done retention and this phone's Snooze for. Each choice shows a sketch of how it looks. */
export function ChatDisplaySection() {
  const styles = useStyles();
  const [expandReasoning, setExpandReasoning] = useExpandReasoning();
  const [toolCallDisplay, setToolCallDisplay] = useToolCallDisplay();
  const [chatList, setChatList] = useChatList();
  const rowShow = useChatRowShow();
  return (
    <View style={{ gap: 10 }}>
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
      <Text style={[styles.section, { marginTop: 14 }]}>Rows show</Text>
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
      <Text style={[styles.section, { marginTop: 14 }]}>Reasoning</Text>
      <ChoiceCards<"folded" | "expanded">
        label="Reasoning"
        value={expandReasoning ? "expanded" : "folded"}
        onChange={(value) => setExpandReasoning(value === "expanded")}
        options={[
          { value: "folded", title: "Folded", description: "Thinking stays in its row until you open it.", preview: <FoldedReasoningPreview /> },
          { value: "expanded", title: "Expanded", description: "Thinking shows open above each answer.", preview: <ExpandedReasoningPreview /> },
        ]}
      />
      <Text style={[styles.section, { marginTop: 14 }]}>Tool calls</Text>
      <ChoiceCards<ToolCallDisplay>
        label="Tool calls"
        value={toolCallDisplay}
        onChange={setToolCallDisplay}
        options={[
          { value: "compact", title: "Compact", description: "One line per reply.", preview: <CompactToolsPreview /> },
          { value: "full", title: "Full detail", description: "Each call on its own row.", preview: <FullToolsPreview /> },
        ]}
      />
      <SnoozeFor />
      <DoneRetention />
    </View>
  );
}

/** How long a row's "Snooze for" snoozes a Chat. Kept on this phone; the Snooze until choices stay in the row menu. */
function SnoozeFor() {
  const styles = useStyles();
  const [minutes, setMinutes] = useSnoozeMinutes();
  return (
    <>
      <Text style={[styles.section, { marginTop: 14 }]}>Snooze</Text>
      <Findable title="Snooze for">
        {/* One choice of five: a checkmark list, as iOS Settings picks one value. */}
        <View accessibilityRole="radiogroup" accessibilityLabel="Snooze for" style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
          {SNOOZE_DURATION_OPTIONS.map((option, index) => (
            <View key={option}>
              {index > 0 && <View style={styles.separator} />}
              <CheckRow title={snoozeDurationLabel(option)} checked={minutes === option} onPress={() => setMinutes(option)} />
            </View>
          ))}
        </View>
      </Findable>
      <Text style={styles.muted}>Snooze for, in a Chat&apos;s menu, snoozes it this long. A question, an approval or a failed turn wakes it sooner.</Text>
    </>
  );
}

/** Host-kept, like desktop's: a message sent while a turn runs steers it or waits in the queue. */
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
