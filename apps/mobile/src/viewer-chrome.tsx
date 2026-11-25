import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Text, View, useWindowDimensions, type TextInputInstance } from "react-native";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useCommentSendKey, useOnScreenReturn, useReturnKey } from "./hardware-keys";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { lineHeight, radius, type } from "./design-tokens";
import { Field, InlineError, PillButton } from "./ui";
import { CommentImageStrip, useCommentPaste } from "./comment-images";
import { useImagePaste } from "./use-image-paste";
import type { Attachment } from "./attachments";

export function CommentBox({
  at,
  kind,
  note,
  sentComment,
  number,
  onChange,
  onCancel,
  onDone,
  onSend,
  onPhotos,
  room,
}: {
  at: { x: number; y: number };
  kind: "new" | "edit" | "read";
  note?: { text: string; photos?: Attachment[] };
  sentComment?: { text: string; resolved?: { note: string } };
  number: number;
  onChange: (text: string) => void;
  onCancel: () => void;
  onDone: () => void;
  onSend: () => void;
  onPhotos?: (photos: Attachment[]) => void;
  room?: { width: number; height: number };
}) {
  const { colors } = useTheme();
  const [text, setText] = useState(note?.text ?? "");
  // A web page the comment was held on can keep the keyboard focus past autoFocus (WebKit's text interaction takes it
  const input = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(false);
  const photos = note?.photos ?? [];
  const pasted = useCommentPaste(photos, onPhotos);
  const paste = useImagePaste(pasted.onPaste && ((image) => void pasted.onPaste?.(image)), input);
  const keep = () => onDone();
  const enter = useReturnKey(input, sentComment ? undefined : keep);
  const onScreen = useOnScreenReturn(sentComment ? undefined : keep);
  useCommentSendKey(focused && !sentComment, () => {
    if (text.trim() || photos.length) onSend();
  });
  const window = useWindowDimensions();
  const bounds = room ?? window;
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const [height, setHeight] = useState(180);
  const surface = useRef<ComponentRef<typeof View>>(null);
  const [originY, setOriginY] = useState(0);
  const width = Math.min(272, bounds.width - 24);
  // Keep the bubble beside its pin, moving it only enough to clear an edge or the keyboard.
  const left = Math.max(12, Math.min(at.x, bounds.width - width - 12));
  const availableHeight = Math.min(bounds.height, window.height - keyboard - originY);
  const top = Math.max(8, Math.min(at.y, availableHeight - height - 12));
  // Sheets can already shrink above the keyboard. Measure their origin instead of subtracting the keyboard twice.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      surface.current?.measureInWindow((_x, y) => setOriginY(y - top));
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboard, bounds.height, bounds.width, top]);
  useEffect(() => {
    if (sentComment) return;
    const timer = setTimeout(() => {
      if (!input.current?.isFocused()) input.current?.focus();
    }, 350);
    return () => clearTimeout(timer);
  }, [sentComment]);
  return (
    <View
      ref={surface}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      accessibilityViewIsModal
      onAccessibilityEscape={onDone}
      style={{
        position: "absolute",
        left,
        top,
        width,
        padding: 12,
        gap: 12,
        borderRadius: radius.card,
        // oxlint-disable-next-line milagre-design/radius-token -- the comment bubble's tail corner: a small point, not a surface radius
        borderTopLeftRadius: 3,
        borderCurve: "continuous",
        borderWidth: 1.5,
        borderColor: colors.accent,
        backgroundColor: colors.surface,
        boxShadow: colors.shadowRaised,
      }}
    >
      {sentComment ? (
        <>
          <Text selectable style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
            {sentComment.text}
          </Text>
          {sentComment.resolved ? (
            <View style={{ flexDirection: "row", gap: 4, alignItems: "flex-start" }}>
              <Icon icon={CheckmarkCircle02Icon} tone="green" size={16} />
              <Text selectable style={{ flex: 1, color: colors.greenInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
                {sentComment.resolved.note}
              </Text>
            </View>
          ) : (
            <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>Sent · waiting for the agent</Text>
          )}
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <PillButton size="small" secondary title="Close" onPress={onDone} />
          </View>
        </>
      ) : (
        <>
          <Field
            ref={input}
            label={`Comment ${number}`}
            hideLabel
            autoCapitalize="sentences"
            autoCorrect
            autoFocus
            bare
            onLayout={() => {
              enter.attach();
              paste.onLayout();
            }}
            onFocus={() => {
              setFocused(true);
              enter.attach();
              paste.onFocus();
            }}
            onBlur={() => setFocused(false)}
            {...onScreen}
            returnKeyType="done"
            multiline
            defaultValue={note?.text ?? ""}
            onChangeText={(value) => {
              setText(value);
              onChange(value);
            }}
            placeholder="What should change here?"
            style={{ maxHeight: 120 }}
          />
          {onPhotos && <CommentImageStrip photos={photos} onRemove={(id) => onPhotos(photos.filter((photo) => photo.id !== id))} />}
          <InlineError message={pasted.error} />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            {kind === "new" ? (
              <PillButton size="small" variant="plain" muted title="Cancel" onPress={onCancel} />
            ) : (
              <PillButton size="small" variant="plain" destructive title="Delete" onPress={onCancel} />
            )}
            <PillButton size="small" title={kind === "new" ? "Add" : "Done"} disabled={kind === "new" && !text.trim() && !photos.length} onPress={onDone} />
          </View>
        </>
      )}
    </View>
  );
}
