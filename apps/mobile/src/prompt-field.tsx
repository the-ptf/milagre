import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import Animated, { Easing, FadeInDown, ReduceMotion } from "react-native-reanimated";
import type { SkillCatalog } from "@milagre/shared/model";
import { promptSkillAtSelection, promptSkillParts, promptSkillQuery } from "@milagre/shared/prompt-skills";
import type { Client } from "./client";
import { useRpc } from "./use-rpc";
import { Field, ListRow, PageScroll } from "./ui";
import { useTheme } from "./theme";
import { useImagePaste } from "./use-image-paste";
import type { PastedImage } from "./attachment-picker";

const OPEN_SKILLS = FadeInDown.duration(140)
  .easing(Easing.bezier(0.23, 1, 0.32, 1))
  .withInitialValues({ opacity: 0, transform: [{ translateY: 6 }] })
  .reduceMotion(ReduceMotion.System);

/** Native attributed text keeps skill colors in the editable input, including wrapped/scrolled lines. */
export function PromptField({
  client,
  projectPath,
  draft,
  onChangeText,
  onImagePaste,
  placeholder = "Message the agent",
}: {
  client: Client;
  projectPath: string;
  draft: string;
  onChangeText: (value: string) => void;
  onImagePaste?: (image: PastedImage) => void;
  placeholder?: string;
}) {
  const { colors } = useTheme();
  const paste = useImagePaste(onImagePaste);
  const { data, loading, error, refresh } = useRpc<SkillCatalog>(projectPath ? client : null, "skills:list", [projectPath]);
  const skills = data?.skills;
  const parts = useMemo(
    () =>
      promptSkillParts(
        draft,
        (skills ?? []).map((skill) => skill.name),
      ),
    [draft, skills],
  );
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [requested, setRequested] = useState<{ draft: string; selection: typeof selection } | null>(null);
  const [rendered, setRendered] = useState({ draft, parts, restore: undefined as typeof selection | undefined });
  // Recoloring after the catalog loads must preserve a selected range. Ordinary edits keep native caret control.
  const changed = rendered.draft !== draft || rendered.parts !== parts;
  const restore = requested?.draft === draft ? requested.selection : changed ? (rendered.draft === draft ? selection : undefined) : rendered.restore;
  if (changed) setRendered({ draft, parts, restore });
  const name = focused ? promptSkillAtSelection(parts, selection) : null;
  const skill = name ? skills?.find((item) => item.name.toLowerCase() === name) : null;
  const query = focused
    ? promptSkillQuery(
        draft,
        selection,
        (skills ?? []).map((item) => item.name),
      )
    : null;
  const suggestions = query
    ? (skills ?? [])
        .filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.query))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(query.query)) - Number(a.name.toLowerCase().startsWith(query.query)))
    : [];
  const choose = (name: string) => {
    if (!query) return;
    const command = `/${name}`;
    const suffix = draft.slice(query.end);
    const [, punctuation, whitespace] = /^([.,!?;:()[\]{}]*)(\s?)/.exec(suffix)!;
    const gap = whitespace || " ";
    const next = `${draft.slice(0, query.start)}${command}${punctuation}${gap}${suffix.slice(punctuation.length + whitespace.length)}`;
    const caret = query.start + command.length + punctuation.length + gap.length;
    const selection = { start: caret, end: caret };
    setRequested({ draft: next, selection });
    setSelection(selection);
    onChangeText(next);
  };

  return (
    <View>
      {query ? (
        <Animated.View entering={OPEN_SKILLS}>
          <PageScroll
            accessibilityLabel="Skills"
            style={{ maxHeight: 180 }}
            contentContainerStyle={{ padding: 4, paddingBottom: 4, gap: 0 }}
            keyboardShouldPersistTaps="always"
          >
            {suggestions.map((item) => (
              <ListRow key={item.name} title={`/${item.name}`} subtitle={item.description} subtitleLines={3} onPress={() => choose(item.name)} />
            ))}
            {loading ? (
              <Text style={{ padding: 12, color: colors.ink2 }}>Loading skills...</Text>
            ) : error ? (
              <ListRow title="Could not load skills" subtitle="Tap to retry" onPress={refresh} />
            ) : !suggestions.length ? (
              <Text style={{ padding: 12, color: colors.ink2 }}>No matching skills</Text>
            ) : null}
          </PageScroll>
        </Animated.View>
      ) : null}
      {/* TextInput cannot receive value and attributed children together. The children mirror every accepted edit. */}
      <Field
        {...paste}
        label="Message"
        hideLabel
        placeholder={placeholder}
        multiline
        autoCorrect
        spellCheck
        autoCapitalize="sentences"
        onChangeText={(value) => {
          setRequested(null);
          onChangeText(value);
        }}
        onSelectionChange={(event) => {
          setSelection(event.nativeEvent.selection);
          setRequested(null);
          setRendered((current) => (current.restore ? { ...current, restore: undefined } : current));
        }}
        selection={restore}
        onFocus={() => {
          paste.onFocus();
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        style={{ backgroundColor: "transparent", minHeight: 44, maxHeight: 140, paddingHorizontal: 10, paddingVertical: 6 }}
      >
        <Text style={{ fontSize: 16, color: colors.ink }}>
          {parts.map((part, index) => (
            <Text key={index} style={{ color: part.skill ? colors.accentInk : colors.ink }}>
              {part.text}
            </Text>
          ))}
        </Text>
      </Field>
      {skill && !query ? (
        <View
          accessibilityLiveRegion="polite"
          style={{ marginHorizontal: 10, marginBottom: 6, padding: 10, borderRadius: 10, backgroundColor: colors.accentTint, gap: 4 }}
        >
          <Text style={{ color: colors.accentInk, fontSize: 13, fontWeight: "600" }}>/{skill.name}</Text>
          <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{skill.description}</Text>
        </View>
      ) : null}
    </View>
  );
}
