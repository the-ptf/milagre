import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { currentPrompt } from "../text-prompt";
import { Field, PillButton, SheetBody, useStyles } from "../ui";

/**
 * A text question as a bottom sheet (Android; iOS asks with its own alert): the title, a field holding the current
 * value, then the action and Cancel. The answer goes back once the sheet has gone, as the confirmation sheet's does.
 */
export default function PromptSheet() {
  const styles = useStyles();
  const [entry] = useState(currentPrompt);
  const [text, setText] = useState(entry?.value ?? "");
  const answer = useRef<string | null>(null);
  useEffect(() => {
    if (!entry) {
      router.back();
      return;
    }
    return () => entry.answer(answer.current);
  }, [entry]);
  if (!entry) return null;
  const submit = () => {
    answer.current = text;
    router.back();
  };
  return (
    <SheetBody style={{ gap: 24 }}>
      <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={[styles.sheetTitle, { textAlign: "center" }]}>
          {entry.title}
        </Text>
        {entry.message ? <Text style={[styles.muted, { textAlign: "center" }]}>{entry.message}</Text> : null}
      </View>
      <Field
        label={entry.title}
        hideLabel
        value={text}
        onChangeText={setText}
        autoFocus
        selectTextOnFocus
        autoCapitalize={entry.plain ? "none" : "sentences"}
        autoCorrect={!entry.plain}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <View style={{ gap: 12 }}>
        <PillButton size="large" title={entry.action} variant="primary" onPress={submit} />
        <PillButton size="large" title="Cancel" variant="plain" muted onPress={() => router.back()} />
      </View>
    </SheetBody>
  );
}
