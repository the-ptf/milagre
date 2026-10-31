import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { markdownPlainText } from "./plain-text";
import { PillButton } from "./ui";
import { useTheme } from "./theme";
import { tap } from "./primitives/tap";

/**
 * A long press selects a message in place. iOS Text only copies whole paragraphs, so selection uses a read-only native
 * text view in the same Chat row. Android already selects ranges in Text. Keep the formatted message, links and chips
 * until selection starts; Done restores them. Freeze the selection text so streaming cannot move its handles.
 *
 * The wrapper itself is not an accessibility element, so links and buttons inside the message stay focusable. The message's
 * text elements carry the VoiceOver action instead: children get `open` and spread `messageActionProps(open)` onto them.
 */
export function MessageActions({ text, markdown = false, children }: { text: string; markdown?: boolean; children: (open?: () => void) => React.ReactNode }) {
  const { colors, textPx } = useTheme();
  const [selectionText, setSelectionText] = useState<string | null>(null);
  // `open` keeps one identity for the life of the message, so it doesn't break the memo of the Markdown it is passed to
  // while a reply streams; the ref holds the text it should act on.
  const latest = useRef({ text, markdown });
  useEffect(() => {
    latest.current = { text, markdown };
  });
  const open = useCallback(() => {
    tap();
    const { text: current, markdown: isMarkdown } = latest.current;
    setSelectionText(isMarkdown ? markdownPlainText(current) : current);
  }, []);
  if (Platform.OS !== "ios" || !text.trim()) return children();
  if (selectionText !== null)
    return (
      <View style={{ gap: 8 }}>
        <TextInput
          value={selectionText}
          editable={false}
          multiline
          scrollEnabled={false}
          autoFocus
          selectTextOnFocus
          accessibilityLabel="Message text"
          selectionColor={colors.accent}
          style={{ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.4667), padding: 0, textAlignVertical: "top" }}
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PillButton title="Copy all" onPress={() => void Clipboard.setStringAsync(selectionText)} />
          <PillButton title="Done" onPress={() => setSelectionText(null)} />
        </View>
      </View>
    );
  return (
    <Pressable accessible={false} onLongPress={open} delayLongPress={350}>
      {/* oxlint-disable-next-line react/refs -- `open` reads the ref only when pressed, never during render */}
      {children(open)}
    </Pressable>
  );
}

/** The VoiceOver action for a message's text, which the non-accessible long-press wrapper can't carry. Empty without `open`. */
export function messageActionProps(open?: () => void) {
  if (!open) return {};
  return { accessibilityActions: [{ name: "longpress", label: "Select text" }], onAccessibilityAction: open };
}

/** Message text is selectable where the system can pick a range in it (Android); on iOS the long press above takes over. */
export const selectableMessageText = Platform.OS !== "ios";
