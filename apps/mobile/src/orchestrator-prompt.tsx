import { useState } from "react";
import { Text, TextInput, View, type LayoutRectangle } from "react-native";
import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { discardPastedImage } from "./attachment-picker";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Mascot, type MascotMood } from "./mascot";
import { useTheme } from "./theme";
import { OrchestratorAttachButton, OrchestratorImageStrip, useOrchestratorImages, type OrchestratorImage } from "./orchestrator-images";
import { IconButton, InlineError } from "./ui";
import { useImagePaste } from "./use-image-paste";

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
  const {
    ref: pasteRef,
    onLayout: attachPaste,
    onFocus: focusPaste,
  } = useImagePaste((image) => {
    if (busy) discardPastedImage(image);
    else void attached.attach(image);
  });
  const empty = !text.trim() && !attached.items.length;
  const gaze = focused ? { x: Math.min(1, -0.2 + text.length / 48), y: 0.6 } : null;
  const send = () => {
    if (empty || busy || attached.picking) return;
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
          padding: space.md,
          gap: space.xs,
        }}
      >
        <TextInput
          ref={pasteRef}
          onLayout={attachPaste}
          accessibilityLabel="What should we work on?"
          value={text}
          onChangeText={setText}
          onFocus={() => {
            focusPaste();
            setFocused(true);
          }}
          onBlur={() => setFocused(false)}
          multiline
          placeholder="Ask for anything, in any Project…"
          placeholderTextColor={colors.ink3}
          selectionColor={colors.accent}
          submitBehavior="submit"
          returnKeyType="send"
          onSubmitEditing={send}
          style={{
            minHeight: lineHeight.body + space.md,
            maxHeight: 160,
            paddingHorizontal: space.md,
            paddingVertical: space.xs,
            color: colors.ink,
            fontSize: type.body,
            lineHeight: lineHeight.body,
            textAlignVertical: "top",
          }}
        />
        <OrchestratorImageStrip items={attached.items} disabled={busy} onRemove={attached.remove} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingRight: space.xs }}>
          <OrchestratorAttachButton disabled={busy || attached.picking} onAttach={(kind) => void attached.attach(kind)} />
          <IconButton label="Send" icon={ArrowUp01Icon} filled size={36} loading={busy} disabled={empty || attached.picking} onPress={send} />
        </View>
      </View>
      {attached.error ? <InlineError message={attached.error} /> : null}
    </View>
  );
}
