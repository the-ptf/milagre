import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  processColor,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type ViewProps,
} from "react-native";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import * as Clipboard from "expo-clipboard";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { markdownPlainText } from "./plain-text";
import { markdownSelection, plainSelection, type SelectionParagraph } from "./selection-document";
import { PillButton } from "./ui";
import { fonts, useTheme } from "./theme";
import { tap } from "./primitives/tap";

export type QuoteFrom = "user" | "assistant";

export const MessageAskContext = createContext<((passage: string, from: QuoteFrom) => void) | null>(null);

type NativeSelectableTextProps = ViewProps & {
  paragraphs: SelectionParagraph[];
  look: {
    fontSize: number;
    lineHeight: number;
    codeSize: number;
    fontScale: number;
    codeFontFamily: string;
    ink: unknown;
    accent: unknown;
    codeBackground: unknown;
    selection: unknown;
  };
  start?: { x: number; y: number };
  askTitle: string;
  onContentHeight: (event: { nativeEvent: { height: number } }) => void;
  onAsk: (event: { nativeEvent: { text: string } }) => void;
  onEnd: () => void;
};
// Builds before 39 have no native selection view and keep the plain text selection below.
const NativeSelectableText =
  Platform.OS === "ios" && requireOptionalNativeModule("MilagreSelectableText")
    ? requireNativeViewManager<NativeSelectableTextProps>("MilagreSelectableText")
    : null;

export type SelectionSwap = (formatted: React.ReactNode) => React.ReactNode;

type Selection = { text: string; markdown: boolean; from: QuoteFrom; start?: { x: number; y: number } };

/**
 * A long press selects a message in place, as in the system's own apps: the word under the finger, with handles that run
 * across paragraphs, lists and code, and the edit menu with Quote (a chip in the composer), Copy, Select All and Look Up.
 * iOS Text only copies whole paragraphs, so the formatted text swaps for a native text view drawn the same way; it swaps
 * back when the selection goes. Android already selects ranges in Text. Selection freezes the text, so a streaming reply
 * cannot move its handles.
 *
 * Children get `open` and `swap`: they wrap the message's text in `swap(...)` (inside a bubble, only the text) and spread
 * `messageActionProps(open)` onto its text elements. The formatted text stays mounted under the selection, so its images
 * don't load again. The wrapper itself is not an accessibility element, so links and buttons inside the message stay
 * focusable; the text elements carry the VoiceOver action instead.
 */
export function MessageActions({
  text,
  markdown = false,
  from = "assistant",
  onEdit,
  children,
}: {
  text: string;
  markdown?: boolean;
  from?: QuoteFrom;
  /** The user's own typed message: an Edit message pill shows under it while it is selected. */
  onEdit?: () => void;
  children: (open: ((event?: GestureResponderEvent) => void) | undefined, swap: SelectionSwap) => React.ReactNode;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  // A tap on the pill also ends the native selection, in either order: pressing it in marks the edit to run on close.
  const editing = useRef(false);
  const latest = useRef({ text, markdown, from, onEdit });
  useEffect(() => {
    latest.current = { text, markdown, from, onEdit };
  });
  const open = useCallback((event?: GestureResponderEvent) => {
    tap();
    const { text: current, markdown: isMarkdown, from: author } = latest.current;
    const touch = event?.nativeEvent;
    setSelection({ text: current, markdown: isMarkdown, from: author, start: touch ? { x: touch.pageX, y: touch.pageY } : undefined });
  }, []);
  const close = useCallback(() => {
    setSelection(null);
    if (!editing.current) return;
    editing.current = false;
    latest.current.onEdit?.();
  }, []);
  if (Platform.OS !== "ios" || !text.trim()) return children(undefined, (formatted) => formatted);
  const swap: SelectionSwap = (formatted) => (
    <SelectionSlot selection={selection} onClose={close}>
      {formatted}
    </SelectionSlot>
  );
  return (
    <Pressable accessible={false} onLongPress={selection ? undefined : open} delayLongPress={350}>
      {/* oxlint-disable-next-line react/refs -- `open` reads the ref only when pressed, never during render */}
      {children(open, swap)}
      {selection && onEdit && (
        <PillButton
          title="Edit message"
          icon={PencilEdit02Icon}
          variant="secondary"
          style={{ alignSelf: "flex-end", marginTop: 8 }}
          onPressIn={() => (editing.current = true)}
          onPress={close}
        />
      )}
    </Pressable>
  );
}

function SelectionSlot({ selection, onClose, children }: { selection: Selection | null; onClose: () => void; children: React.ReactNode }) {
  const { colors, textPx, codeSize } = useTheme();
  const { fontScale } = useWindowDimensions();
  const ask = useContext(MessageAskContext);
  // The native view's height, for the selection it was measured for; a new selection measures again.
  const [measured, setMeasured] = useState<{ selection: Selection; height: number } | null>(null);
  const height = selection && measured?.selection === selection ? measured.height : null;
  const paragraphs = useMemo(() => (!selection ? [] : selection.markdown ? markdownSelection(selection.text) : plainSelection(selection.text)), [selection]);
  const look = useMemo(
    () => ({
      fontSize: textPx,
      lineHeight: Math.round(textPx * 1.4667),
      codeSize,
      fontScale,
      codeFontFamily: fonts.mono,
      ink: processColor(colors.ink),
      accent: processColor(colors.accent),
      codeBackground: processColor(colors.field),
      selection: processColor(colors.accent),
    }),
    [colors.ink, colors.accent, colors.field, textPx, codeSize, fontScale],
  );
  // The formatted text keeps its place, invisible, under the native view: the message never gets shorter, so a Chat
  // scrolled to its end doesn't move the text from under the finger. A taller native view (wrapped code) grows it.
  const native = selection && NativeSelectableText;
  const hidden = !selection ? undefined : native ? { opacity: 0 } : { display: "none" as const };
  return (
    <View style={native && height !== null ? { minHeight: height } : undefined}>
      <View
        style={hidden}
        pointerEvents={selection ? "none" : "auto"}
        accessibilityElementsHidden={!!selection}
        importantForAccessibility={selection ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {selection &&
        (NativeSelectableText ? (
          <NativeSelectableText
            style={height === null ? StyleSheet.absoluteFill : { position: "absolute", top: 0, left: 0, right: 0, height }}
            paragraphs={paragraphs}
            look={look}
            start={selection.start}
            askTitle={ask ? "Quote" : ""}
            onContentHeight={({ nativeEvent }) => setMeasured({ selection, height: nativeEvent.height })}
            onAsk={({ nativeEvent }) => ask?.(nativeEvent.text, selection.from)}
            onEnd={onClose}
          />
        ) : (
          <PlainSelection
            text={selection.markdown ? markdownPlainText(selection.text) : selection.text}
            onQuote={ask ? (passage) => ask(passage, selection.from) : undefined}
            onClose={onClose}
          />
        ))}
    </View>
  );
}

/**
 * Builds without the native view: the message as plain text in a read-only field, all of it selected. Quote takes the
 * range picked in it, or the whole message when nothing is.
 */
function PlainSelection({ text, onQuote, onClose }: { text: string; onQuote?: (passage: string) => void; onClose: () => void }) {
  const { colors, textPx } = useTheme();
  const [range, setRange] = useState({ start: 0, end: text.length });
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        value={text}
        editable={false}
        multiline
        scrollEnabled={false}
        autoFocus
        selectTextOnFocus
        accessibilityLabel="Message text"
        onSelectionChange={({ nativeEvent }) => setRange(nativeEvent.selection)}
        selectionColor={colors.accent}
        style={{ color: colors.ink, fontSize: textPx, lineHeight: Math.round(textPx * 1.4667), padding: 0, textAlignVertical: "top" }}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        {onQuote && (
          <PillButton
            title="Quote"
            onPress={() => {
              const picked = text.slice(Math.min(range.start, range.end), Math.max(range.start, range.end));
              onQuote(picked.trim() ? picked : text);
              onClose();
            }}
          />
        )}
        <PillButton title="Copy all" onPress={() => void Clipboard.setStringAsync(text)} />
        <PillButton title="Done" onPress={onClose} />
      </View>
    </View>
  );
}

export function messageActionProps(open?: () => void, onEdit?: () => void) {
  const actions = [...(open ? [{ name: "longpress", label: "Select text" }] : []), ...(onEdit ? [{ name: "edit", label: "Edit message" }] : [])];
  if (!actions.length) return {};
  return {
    accessibilityActions: actions,
    onAccessibilityAction: (event?: AccessibilityActionEvent) => (event?.nativeEvent.actionName === "edit" ? onEdit?.() : open?.()),
  };
}

/** Message text is selectable where the system can pick a range in it (Android); on iOS the long press above takes over. */
export const selectableMessageText = Platform.OS !== "ios";
