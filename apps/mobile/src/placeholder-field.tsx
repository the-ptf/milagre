import { useState } from "react";
import { Text, View } from "react-native";
import { insertPlaceholder, placeholderQuery } from "@milagre/shared/routine-prompt";
import { Field, ListRow } from "./ui";
import { useTheme } from "./theme";

type Selection = { start: number; end: number };

/**
 * A Routine's prompt. Typing `{{` lists the placeholders its trigger fills above the field, the way the composer lists
 * skills; a tap puts `{{name}}` in and the caret after it.
 */
export function PlaceholderField({
  value,
  onChangeText,
  placeholders,
  placeholder = "What the agent should do on each Run",
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholders: { name: string; example: string }[];
  placeholder?: string;
}) {
  const { colors } = useTheme();
  const [selection, setSelection] = useState<Selection>({ start: value.length, end: value.length });
  const [focused, setFocused] = useState(false);
  // The caret the field is asked to take after an insert; dropped again on the next edit or caret move.
  const [requested, setRequested] = useState<{ value: string; selection: Selection } | null>(null);
  const names = placeholders.map((item) => item.name);
  const query = focused && selection.start === selection.end ? placeholderQuery(value, selection.start, names) : null;
  const suggestions = query ? placeholders.filter((item) => query.matches.includes(item.name)) : [];
  const choose = (name: string) => {
    if (!query) return;
    const next = insertPlaceholder(value, query.start, selection.start, name);
    const caret = { start: next.caret, end: next.caret };
    setRequested({ value: next.text, selection: caret });
    setSelection(caret);
    onChangeText(next.text);
  };
  return (
    <View style={{ gap: 6 }}>
      {suggestions.length ? (
        <View
          accessibilityLabel="Placeholders"
          style={{
            backgroundColor: colors.surface,
            borderRadius: 16,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.line,
            paddingHorizontal: 14,
          }}
        >
          {suggestions.slice(0, 6).map((item) => (
            <ListRow key={item.name} compact title={`{{${item.name}}}`} subtitle={item.example} onPress={() => choose(item.name)} />
          ))}
        </View>
      ) : null}
      <View style={{ backgroundColor: colors.surface, borderRadius: 20, borderCurve: "continuous", borderWidth: 1, borderColor: colors.line, padding: 6 }}>
        <Field
          label="Prompt"
          hideLabel
          multiline
          autoCorrect
          spellCheck
          autoCapitalize="sentences"
          placeholder={placeholder}
          value={value}
          selection={requested?.value === value ? requested.selection : undefined}
          onChangeText={(text) => {
            setRequested(null);
            onChangeText(text);
          }}
          onSelectionChange={(event) => {
            setSelection(event.nativeEvent.selection);
            setRequested(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ backgroundColor: "transparent", minHeight: 96, maxHeight: 220, fontSize: 15, lineHeight: 21, textAlignVertical: "top" }}
        />
      </View>
      {focused && !query && names.length ? (
        <Text style={{ color: colors.ink3, fontSize: 12, paddingHorizontal: 4 }}>Type {"{{"} to add a placeholder.</Text>
      ) : null}
    </View>
  );
}
