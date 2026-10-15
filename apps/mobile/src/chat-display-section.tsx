import { Text, View } from "react-native";
import {
  DETAIL_LEVEL_TITLE,
  EXPAND_REASONING_HINT,
  EXPAND_REASONING_TITLE,
  TOOL_CALL_DISPLAYS,
  TOOL_CALL_DISPLAY_HINT,
  TOOL_CALL_DISPLAY_TITLE,
  type ToolCallDisplay,
} from "@milagre/shared/chat-display";
import { useExpandReasoning, useToolCallDisplay } from "./chat-display-setting";
import { Segmented, Toggle, useStyles } from "./ui";

/** Settings › Chat: desktop's Chat page, kept on this phone. */
export function ChatDisplaySection() {
  const styles = useStyles();
  const [expandReasoning, setExpandReasoning] = useExpandReasoning();
  const [toolCallDisplay, setToolCallDisplay] = useToolCallDisplay();
  const chosen = TOOL_CALL_DISPLAYS.find((display) => display.id === toolCallDisplay);
  return (
    <View style={{ gap: 8 }}>
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
