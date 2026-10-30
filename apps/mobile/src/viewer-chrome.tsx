import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View, type TextInputInstance } from "react-native";
import { CheckmarkCircle02Icon, Sent02Icon } from "@hugeicons/core-free-icons";
import type { ArtifactComment } from "@milagre/shared/artifact";
import { Icon, type IconData } from "./icons";
import { useTheme } from "./theme";
import { hitSlopFor, lineHeight, radius, type } from "./design-tokens";
import { PillButton, pressStyle, tap, useStyles } from "./ui";

// The full-screen viewers' chrome, the Designs canvas's and the Artifact page's: round header buttons, Send with the
// count waiting, and the comment box that opens from a pin.

/** A 34pt round header button, like the in-app browser's. `on` marks the squares while the whole board shows. */
export function RoundButton({ label, icon, onPress, on = false }: { label: string; icon: IconData; onPress?: () => void; on?: boolean }) {
  const { colors } = useTheme();
  const body = (
    <View
      style={{
        width: 34,
        height: 34,
        borderRadius: radius.full,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: on ? colors.ink : colors.field,
      }}
    >
      <Icon icon={icon} size={18} tone={on ? "onInk" : "ink"} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      hitSlop={hitSlopFor(34)}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => pressStyle({ pressed, filled: on })}
    >
      {body}
    </Pressable>
  );
}

/** Send, as an icon with the number of comments (and the choice) waiting. */
export function SendButton({ count, onPress }: { count: number; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Send ${count} to the agent`}
      hitSlop={hitSlopFor(34)}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => pressStyle({ pressed, filled: true })}
    >
      <View style={{ width: 34, height: 34, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink }}>
        <Icon icon={Sent02Icon} size={18} tone="onInk" />
      </View>
      <View
        style={{
          position: "absolute",
          top: -5,
          right: -5,
          minWidth: 18,
          height: 18,
          paddingHorizontal: 4,
          borderRadius: radius.full,
          borderWidth: 2,
          borderColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.ink,
        }}
      >
        <Text style={{ color: colors.onInk, fontSize: type.caption2, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{count}</Text>
      </View>
    </Pressable>
  );
}

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
  const styles = useStyles();
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
          <TextInput
            ref={input}
            // Uncontrolled to the parent: each keystroke updates the comment without writing the value back.
            accessibilityLabel={`Comment ${number}`}
            autoFocus
            multiline
            defaultValue={note?.text ?? ""}
            onChangeText={(value) => {
              setText(value);
              onChange(value);
            }}
            placeholder="What should change here?"
            placeholderTextColor={colors.ink3}
            selectionColor={colors.accent}
            style={[styles.input, { maxHeight: 120 }]}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <PillButton size="small" secondary title={kind === "new" ? "Cancel" : "Delete"} onPress={onCancel} />
            <PillButton size="small" title={kind === "new" ? "Add" : "Done"} disabled={kind === "new" && !text.trim()} onPress={onDone} />
          </View>
        </>
      )}
    </View>
  );
}
