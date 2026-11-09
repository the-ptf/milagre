import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CornerDownRightIcon } from "@hugeicons/core-free-icons";
import {
  escalationLine,
  suggestionOutcomeLine,
  waitingNote,
  type SubchatSuggestionContext,
  type SubchatSuggestionOutcomeContext,
  type SubchatWaitingContext,
} from "@milagre/shared/subchat-escalation";
import { hitSlopFor, lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { PillButton } from "./primitives/pill-button";
import { pressStyle } from "./ui";
import { useTheme } from "./theme";
import type { SubchatNote } from "./subchat-notes";

/** A grey line in the transcript, as a Delegation report's (subchat-marker.tsx): `↳` and a footnote, a link when it opens a Chat. */
function NoteLine({ text, label, onOpen, hint }: { text: string; label?: string; onOpen?: () => void; hint?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={onOpen ? "link" : "text"}
      accessibilityLabel={label ?? text}
      accessibilityHint={onOpen ? hint : undefined}
      disabled={!onOpen}
      onPress={onOpen}
      hitSlop={onOpen ? hitSlopFor(lineHeight.footnote) : undefined}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: space.xs }, pressStyle({ pressed })]}
    >
      <View style={{ height: lineHeight.footnote, justifyContent: "center" }}>
        <Icon icon={CornerDownRightIcon} color={colors.ink3} size={12} />
      </View>
      <Text style={{ flexShrink: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>{text}</Text>
    </Pressable>
  );
}

/** In the Subchat, right above its open question or approval: how long it has waited and who was told. */
export function SubchatWaitingNote({ note }: { note: SubchatWaitingContext }) {
  return <NoteLine text={waitingNote(note)} />;
}

/**
 * A suggested answer in the Chat above: whose question it is, the answer, and what to do with it. With an outcome the card
 * is one line that says what became of it (Dismiss removes the card and leaves nothing).
 */
function SuggestionCard({
  note,
  outcome,
  onSend,
  onOpen,
  onDismiss,
}: {
  note: SubchatSuggestionContext;
  outcome?: SubchatSuggestionOutcomeContext;
  onSend: (note: SubchatSuggestionContext) => Promise<unknown>;
  onOpen: (chatKey: string) => void;
  onDismiss: (id: string) => Promise<unknown>;
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (outcome) {
    const line = suggestionOutcomeLine(outcome);
    return line ? <NoteLine text={line} /> : null;
  }
  // One call at a time; Send answer refused (the question is gone) says so and leaves the buttons, which the outcome note replaces.
  const run = async (call: () => Promise<unknown>, refused?: string) => {
    setBusy(true);
    setError("");
    try {
      const accepted = await call();
      if (refused && !accepted) throw new Error(refused);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.line,
        borderRadius: radius.card,
        borderCurve: "continuous",
        padding: space.lg,
        gap: space.md,
      }}
    >
      <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{`${note.fromTitle} · ${note.question}`}</Text>
      <Text style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>
        {`Send "${note.answerLabel}" as your answer?`}
      </Text>
      <View style={{ flexDirection: "row", gap: space.md }}>
        <PillButton
          title="Send answer"
          disabled={busy}
          onPress={() => void run(() => onSend(note), "This question is no longer pending.")}
          style={{ flex: 1 }}
        />
        <PillButton title="Open Subchat" variant="tinted" disabled={busy} onPress={() => onOpen(note.from)} style={{ flex: 1 }} />
      </View>
      <PillButton
        title="Dismiss"
        variant="plain"
        muted
        disabled={busy}
        accessibilityLabel={`Dismiss the suggested answer from ${note.fromTitle}`}
        onPress={() => void run(() => onDismiss(note.id))}
        style={{ alignSelf: "center" }}
      />
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.redInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
          {error}
        </Text>
      )}
    </View>
  );
}

/**
 * One escalation note where it falls in the transcript. A note that draws nothing here (an outcome, an escalation a
 * suggestion repeats, the open request's waiting note) is left out by the caller (subchat-notes.ts `silent`).
 */
export function SubchatNoteView({
  note,
  outcomes,
  onOpenChat,
  onSend,
  onDismiss,
}: {
  note: SubchatNote;
  outcomes: ReadonlyMap<string, SubchatSuggestionOutcomeContext>;
  onOpenChat: (chatKey: string) => void;
  onSend: (note: SubchatSuggestionContext) => Promise<unknown>;
  onDismiss: (id: string) => Promise<unknown>;
}) {
  switch (note.kind) {
    case "subchat-escalation":
      return <NoteLine text={escalationLine(note)} hint="Opens that Subchat" onOpen={() => onOpenChat(note.from)} />;
    case "subchat-waiting":
      return <SubchatWaitingNote note={note} />;
    case "subchat-answered-by":
      return <NoteLine text={`Answered by ${note.parentTitle}`} label={`Answered by ${note.parentTitle}: ${note.label}`} />;
    case "subchat-suggestion":
      return <SuggestionCard note={note} outcome={outcomes.get(note.id)} onSend={onSend} onOpen={onOpenChat} onDismiss={onDismiss} />;
    case "subchat-suggestion-outcome":
      return null;
  }
}
