import { ContextSettingsSection } from "./context-settings-section";
import { Platform, Text, View } from "react-native";
import { DICTATION_LANGUAGES } from "@milagre/shared/dictation";
import { CHAT_LIST_TITLE, type ChatList, type ToolCallDisplay } from "@milagre/shared/chat-display";
import { CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { useChatList, useDictationLanguage, useExpandReasoning, useToolCallDisplay } from "./chat-display-setting";
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
} from "./chat-display-choices";
import { Toggle, useStyles } from "./ui";

// What a Chat row can show under its title; the computer is always on the phone's rows.
const ROW_FIELDS = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer");

/** Settings › Chat: desktop's Chat page, kept on this phone. Each choice shows a sketch of how it looks. */
export function ChatDisplaySection() {
  const styles = useStyles();
  const [expandReasoning, setExpandReasoning] = useExpandReasoning();
  const [toolCallDisplay, setToolCallDisplay] = useToolCallDisplay();
  const [chatList, setChatList] = useChatList();
  const rowShow = useChatRowShow();
  const [dictation, setDictation] = useDictationLanguage();
  return (
    <View style={{ gap: 10 }}>
      <ContextSettingsSection />
      <Text style={styles.section}>{CHAT_LIST_TITLE}</Text>
      <ChoiceCards<ChatList>
        label={CHAT_LIST_TITLE}
        value={chatList}
        onChange={setChatList}
        options={[
          { value: "list", title: "One list", description: "Newest first, Project on each row.", preview: <OneListPreview /> },
          { value: "grouped", title: "By Project", description: "A group per Project that folds.", preview: <ByProjectPreview /> },
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
      <Text style={[styles.section, { marginTop: 14 }]}>Dictation language</Text>
      <View style={[styles.card, { gap: 4 }]}>
        {DICTATION_LANGUAGES.map((language) => (
          <Toggle
            key={language.code}
            // iPhone dictation can't detect the language: "auto" is the phone's own.
            title={language.code === "auto" && Platform.OS === "ios" ? "Phone language" : language.name}
            selected={dictation === language.code}
            onPress={() => setDictation(language.code)}
          />
        ))}
      </View>
    </View>
  );
}
