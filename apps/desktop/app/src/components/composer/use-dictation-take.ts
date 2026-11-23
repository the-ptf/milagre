import { editedCorrection, type VocabularyCorrection } from "@milagre/shared/dictation";
import { lastDictation, saveLastDictation } from "../../lib/last-dictation";
import { useShortcutLabel } from "../../lib/keybindings";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ModelOption } from "../../model";
import { useSettings } from "../../lib/settings";
import { type PromptEditorHandle } from "../PromptEditor";
import { useChatMentions } from "../ChatMentions";
import {
  insertDictation,
  NOTICE_SECONDS,
  provisionalRange,
  correctTake,
  takeRange,
  revertTake,
  startTake,
  writeTake,
  type DictationTake,
  type Selection as TextRange,
} from "@milagre/shared/voice-dictation";
import { useDictationShortcut } from "../../lib/dictation-shortcut";
import { useDictation } from "../useDictation";

type DictationTakeProps = {
  projectPath: string;
  imageDraft: import("../usePastedImages").ImageDraft;
  quotes: readonly { text: string }[];
  draft: string;
  draftLatest: RefObject<string>;
  onDraftChange: (value: string) => void;
  setCaret: (caret: number) => void;
  inputRef: RefObject<PromptEditorHandle | null>;
  caret: number;
  dictationAction: ReturnType<typeof useSettings>["dictationAction"];
  dictationShortcutMode: ReturnType<typeof useSettings>["dictationShortcutMode"];
  mentions: ReturnType<typeof useChatMentions>;
  selectedModel: ModelOption;
};

export function useDictationTake({
  projectPath,
  imageDraft,
  quotes,
  draft,
  draftLatest,
  onDraftChange,
  setCaret,
  inputRef,
  caret,
  dictationAction,
  dictationShortcutMode,
  mentions,
  selectedModel,
}: DictationTakeProps) {
  const dictatedSend = useRef<{ value: string; scope: string } | null>(null);
  const take = useRef<DictationTake | null>(null);
  const [provisional, setProvisional] = useState<TextRange | null>(null);
  const write = (text: string, settled: number) => {
    const current = take.current;
    if (!current) return null;
    const written = writeTake(current, draftLatest.current, text, settled);
    if (!written) return null;
    take.current = written.take;
    setProvisional(provisionalRange(written.take));
    setCaret(written.caret);
    onDraftChange(written.value);
    inputRef.current?.setSelection(written.caret);
    return written;
  };
  const writeLatest = useRef(write);
  writeLatest.current = write;
  const delivered = useRef<{ scope: string; draft: string } | null>(null);
  const correcting = useRef<{ id: number; take: DictationTake } | null>(null);
  const corrections = useRef(0);
  useEffect(
    () => () => {
      correcting.current = null;
    },
    [],
  );
  const [fixing, setFixing] = useState<string | null>(null);
  const endCorrection = useCallback(() => {
    correcting.current = null;
    setFixing(null);
    if (!take.current) setProvisional(null);
  }, []);
  useEffect(() => {
    endCorrection();
  }, [imageDraft.scope, endCorrection]);
  useEffect(() => {
    const pending = correcting.current;
    if (pending && draft !== pending.take.produced) endCorrection();
  }, [draft, endCorrection]);

  const dictation = useDictation(
    projectPath,
    imageDraft.scope,
    (text, anchor, correction) => {
      saveLastDictation(text, correction?.text);
      take.current ??= startTake(draftLatest.current, anchor.selection);
      const written = writeLatest.current(text, text.length);
      take.current = null;
      const scope = imageDraft.scope;
      if (written) delivered.current = { scope: imageDraft.scope, draft: written.value };
      const sendAfter = dictationAction === "send";
      if (!written || !correction) {
        setProvisional(null);
        if (written && sendAfter) dictatedSend.current = { value: written.value, scope };
        return;
      }
      const id = (corrections.current += 1);
      correcting.current = { id, take: written.take };
      setProvisional(takeRange(written.take));
      setFixing(correction.model);
      void correction.text.then((fixed) => {
        const pending = correcting.current;
        if (pending?.id !== id) return;
        endCorrection();
        const corrected = correctTake(pending.take, draftLatest.current, fixed);
        if (corrected) delivered.current = { scope: imageDraft.scope, draft: corrected.value };
        if (corrected) {
          setCaret(corrected.caret);
          onDraftChange(corrected.value);
          inputRef.current?.setSelection(corrected.caret);
        }
        if (sendAfter)
          dictatedSend.current = {
            value: corrected?.value ?? pending.take.produced,
            scope,
          };
      });
    },
    {
      scope: mentions.project,
      chatId: mentions.currentId,
      provider: selectedModel.provider,
    },
  );
  const partialText = dictation.partial.text;
  const partialSettled = dictation.partial.settled;
  useEffect(() => {
    if (take.current && partialText) writeLatest.current(partialText, partialSettled);
  }, [partialText, partialSettled]);
  const discardDictation = () => {
    const current = take.current;
    dictation.cancel();
    take.current = null;
    setProvisional(null);
    if (!current) return;
    const back = revertTake(current, draftLatest.current);
    setCaret(back.selection.start);
    onDraftChange(back.value);
    inputRef.current?.setSelection(back.selection.start, back.selection.end);
  };
  const dictateShortcutLabel = useShortcutLabel("dictation.toggle");
  const dictating = dictation.phase !== "idle";
  const finishWhenRecording = useRef(false);
  const startDictation = () => {
    finishWhenRecording.current = false;
    endCorrection();
    const selection = inputRef.current?.getSelection() ?? {
      start: caret,
      end: caret,
    };
    take.current = startTake(draftLatest.current, selection);
    setProvisional(null);
    void dictation.start(
      {
        selection,
        draft: draftLatest.current,
        quotes: quotes.map((quote) => quote.text),
        attachments: [...imageDraft.files.map((path) => imageDraft.localFiles.get(path)?.name ?? path), ...imageDraft.images.map((image) => image.name ?? "")],
      },
      () => finishWhenRecording.current,
    );
  };
  const { phase: dictationPhase, stop: stopDictation } = dictation;
  useEffect(() => {
    if (dictationPhase === "idle") finishWhenRecording.current = false;
    if (dictationPhase !== "recording" || !finishWhenRecording.current) return;
    finishWhenRecording.current = false;
    void stopDictation();
  }, [dictationPhase, stopDictation]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [vocabulary, setVocabulary] = useState<{ scope: string; correction: VocabularyCorrection } | null>(null);
  const range = () => inputRef.current?.getSelection() ?? { start: caret, end: caret };
  const openVocabulary = () => {
    const { start, end } = range();
    setVocabulary({
      scope: imageDraft.scope,
      correction: editedCorrection(
        delivered.current?.scope === imageDraft.scope ? delivered.current.draft : "",
        draftLatest.current,
        draftLatest.current.slice(start, end),
      ),
    });
  };
  useDictationShortcut({
    root: () => rootRef.current,
    dictating: () => dictationPhase !== "idle",
    mode: () => dictationShortcutMode,
    vocabulary: openVocabulary,
    insertLast: () => {
      const edit = insertDictation(draftLatest.current, range(), lastDictation(), true);
      if (!edit) return;
      endCorrection();
      onDraftChange(edit.value);
      setCaret(edit.caret);
      inputRef.current?.focus();
      inputRef.current?.setSelection(edit.caret);
    },
    start: startDictation,
    finish: () => {
      if (dictationPhase === "recording") void stopDictation();
      else finishWhenRecording.current = true;
    },
  });
  const discardLatest = useRef(discardDictation);
  discardLatest.current = discardDictation;
  useEffect(() => {
    if (!dictating && take.current) discardLatest.current();
  }, [dictating]);
  const { error: dictationError, dismiss: dismissDictationError } = dictation;
  useEffect(() => {
    if (!dictationError || dictationError.kind === "permission") return;
    const timer = setTimeout(dismissDictationError, NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [dictationError, dismissDictationError]);
  return {
    vocabulary: vocabulary?.scope === imageDraft.scope ? vocabulary : null,
    openVocabulary,
    closeVocabulary: () => setVocabulary(null),
    dictateShortcutLabel,
    dictating,
    dictation,
    dictationError,
    discardDictation,
    fixing,
    provisional,
    rootRef,
    startDictation,
    dictatedSend,
  };
}
