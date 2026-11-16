import { useState } from "react";
import { Text, TextInput, View, type LayoutRectangle } from "react-native";
import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Mascot, type MascotMood } from "./mascot";
import { useTheme } from "./theme";
import { OrchestratorAttachButton, OrchestratorImageStrip, useOrchestratorImages, type OrchestratorImage } from "./orchestrator-images";
import { IconButton, InlineError } from "./ui";

/** Pebble and the one box: what you type goes to `onSend`, and Pebble's eyes follow the text as it grows. */
export function OrchestratorPrompt({
  color,
  mood,
  busy,
  onSend,
  onBoxLayout,
}: {
  color: string;
  mood: MascotMood;
  busy: boolean;
  onSend: (prompt: string, images: OrchestratorImage[]) => Promise<boolean>;
  onBoxLayout?: (frame: LayoutRectangle) => void;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const attached = useOrchestratorImages();
  const empty = !text.trim() && !attached.items.length;
  const gaze = focused ? { x: Math.min(1, -0.2 + text.length / 48), y: 0.6 } : null;
  const send = () => {
    if (empty || busy) return;
    const kept = attached.items;
    void onSend(text.trim(), attached.images()).then((sent) => {
      if (!sent) attached.restore(kept);
    });
    setText("");
    attached.clear();
  };
  return (
    <View style={{ gap: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
        <Mascot size={48} color={color} mood={mood} gaze={gaze} live />
        <Text accessibilityRole="header" style={{ flex: 1, color: colors.ink, fontSize: type.title2, lineHeight: lineHeight.title2, fontWeight: "600" }}>
          What should we work on?
        </Text>
      </View>
      <View
        onLayout={(event) => onBoxLayout?.(event.nativeEvent.layout)}
        style={{
          backgroundColor: colors.surface,
          borderRadius: radius.composer,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.lineStrong,
          paddingTop: space.lg,
          paddingBottom: space.md,
          paddingLeft: space.xl,
          paddingRight: space.md,
          gap: space.xs,
        }}
      >
        <TextInput
          accessibilityLabel="What should we work on?"
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          multiline
          placeholder="Ask for anything, in any Project…"
          placeholderTextColor={colors.ink3}
          selectionColor={colors.accent}
          submitBehavior="submit"
          returnKeyType="send"
          onSubmitEditing={send}
          style={{ minHeight: 44, maxHeight: 160, color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, paddingRight: space.md }}
        />
        <OrchestratorImageStrip items={attached.items} disabled={busy} onRemove={attached.remove} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <OrchestratorAttachButton disabled={busy} onAttach={(kind) => void attached.attach(kind)} />
          <IconButton label="Send" icon={ArrowUp01Icon} filled size={36} loading={busy} disabled={empty} onPress={send} />
        </View>
      </View>
      {attached.error ? <InlineError message={attached.error} /> : null}
    </View>
  );
}
