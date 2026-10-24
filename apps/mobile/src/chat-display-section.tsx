import { Text, View } from "react-native";
import {
  CHAT_LIST_HINT,
  CHAT_LIST_MODES,
  CHAT_LIST_TITLE,
  DETAIL_LEVEL_TITLE,
  EXPAND_REASONING_HINT,
  EXPAND_REASONING_TITLE,
  TOOL_CALL_DISPLAYS,
  TOOL_CALL_DISPLAY_HINT,
  TOOL_CALL_DISPLAY_TITLE,
  type ChatList,
  type ToolCallDisplay,
} from "@milagre/shared/chat-display";
import { CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { useChatList, useExpandReasoning, useToolCallDisplay } from "./chat-display-setting";
import { saveChatRowShow, useChatRowShow } from "./chat-row-store";
import { Segmented, Toggle, useStyles } from "./ui";

// What a Chat row can show under its title; the computer is always on the phone's rows.
const ROW_FIELDS = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer");

/** Settings › Chat: desktop's Chat page, kept on this phone. */
export function ChatDisplaySection() {
  const styles = useStyles();
  const [expandReasoning, setExpandReasoning] = useExpandReasoning();
  const [toolCallDisplay, setToolCallDisplay] = useToolCallDisplay();
  const chosen = TOOL_CALL_DISPLAYS.find((display) => display.id === toolCallDisplay);
  const [chatList, setChatList] = useChatList();
  const rowShow = useChatRowShow();
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>{CHAT_LIST_TITLE}</Text>
      <View style={[styles.card, { gap: 8 }]}>
        <Segmented
          label={CHAT_LIST_TITLE}
          value={chatList}
          options={CHAT_LIST_MODES.map((mode) => ({ value: mode.id, title: mode.label }))}
          onChange={(value) => setChatList(value as ChatList)}
        />
        <Text style={styles.caption}>
          {CHAT_LIST_HINT} {CHAT_LIST_MODES.find((mode) => mode.id === chatList)?.description}
        </Text>
      </View>
      <Text style={styles.section}>Rows show</Text>
      <View style={[styles.card, { gap: 4 }]}>
        {ROW_FIELDS.map((field) => (
          <Toggle
            key={field.id}
            title={field.label}
            selected={rowShow[field.id]}
            onPress={() => saveChatRowShow({ ...rowShow, [field.id]: !rowShow[field.id] })}
          />
        ))}
        <Text style={styles.caption}>What each Chat in the sidebar shows besides its title.</Text>
      </View>
      <Text style={styles.section}>{DETAIL_LEVEL_TITLE}</Text>
      <View style={[styles.card, { gap: 4 }]}>
        <Toggle title={EXPAND_REASONING_TITLE} selected={expandReasoning} onPress={() => setExpandReasoning(!expandReasoning)} />
        <Text style={styles.caption}>{EXPAND_REASONING_HINT} Thinking opens in a reply&apos;s Activity.</Text>
      </View>
      <View style={[styles.card, { gap: 8 }]}>
        <Text style={styles.label}>{TOOL_CALL_DISPLAY_TITLE}</Text>
        <Segmented
          label={TOOL_CALL_DISPLAY_TITLE}
          value={toolCallDisplay}
          options={TOOL_CALL_DISPLAYS.map((display) => ({ value: display.id, title: display.label }))}
          onChange={(value) => setToolCallDisplay(value as ToolCallDisplay)}
        />
        <Text style={styles.caption}>
          {TOOL_CALL_DISPLAY_HINT} {chosen?.description}
        </Text>
      </View>
    </View>
  );
}
