import { useEffect, useMemo, useRef, useState } from "react";
import * as Font from "expo-font";
import { Linking, Pressable, Text, View } from "react-native";
import Animated, { Easing, FadeInDown, ReduceMotion } from "react-native-reanimated";
import type { SkillCatalog } from "@milagre/shared/model";
import { formatFileMention, promptParts } from "@milagre/shared/prompt-parts";
import { editImageMentions } from "@milagre/shared/prompt-mentions";
import { withAlpha } from "@milagre/shared/themes";
import { fileKind } from "@milagre/shared/file-kinds";
import { promptSkillAtSelection, promptSkillParts, promptSkillQuery } from "@milagre/shared/prompt-skills";
import type { Client } from "./client";
import { fileQueryAt, isOldMacError, mentionPaths, type KnownFiles } from "./file-mentions";
import { useRpc } from "./use-rpc";
import { Field, ListRow, PageScroll } from "./ui";
import { useTheme } from "./theme";
import { useImagePaste } from "./use-image-paste";
import { useReturnKey } from "./hardware-keys";
import type { PastedImage } from "./attachment-picker";
import { insertDictation } from "./voice-dictation";
import { useVoiceDictation } from "./voice-dictation-hook";
import { VoiceMicButton } from "./voice-mic-button";

const OLD_MAC_ROW = "Update Milagre on your Mac to mention files.";
// Desktop's chip icons as glyphs (scripts/build-chip-glyphs.py): a mention's first character draws its icon and `]` draws
// nothing, so `[Image #1]` reads as an image chip in a field that can only style its own characters. Loaded at runtime,
// so it ships over the air.
const GLYPHS = "MilagreChipGlyphs";
const GLYPH_FONT = { [GLYPHS]: require("../assets/fonts/MilagreChipGlyphs.ttf") };
const IMAGE_ICON = "#26a69a";
// The mic sits over the field's trailing edge; the text stops short of it.
const MIC_WIDTH = 34;
const ERROR_SECONDS = 8;

function useChipGlyphs() {
  const [ready, setReady] = useState(() => Font.isLoaded(GLYPHS));
  useEffect(() => {
    if (ready) return;
    let live = true;
    Font.loadAsync(GLYPH_FONT)
      .then(() => live && setReady(true))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/** A lookup answer versions the mutable known-file cache without changing the draft or its selection. */
function readMarks(draft: string, options: Parameters<typeof promptParts>[1], lookups: number) {
  return { lookups, parts: promptParts(draft, options) };
}

const openSkills = (scale: number) =>
  scale <= 0
    ? undefined
    : FadeInDown.duration(Math.round(140 * scale))
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
  commands,
  known,
  images = 0,
  onMention,
  onSubmit,
  onFocus,
  placeholder = "Message the agent",
}: {
  client: Client;
  projectPath: string;
  draft: string;
  onChangeText: (value: string) => void;
  onImagePaste?: (image: PastedImage) => void;
  /** Milagre's own slash commands, offered with the skills: `/undo` in a saved Chat. */
  commands?: { name: string; description: string }[];
  /** Which typed `@path`s name a Project file (asked of the Mac as they are typed): those are tinted like skills. */
  known?: KnownFiles;
  /** Number of attached images, so `[Image #N]` tokens tint inline like file mentions. */
  images?: number;
  /** Called with a picked file's path relative to the Project; the screen attaches it. */
  onMention?: (path: string) => void;
  /** Return on a hardware keyboard; Shift+Return and the on-screen keyboard still add a line. */
  onSubmit?: () => void;
  /** The field took the keyboard (an iPad split gives the keyboard to this pane). */
  onFocus?: () => void;
  placeholder?: string;
}) {
  const { colors, motionScale, typeScale } = useTheme();
  // Text size scales the composer too; 16 stays 16 at the default step.
  const inputSize = Math.round(16 * typeScale);
  // The menus sit inside the translucent glass composer; an opaque surface keeps the transcript from showing through the rows.
  const menuStyle = { maxHeight: 180, backgroundColor: colors.surface, borderRadius: 14, borderCurve: "continuous" as const };
  const paste = useImagePaste(onImagePaste);
  const enter = useReturnKey(paste.ref, onSubmit);
  const glyphs = useChipGlyphs();
  const { data, loading, error, refresh } = useRpc<SkillCatalog>(projectPath ? client : null, "skills:list", [projectPath]);
  const skillList = data?.skills;
  const skills = useMemo(() => (commands?.length ? [...commands, ...(skillList ?? [])] : skillList), [commands, skillList]);
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
  const typing = onMention && focused ? fileQueryAt(draft, selection.start)?.query : undefined;
  const lookups = useMentionLookups(client, projectPath, draft, known, typing);
  const { parts: marks } = useMemo(
    () => readMarks(draft, { skills: (skills ?? []).map((item) => item.name), files: (path) => !!known?.has(projectPath, path), images }, lookups),
    [draft, skills, known, projectPath, lookups, images],
  );
  const [requested, setRequested] = useState<{ draft: string; selection: typeof selection } | null>(null);
  // Until the field has reported a caret, `selection` is the initial 0 and says nothing about where the user means to dictate.
  const placed = useRef(false);
  const dictation = useVoiceDictation((text, anchor) => {
    const edit = insertDictation(draft, anchor.selection, text);
    if (!edit) return;
    const caret = { start: edit.caret, end: edit.caret };
    setRequested({ draft: edit.value, selection: caret });
    setSelection(caret);
    onChangeText(edit.value);
  });
  const { error: dictationError, dismiss: dismissDictationError } = dictation;
  useEffect(() => {
    // A permission refusal stays until the user acts on it; the other messages clear themselves.
    if (!dictationError || dictationError.kind === "permission") return;
    const timer = setTimeout(dismissDictationError, ERROR_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [dictationError, dismissDictationError]);
  const [rendered, setRendered] = useState({ draft, parts: marks, restore: undefined as typeof selection | undefined });
  // Recoloring after the catalog loads must preserve a selected range. Ordinary edits keep native caret control.
  const changed = rendered.draft !== draft || rendered.parts !== marks;
  const restore = requested?.draft === draft ? requested.selection : changed ? (rendered.draft === draft ? selection : undefined) : rendered.restore;
  if (changed) setRendered({ draft, parts: marks, restore });
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
  const fileToken = focused && onMention && !query ? fileQueryAt(draft, selection.start) : null;
  const files = useFileSearch(client, projectPath, fileToken?.query ?? null);
  const chooseFile = (path: string) => {
    if (!fileToken) return;
    const mention = formatFileMention(path);
    const suffix = draft.slice(fileToken.end);
    const gap = suffix.startsWith(" ") ? "" : " ";
    const next = `${draft.slice(0, fileToken.start)}${mention}${gap}${suffix}`;
    const caret = fileToken.start + mention.length + 1;
    const selection = { start: caret, end: caret };
    setRequested({ draft: next, selection });
    setSelection(selection);
    onMention?.(path);
    onChangeText(next);
  };
  const choose = (name: string) => {
    if (!query) return;
    const command = `/${name}`;
    const suffix = draft.slice(query.end);
    const [, punctuation = "", whitespace = ""] = /^([.,!?;:()[\]{}]*)(\s?)/.exec(suffix) ?? [];
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
        <Animated.View entering={openSkills(motionScale)}>
          <PageScroll
            accessibilityLabel="Skills"
            style={menuStyle}
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
      {fileToken ? (
        <Animated.View entering={openSkills(motionScale)}>
          <PageScroll
            accessibilityLabel="Files"
            style={menuStyle}
            contentContainerStyle={{ padding: 4, paddingBottom: 4, gap: 0 }}
            keyboardShouldPersistTaps="always"
          >
            {files.items.map((path) => (
              <ListRow key={path} title={path.split("/").pop()!} subtitle={path} onPress={() => chooseFile(path)} />
            ))}
            {files.error ? (
              isOldMacError(files.error) ? (
                <ListRow title={OLD_MAC_ROW} onPress={files.retry} />
              ) : (
                <ListRow title="Could not load files" subtitle={`${files.error} Tap to retry`} onPress={files.retry} />
              )
            ) : files.loading && !files.items.length ? (
              <Text style={{ padding: 12, color: colors.ink2 }}>Loading files...</Text>
            ) : !files.items.length ? (
              <Text style={{ padding: 12, color: colors.ink2 }}>No matching files</Text>
            ) : null}
          </PageScroll>
        </Animated.View>
      ) : null}
      {/* TextInput cannot receive value and attributed children together. The children mirror every accepted edit. */}
      <View>
        <Field
          {...paste}
          onLayout={() => {
            paste.onLayout();
            enter.attach();
          }}
          label="Message"
          hideLabel
          placeholder={placeholder}
          multiline
          autoCorrect
          spellCheck
          autoCapitalize="sentences"
          onChangeText={(value) => {
            const edit = editImageMentions(draft, value, images, selection);
            const caret = edit.caret === null ? null : { start: edit.caret, end: edit.caret };
            setRequested(caret ? { draft: edit.value, selection: caret } : null);
            if (caret) setSelection(caret);
            onChangeText(edit.value);
          }}
          onSelectionChange={(event) => {
            placed.current = true;
            setSelection(event.nativeEvent.selection);
            setRequested(null);
            setRendered((current) => (current.restore ? { ...current, restore: undefined } : current));
          }}
          selection={restore}
          onFocus={() => {
            paste.onFocus();
            enter.attach();
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => setFocused(false)}
          style={{
            backgroundColor: "transparent",
            fontSize: inputSize,
            minHeight: 44,
            maxHeight: 140,
            paddingHorizontal: 10,
            paddingVertical: 6,
            ...(dictation.available ? { paddingRight: 10 + MIC_WIDTH } : null),
          }}
        >
          <Text style={{ fontSize: inputSize, color: colors.ink }}>
            {marks.map((part, index) =>
              part.kind === "text" ? (
                <Text key={index} style={{ color: colors.ink }}>
                  {part.text}
                </Text>
              ) : glyphs ? (
                // Like desktop's chips: skills tinted with a wand, files and images on the hover gray with their icon.
                <Text
                  key={index}
                  style={
                    part.kind === "skill"
                      ? { color: colors.accentInk, backgroundColor: colors.accentTint }
                      : { color: colors.ink, backgroundColor: colors.hover }
                  }
                >
                  <Text
                    style={{
                      fontFamily: GLYPHS,
                      color: part.kind === "image" ? IMAGE_ICON : part.kind === "file" ? fileKind(part.path).color : colors.accentInk,
                    }}
                  >
                    {part.text[0]}
                  </Text>
                  {part.kind === "image" ? (
                    <>
                      {part.text.slice(1, -1)}
                      <Text style={{ fontFamily: GLYPHS }}>{part.text.slice(-1)}</Text>
                    </>
                  ) : (
                    part.text.slice(1)
                  )}
                </Text>
              ) : (
                <Text
                  key={index}
                  style={{
                    color: colors.accentInk,
                    backgroundColor: part.kind === "file" || part.kind === "image" ? withAlpha(colors.accent, 0.14) : colors.accentTint,
                  }}
                >
                  {part.text}
                </Text>
              ),
            )}
          </Text>
        </Field>
        {dictation.available ? (
          <View style={{ position: "absolute", right: 4, bottom: 6 }}>
            <VoiceMicButton
              phase={dictation.phase}
              level={dictation.level}
              onPress={() => {
                if (dictation.phase === "recording") return void dictation.stop();
                // Where the words land is fixed now, while the caret is where the user left it.
                const end = draft.length;
                void dictation.start({ draft, selection: placed.current ? selection : { start: end, end } });
              }}
            />
          </View>
        ) : null}
      </View>
      {dictationError ? (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginHorizontal: 10, marginBottom: 6, padding: 10, borderRadius: 10, backgroundColor: colors.redTint, gap: 6 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dictationError.message}
            accessibilityHint="Dismisses the message"
            onPress={dismissDictationError}
          >
            <Text style={{ color: colors.red, fontSize: 13, lineHeight: 18 }}>{dictationError.message}</Text>
          </Pressable>
          {dictationError.kind === "permission" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Settings"
              hitSlop={6}
              onPress={() => {
                dismissDictationError();
                void Linking.openSettings();
              }}
            >
              <Text style={{ color: colors.red, fontSize: 13, fontWeight: "600" }}>Open Settings</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
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

/** Asks the Mac whether each typed `@path` is a Project file (~150 ms after typing stops, three at a time); the count changes as answers arrive. */
function useMentionLookups(client: Client, root: string, draft: string, known: KnownFiles | undefined, typing: string | undefined) {
  const [answers, setAnswers] = useState(0);
  useEffect(() => {
    if (!known || !root) return;
    const timer = setTimeout(() => {
      // The token under the caret is still being typed; it is looked up once the caret leaves it.
      for (const path of known.unchecked(
        root,
        mentionPaths(draft).filter((item) => item !== typing),
      ))
        void known.lookup(client, root, path).then(() => setAnswers((count) => count + 1));
    }, 150);
    return () => clearTimeout(timer);
  }, [client, root, draft, known, typing]);
  return answers;
}

/** Project files matching `query` (null: no search), kept while the next answer loads so the menu does not flash empty. */
function useFileSearch(client: Client, root: string, query: string | null) {
  const [state, setState] = useState({ items: [] as string[], error: "", loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (query === null || !root) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .call<string[]>("project:files", [root, query])
        .then((items) => !cancelled && setState({ items: items.slice(0, 40), error: "", loading: false }))
        .catch((error: Error) => !cancelled && setState({ items: [], error: error.message || "failed", loading: false }));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, root, query, revision]);
  return { ...state, retry: () => setRevision((value) => value + 1) };
}
