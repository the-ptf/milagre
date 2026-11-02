import { useEffect, useRef, useState } from "react";
import { Text, View, type TextInputInstance } from "react-native";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type { ArtifactComment } from "@milagre/shared/artifact";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { lineHeight, radius, type } from "./design-tokens";
import { Field, PillButton } from "./ui";

// The full-screen viewers' comment box, the Designs canvas's and the Artifact page's, that opens from a pin. Their header
// buttons are CircleButtons (Send is `filled badge={count}`).

/**
 * The comment on a pin, opened from its point as on desktop: the box's square corner sits where the pin pointed. A new
 * or waiting comment is written here; a sent one is read, with the agent's note once it resolved it.
 */
export function CommentBox({
  at,
  kind,
  note,
  sentComment,
  number,
  onChange,
  onCancel,
  onDone,
}: {
  at: { x: number; y: number };
  kind: "new" | "edit" | "read";
  note?: { text: string };
  sentComment?: ArtifactComment;
  number: number;
  onChange: (text: string) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState(note?.text ?? "");
  // A web page the comment was held on can keep the keyboard focus past autoFocus (WebKit's text interaction takes it
  // as the hold ends): the field asks again once the hold is over.
  const input = useRef<TextInputInstance>(null);
  useEffect(() => {
    if (sentComment) return;
    const timer = setTimeout(() => {
      if (!input.current?.isFocused()) input.current?.focus();
    }, 350);
    return () => clearTimeout(timer);
  }, [sentComment]);
  return (
    <View
      accessibilityViewIsModal
      // A new comment's escape cancels it; an existing one's closes it as it is (its Cancel button deletes).
      onAccessibilityEscape={kind === "new" && !sentComment ? onCancel : onDone}
      style={{
        position: "absolute",
        left: at.x,
        top: at.y,
        width: 272,
        padding: 12,
        gap: 12,
        borderRadius: radius.card,
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
            // Uncontrolled to the parent: each keystroke updates the comment without writing the value back.
            label={`Comment ${number}`}
            hideLabel
            autoCapitalize="sentences"
            autoCorrect
            autoFocus
            multiline
            defaultValue={note?.text ?? ""}
            onChangeText={(value) => {
              setText(value);
              onChange(value);
            }}
            placeholder="What should change here?"
            style={{ maxHeight: 120 }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            {kind === "new" ? (
              <PillButton size="small" variant="plain" muted title="Cancel" onPress={onCancel} />
            ) : (
              <PillButton size="small" variant="plain" destructive title="Delete" onPress={onCancel} />
            )}
            <PillButton size="small" title={kind === "new" ? "Add" : "Done"} disabled={kind === "new" && !text.trim()} onPress={onDone} />
          </View>
        </>
      )}
    </View>
  );
}
