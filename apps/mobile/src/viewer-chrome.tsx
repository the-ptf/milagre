import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { CheckmarkCircle02Icon, Sent02Icon } from "@hugeicons/core-free-icons";
import type { ArtifactComment } from "@milagre/shared/artifact";
import { Icon, type IconData } from "./icons";
import { useTheme } from "./theme";
import { tap, useStyles } from "./ui";

// The full-screen viewers' chrome, the Designs canvas's and the Artifact page's: round header buttons, Send with the
// count waiting, and the comment box that opens from a pin.

/** A 34pt round header button, like the in-app browser's. `on` marks the squares while the whole board shows. */
export function RoundButton({ label, icon, onPress, on = false }: { label: string; icon: IconData; onPress?: () => void; on?: boolean }) {
  const { colors } = useTheme();
  const body = (
    <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.ink : colors.field }}>
      <Icon icon={icon} size={17} tone={on ? "page" : "ink"} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
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
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink }}>
        <Icon icon={Sent02Icon} size={17} tone="onInk" />
      </View>
      <View
        style={{
          position: "absolute",
          top: -5,
          right: -5,
          minWidth: 18,
          height: 18,
          paddingHorizontal: 4,
          borderRadius: 9,
          borderWidth: 2,
          borderColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.accent,
        }}
      >
        <Text style={{ color: colors.onAccent, fontSize: 10, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{count}</Text>
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
  return (
    <View
      accessibilityViewIsModal
      style={{
        position: "absolute",
        left: at.x,
        top: at.y,
        width: 272,
        padding: 12,
        gap: 10,
        borderRadius: 12,
        borderTopLeftRadius: 3,
        borderCurve: "continuous",
        borderWidth: 1.5,
        borderColor: colors.accent,
        backgroundColor: colors.surface,
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      {sentComment ? (
        <>
          <Text selectable style={{ color: colors.ink, fontSize: 15, lineHeight: 21 }}>
            {sentComment.text}
          </Text>
          {sentComment.resolved ? (
            <View style={{ flexDirection: "row", gap: 4, alignItems: "flex-start" }}>
              <Icon icon={CheckmarkCircle02Icon} tone="green" size={14} />
              <Text selectable style={{ flex: 1, color: colors.green, fontSize: 13 }}>
                {sentComment.resolved.note}
              </Text>
            </View>
          ) : (
            <Text style={{ color: colors.ink3, fontSize: 12 }}>Sent · waiting for the agent</Text>
          )}
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <SmallButton title="Close" onPress={onDone} />
          </View>
        </>
      ) : (
        <>
          <TextInput
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
            style={[styles.input, { maxHeight: 120, minHeight: 40 }]}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <SmallButton title={kind === "new" ? "Cancel" : "Delete"} onPress={onCancel} />
            <SmallButton title={kind === "new" ? "Add" : "Done"} primary disabled={kind === "new" && !text.trim()} onPress={onDone} />
          </View>
        </>
      )}
    </View>
  );
}

function SmallButton({ title, onPress, primary = false, disabled = false }: { title: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        height: 32,
        paddingHorizontal: 14,
        borderRadius: 16,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary ? colors.ink : colors.hover,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: primary ? colors.onInk : colors.ink, fontSize: 14, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}
