import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import * as Font from "expo-font";
import { Linking, Pressable, Text, View } from "react-native";
import Animated, { Easing, FadeInDown, ReduceMotion } from "react-native-reanimated";
import type { SkillCatalog } from "@milagre/shared/model";
import { formatChatMention, formatFileMention, promptParts } from "@milagre/shared/prompt-parts";
import { matchingMentionChats, type MentionChat, editImageMentions } from "@milagre/shared/prompt-mentions";
import { withAlpha } from "@milagre/shared/themes";
import { fileKind } from "@milagre/shared/file-kinds";
import { promptSkillAtSelection, promptSkillParts, promptSkillQuery } from "@milagre/shared/prompt-skills";
import type { Client } from "./client";
import { fileQueryAt, isOldMacError, mentionPaths, type KnownFiles } from "./file-mentions";
import { useRpc } from "./use-rpc";
import { Field, ListRow, PageScroll } from "./ui";
import { useTheme } from "./theme";
import { useImagePaste } from "./use-image-paste";
import { useOnScreenReturn, useReturnKey } from "./hardware-keys";
import type { PastedImage } from "./attachment-picker";
import {
  NOTICE_SECONDS,
  provisionalRange,
  revertTake,
  splitProvisional,
  startTake,
  writeTake,
  type DictationTake,
  type Selection as TextRange,
} from "@milagre/shared/voice-dictation";
import { useVoiceDictation } from "./voice-dictation-hook";
import { useDictationAction } from "./chat-display-setting";
import { CAPSULE_INSET, CAPSULE_WIDTH, DictationCapsule, MIC_INSET, MIC_SIZE, VoiceMicButton } from "./voice-mic-button";
import { DictationNotice } from "./dictation-notice";

const NO_CHATS: readonly MentionChat[] = [];
const OLD_MAC_ROW = "Update Milagre on your Mac to mention files.";
// Desktop's chip icons as glyphs (scripts/build-chip-glyphs.py): a mention's first character draws its icon and `]` draws
// nothing, so `[Image #1]` reads as an image chip in a field that can only style its own characters. Loaded at runtime,
// so it ships over the air.
const GLYPHS = "MilagreChipGlyphs";
const GLYPH_FONT = { [GLYPHS]: require("../assets/fonts/MilagreChipGlyphs.ttf") };
const IMAGE_ICON = "#26a69a";
// The mic sits over the field's trailing edge; the text stops short of it, 8pt before the mic and 6pt before the capsule.
const MIC_ROOM = MIC_INSET.right + MIC_SIZE + 8;
const CAPSULE_ROOM = CAPSULE_INSET.right + CAPSULE_WIDTH + 6;

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
  chats = NO_CHATS,
  currentId,
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
  onBlur,
  placeholder = "Message the agent",
  suggestion,
  onAcceptSuggestion,
  chatTitle,
  provider,
}: {
  chats?: readonly MentionChat[];
  currentId?: number;
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
  /** The field gave the keyboard up. */
  onBlur?: () => void;
  placeholder?: string;
  suggestion?: string;
  onAcceptSuggestion?: (text: string) => void;
  /** The Chat's title and agent: dictation's fix-up asks that agent, with the title as context. */
  chatTitle?: string;
  provider?: string;
}) {
  const { colors, motionScale, typeScale } = useTheme();
  // Text size scales the composer too; 16 stays 16 at the default step.
  const inputSize = Math.round(16 * typeScale);
  // The menus sit inside the translucent glass composer; an opaque surface keeps the transcript from showing through the rows.
  const menuStyle = { maxHeight: 180, backgroundColor: colors.surface, borderRadius: 14, borderCurve: "continuous" as const };
  const paste = useImagePaste(onImagePaste);
  const enter = useReturnKey(paste.ref, onSubmit);
  const onScreenReturn = useOnScreenReturn(onSubmit);
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
  const [selection, setSelection] = useState({ start: draft.length, end: draft.length });
  const [focused, setFocused] = useState(false);
  const typing = (onMention || chats.length) && focused ? fileQueryAt(draft, selection.start)?.query : undefined;
  const lookups = useMentionLookups(client, projectPath, draft, known, typing);
  const { parts: marks } = useMemo(
    () =>
      readMarks(
        draft,
        {
          skills: (skills ?? []).map((item) => item.name),
          files: (path) => !!known?.has(projectPath, path),
          images,
          chats: (id) => chats.some((chat) => chat.id === id && chat.available),
        },
        lookups,
      ),
    [draft, skills, known, projectPath, lookups, images, chats],
  );
  const [requested, setRequested] = useState<{ draft: string; selection: typeof selection } | null>(null);
  // Until the field has reported a caret, dictation starts after the restored draft.
  const placed = useRef(false);
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);
  useFocusEffect(
    useCallback(() => {
      // Screens can stay mounted while another Chat is open. Restore once on return, never on a keystroke.
      const value = latestDraft.current;
      const end = { start: value.length, end: value.length };
      setSelection(end);
      setRequested({ draft: value, selection: end });
      placed.current = false;
    }, []),
  );
  const [dictationAction] = useDictationAction();
  const dictatedSend = useRef<{ value: string; projectPath: string; currentId: number | undefined } | null>(null);
  // Submit from the next render so the screen's send action reads the transcript and its normal availability checks.
  useEffect(() => {
    const pending = dictatedSend.current;
    if (!pending) return;
    dictatedSend.current = null;
    if (pending.value === draft && pending.projectPath === projectPath && pending.currentId === currentId && dictationAction === "send") onSubmit?.();
  });
  // The take's words live in the field itself, rewritten in place as the recognizer revises them.
  const take = useRef<DictationTake | null>(null);
  const [provisional, setProvisional] = useState<TextRange | null>(null);
  const write = (text: string, settled: number) => {
    const current = take.current;
    if (!current) return null;
    const written = writeTake(current, latestDraft.current, text, settled);
    if (!written) return null;
    take.current = written.take;
    setProvisional(provisionalRange(written.take));
    const caret = { start: written.caret, end: written.caret };
    setRequested({ draft: written.value, selection: caret });
    setSelection(caret);
    onChangeText(written.value);
    return written;
  };
  const writeLatest = useRef(write);
  const discardLatest = useRef<() => void>(() => {});
  const dictation = useVoiceDictation(
    (text, anchor) => {
      // The last words settle in place: the tint goes, nothing moves. A take that never opened lands at its anchor.
      take.current ??= startTake(latestDraft.current, anchor.selection);
      const written = writeLatest.current(text, text.length);
      take.current = null;
      setProvisional(null);
      if (written && dictationAction === "send") dictatedSend.current = { value: written.value, projectPath, currentId };
    },
    projectPath ? { client, cwd: projectPath, chatTitle, provider, chatId: currentId } : undefined,
  );
  const partialText = dictation.partial.text;
  const partialSettled = dictation.partial.settled;
  const discardDictation = () => {
    const current = take.current;
    void dictation.cancel();
    take.current = null;
    setProvisional(null);
    if (!current) return;
    const back = revertTake(current, latestDraft.current);
    setRequested({ draft: back.value, selection: back.selection });
    setSelection(back.selection);
    onChangeText(back.value);
  };
  const dictating = dictation.phase !== "idle";
  // While the model downloads the mic keeps its own size and place: the capsule only grows once the take records.
  const capsule = dictating && dictation.phase !== "downloading";
  useEffect(() => {
    writeLatest.current = write;
    discardLatest.current = discardDictation;
  });
  useEffect(() => {
    if (take.current && partialText) writeLatest.current(partialText, partialSettled);
  }, [partialText, partialSettled]);
  // A take that ended without delivering (the app lost the microphone, the recognizer failed) leaves no half transcript.
  useEffect(() => {
    if (!dictating && take.current) discardLatest.current();
  }, [dictating]);
  const { error: dictationError, dismiss: dismissDictationError } = dictation;
  useEffect(() => {
    // A permission refusal stays until the user acts on it; the other messages clear themselves (and on the next take).
    if (!dictationError || dictationError.kind === "permission") return;
    const timer = setTimeout(dismissDictationError, NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [dictationError, dismissDictationError]);
  const [rendered, setRendered] = useState({ draft, parts: marks, restore: selection as typeof selection | undefined });
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
  const fileToken = focused && (onMention || chats.length) && !query ? fileQueryAt(draft, selection.start) : null;
  const files = useFileSearch(client, projectPath, onMention ? (fileToken?.query ?? null) : null);
  const chatRows = fileToken ? matchingMentionChats(chats, fileToken.query, currentId) : [];
  const chooseMention = (mention: string, path?: string) => {
    if (!fileToken) return;
    const suffix = draft.slice(fileToken.end);
    const gap = suffix.startsWith(" ") ? "" : " ";
    const next = `${draft.slice(0, fileToken.start)}${mention}${gap}${suffix}`;
    const caret = fileToken.start + mention.length + 1;
    const selection = { start: caret, end: caret };
    setRequested({ draft: next, selection });
    setSelection(selection);
    if (path) onMention?.(path);
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
      {suggestion && !draft && !query && !fileToken && onAcceptSuggestion && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use suggested prompt: ${suggestion}`}
          accessibilityHint="Puts the suggestion in the message field without sending it"
          onPress={() => {
            const end = { start: suggestion.length, end: suggestion.length };
            setRequested({ draft: suggestion, selection: end });
            setSelection(end);
            onAcceptSuggestion(suggestion);
            paste.ref.current?.focus();
          }}
          style={({ pressed }) => ({
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 10,
            marginBottom: 4,
            borderRadius: 12,
            backgroundColor: pressed ? colors.hover : colors.surface,
          })}
        >
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: inputSize }}>
            {suggestion}
          </Text>
        </Pressable>
      )}
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
            accessibilityLabel="Files and Chats"
            style={menuStyle}
            contentContainerStyle={{ padding: 4, paddingBottom: 4, gap: 0 }}
            keyboardShouldPersistTaps="always"
          >
            {(onMention ? files.items : []).slice(0, chatRows.length ? 1 : 40).map((path) => (
              <ListRow key={path} title={path.split("/").pop()!} subtitle={path} onPress={() => chooseMention(formatFileMention(path), path)} />
            ))}
            {chatRows.length > 0 && <Text style={{ paddingHorizontal: 12, paddingVertical: 6, color: colors.ink2 }}>Chats</Text>}
            {chatRows.map((chat) => (
              <ListRow key={`chat:${chat.id}`} title={chat.title} subtitle={chat.branch} onPress={() => chooseMention(formatChatMention(chat.id))} />
            ))}
            {!onMention && !chatRows.length && <Text style={{ padding: 12, color: colors.ink2 }}>No matching Chats</Text>}
            {onMention &&
              (files.error ? (
                isOldMacError(files.error) ? (
                  <ListRow title={OLD_MAC_ROW} onPress={files.retry} />
                ) : (
                  <ListRow title="Could not load files" subtitle={`${files.error} Tap to retry`} onPress={files.retry} />
                )
              ) : files.loading && !files.items.length ? (
                <Text style={{ padding: 12, color: colors.ink2 }}>Loading files...</Text>
              ) : !files.items.length && !chatRows.length ? (
                <Text style={{ padding: 12, color: colors.ink2 }}>No matching files or Chats</Text>
              ) : null)}
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
          {...onScreenReturn}
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
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          style={{
            backgroundColor: "transparent",
            fontSize: inputSize,
            minHeight: 44,
            maxHeight: 140,
            paddingHorizontal: 10,
            paddingVertical: 6,
            ...(dictation.available ? { paddingRight: capsule ? CAPSULE_ROOM : MIC_ROOM } : null),
          }}
        >
          <Text style={{ fontSize: inputSize, color: colors.ink }}>
            {splitProvisional(marks, provisional).map(({ part, text, provisional: revising }, index) =>
              part.kind === "text" ? (
                // The dictated tail the recognizer may still rewrite: settled words are plain ink, like anything typed.
                <Text key={index} style={revising ? { color: colors.ink2, backgroundColor: colors.hover } : { color: colors.ink }}>
                  {text}
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
          <View
            style={{ position: "absolute", right: capsule ? CAPSULE_INSET.right : MIC_INSET.right, bottom: capsule ? CAPSULE_INSET.bottom : MIC_INSET.bottom }}
          >
            {dictationError ? (
              <DictationNotice
                error={dictationError}
                micSize={MIC_SIZE}
                onDismiss={dismissDictationError}
                onOpenSettings={() => {
                  dismissDictationError();
                  void Linking.openSettings();
                }}
              />
            ) : null}
            {dictating ? (
              <DictationCapsule
                phase={dictation.phase}
                level={dictation.level}
                download={dictation.download}
                onDiscard={discardDictation}
                onStop={() => void dictation.stop()}
              />
            ) : (
              <VoiceMicButton
                onPress={() => {
                  // Where the words land is fixed now, while the caret is where the user left it.
                  const end = draft.length;
                  const anchor = placed.current ? selection : { start: end, end };
                  take.current = startTake(draft, anchor);
                  setProvisional(null);
                  void dictation.start({ draft, selection: anchor });
                }}
              />
            )}
          </View>
        ) : null}
      </View>
      {/* Preparing and finishing share one slot under the words, so neither moves them. The model download is the ring on
          the mic, and an error a bubble over it: both belong to the button that tries again. */}
      {dictation.phase === "preparing" || dictation.phase === "transcribing" ? (
        <Text accessibilityLiveRegion="polite" style={{ marginHorizontal: 14, marginBottom: 8, color: colors.ink2, fontSize: 13 }}>
          {dictation.phase === "preparing" ? "Preparing the microphone\u2026" : "Finishing the last words\u2026"}
        </Text>
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
/** The @ menu's files under `root`: an answer for another root (the draft moved to another Project) is never shown. */
function useFileSearch(client: Client, root: string, query: string | null) {
  const [state, setState] = useState({ root: "", items: [] as string[], error: "", loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (query === null || !root) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .call<string[]>("project:files", [root, query])
        .then((items) => !cancelled && setState({ root, items: items.slice(0, 40), error: "", loading: false }))
        .catch((error: Error) => !cancelled && setState({ root, items: [], error: error.message || "failed", loading: false }));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, root, query, revision]);
  const retry = () => setRevision((value) => value + 1);
  return state.root === root ? { items: state.items, error: state.error, loading: state.loading, retry } : { items: [], error: "", loading: true, retry };
}
