import { useCallback, useEffect, useRef } from "react";
import { Platform, Pressable } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { markdownPlainText } from "./plain-text";
import { setSelectableText } from "./select-text-store";
import { showActions } from "./ui";
import { tap } from "./primitives/tap";

/**
 * A long press on a message offers Copy and Select text. iOS copies a whole paragraph from selectable text and can't pick
 * a range in it, so Select text opens the message in a sheet where any part of it can be selected. Android selects ranges
 * in place, so its text stays selectable and this adds nothing there.
 *
 * The wrapper itself is not an accessibility element, so links and buttons inside the message stay focusable. The message's
 * text elements carry the VoiceOver action instead: children get `open` and spread `messageActionProps(open)` onto them.
 */
export function MessageActions({ text, markdown = false, children }: { text: string; markdown?: boolean; children: (open?: () => void) => React.ReactNode }) {
  // `open` keeps one identity for the life of the message, so it doesn't break the memo of the Markdown it is passed to
  // while a reply streams; the ref holds the text it should act on.
  const latest = useRef({ text, markdown });
  useEffect(() => {
    latest.current = { text, markdown };
  });
  const open = useCallback(() => {
    tap();
    showActions({
      title: "Message",
      actions: [
        { id: "copy", title: "Copy" },
        { id: "select", title: "Select text" },
      ],
      onSelect: (id) => {
        const { text: current, markdown: isMarkdown } = latest.current;
        if (id === "copy") void Clipboard.setStringAsync(current);
        if (id !== "select") return;
        setSelectableText(isMarkdown ? markdownPlainText(current) : current);
        router.push("/select-text");
      },
    });
  }, []);
  if (Platform.OS !== "ios" || !text.trim()) return children();
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
  return { accessibilityActions: [{ name: "longpress", label: "Copy or select text" }], onAccessibilityAction: open };
}

/** Message text is selectable where the system can pick a range in it (Android); on iOS the long press above takes over. */
export const selectableMessageText = Platform.OS !== "ios";
