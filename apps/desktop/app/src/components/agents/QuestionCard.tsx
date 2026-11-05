import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Cancel01Icon, Image01Icon, Mic01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { NOTICE_SECONDS } from "@milagre/shared/voice-dictation";
import { IMAGE_ERRORS, IMAGE_TYPES, MAX_ATTACHMENT_BYTES } from "@milagre/shared/limits";
import type { AgentQuestion, QuestionAnswers, QuestionImages, QuestionRequest } from "../../model";
import {
  advancesOnPick,
  answerImageCount,
  draftAnswers,
  draftImages,
  draftOf,
  MAX_ANSWER_IMAGES,
  nextTab,
  pickOption,
  primaryAction,
  primaryEnabled,
  questionAnswered,
  sendsOnPick,
  setAnswerImages,
  tabLabel,
  typeAnswer,
  withDictation,
} from "../../lib/question-answers";
import type { QuestionDrafts } from "../../lib/question-answers";
import { SPRING_SWAP } from "../../lib/ease";
import { SecretCard } from "./SecretCard";
import { Attachments } from "../Attachments";
import { readImage } from "../usePastedImages";
import { InlineError } from "../primitives/InlineError";
import { useDictation } from "../useDictation";
import { DictationNotice } from "../DictationNotice";
import { DownloadRing, DroppingArrow } from "../DownloadRing";
import { ScrollArea } from "../primitives/ScrollArea";
import { Button, IconButton } from "../primitives/Button";
import { CheckboxBox } from "../primitives/Checkbox";
import { Input } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { Tabs } from "../primitives/Tabs";

/**
 * The open chat's oldest question: the agent's options as rows, an answer of the user's own, and Dismiss.
 * Several questions show one at a time, under a tab each.
 */
export function QuestionCard(props: Parameters<typeof OrdinaryQuestionCard>[0]) {
  if (props.request.secretRequest)
    return <SecretCard key={props.request.requestId} request={props.request} busy={props.answering !== null} onAnswer={props.onAnswer} />;
  return <OrdinaryQuestionCard {...props} />;
}

function OrdinaryQuestionCard({
  request,
  waiting,
  answering,
  onAnswer,
  dictationChat,
}: {
  /** The Chat asking: dictation reads its Project's words and its agent fixes misheard names, as in the composer. */
  dictationChat?: { cwd: string; scope?: string; chatId?: number; provider?: string };
  request: QuestionRequest;
  /** How many more questions are queued behind this one. */
  waiting: number;
  /** What was already sent for this question, while the agent takes it. */
  answering: "answered" | "dismissed" | null;
  /** The answers to send, or null to dismiss the question, and the images attached to them. */
  onAnswer: (answers: QuestionAnswers | null, images?: QuestionImages) => void;
}) {
  const reduce = useReducedMotion();
  const [drafts, setDrafts] = useState<QuestionDrafts>({});
  const [selected, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState("");
  // A dictated answer goes after what was typed: the words show as they're heard, and the fix-up may rewrite them after.
  const dictated = useRef<{ question: AgentQuestion; base: string } | null>(null);
  const dictation = useDictation(
    dictationChat?.cwd ?? "",
    request.requestId,
    (text, _anchor, correction) => {
      const target = dictated.current;
      dictated.current = null;
      if (!target) return;
      const value = withDictation(target.base, text);
      setDrafts((current) => typeAnswer(current, target.question, value));
      void correction?.text.then((fixed) =>
        setDrafts((current) =>
          draftOf(current, target.question.id).typed === value ? typeAnswer(current, target.question, withDictation(target.base, fixed)) : current,
        ),
      );
    },
    dictationChat ?? {},
  );
  const dictating = dictation.phase !== "idle";
  const heard = dictation.partial.text;
  useEffect(() => {
    const target = dictated.current;
    if (target && heard) setDrafts((current) => typeAnswer(current, target.question, withDictation(target.base, heard)));
  }, [heard]);
  // A take that ends without words (cancelled, no speech, failed) puts back what was typed before it.
  useEffect(() => {
    const target = dictated.current;
    if (dictating || !target) return;
    dictated.current = null;
    setDrafts((current) => typeAnswer(current, target.question, target.base));
  }, [dictating]);
  const { error: dictationError, dismiss: dismissDictationError } = dictation;
  useEffect(() => {
    if (!dictationError || dictationError.kind === "permission") return;
    const timer = setTimeout(dismissDictationError, NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [dictationError, dismissDictationError]);
  function startDictation(target: AgentQuestion) {
    const base = draftOf(drafts, target.id).typed;
    dictated.current = { question: target, base };
    void dictation.start({ selection: { start: base.length, end: base.length } });
  }
  // Next, or a pick that moves on, and the panel remounts, so focus would fall to the page: put it in the new panel.
  const focusPanel = useRef(false);
  const questions = request.questions;
  const count = questions.length;
  const several = count > 1;
  const active = Math.min(selected, Math.max(0, count - 1));
  const question = questions[active];
  const answers = draftAnswers(questions, drafts);
  const pending = answering === null;
  const action = primaryAction(questions, active);
  const ready = primaryEnabled(questions, drafts, active);
  const description = `${count === 1 ? "The agent has a question." : `The agent has ${count} questions.`}${waiting > 0 ? ` ${waiting} more ${waiting === 1 ? "question is" : "questions are"} waiting after this one.` : ""}`;

  function pick(target: AgentQuestion, label: string) {
    const next = pickOption(drafts, target, label);
    setDrafts(next);
    // One single-choice question: the tap is the answer.
    const done = draftAnswers(questions, next);
    if (sendsOnPick(questions) && done) onAnswer(done, draftImages(questions, next));
    // Several questions: a single-choice pick is the answer to this one, so move on. The last one waits for Send.
    else if (advancesOnPick(questions, active)) {
      focusPanel.current = true;
      setActive(nextTab(count, active));
    }
  }

  function advance() {
    if (!ready || dictating) return;
    if (action === "next") {
      focusPanel.current = true;
      setActive(nextTab(count, active));
    } else if (answers) onAnswer(answers, draftImages(questions, drafts));
  }

  // Images pasted into the field or chosen with the image button go with this question's answer: the agent gets
  // their paths and opens them.
  async function addImages(target: AgentQuestion, files: File[]) {
    setImageError("");
    if (!files.length) return;
    if (files.some((file) => !IMAGE_TYPES.includes(file.type))) return setImageError(IMAGE_ERRORS.type);
    if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) return setImageError(IMAGE_ERRORS.size);
    if (answerImageCount(drafts) + files.length > MAX_ANSWER_IMAGES) return setImageError(`Attach at most ${MAX_ANSWER_IMAGES} images to your answers.`);
    try {
      const read = await Promise.all(files.map(readImage));
      setDrafts((current) => setAnswerImages(current, target, [...(draftOf(current, target.id).images ?? []), ...read]));
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "Could not read the image. Try again.");
    }
  }

  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>, target: AgentQuestion) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      advance();
    }
    // Escape clears a typed answer first; on an empty field it reaches the window, which dismisses the question.
    if (event.key === "Escape" && !event.nativeEvent.isComposing && draftOf(drafts, target.id).typed) {
      event.preventDefault();
      setDrafts(typeAnswer(drafts, target, ""));
    }
  }

  useEffect(() => {
    if (!focusPanel.current) return;
    focusPanel.current = false;
    const controls = panelRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
    // The picked option, else the first option, else the field when there are no options.
    const target = panelRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? controls?.[0];
    target?.focus();
  }, [active]);

  if (!question) return null;
  const draft = draftOf(drafts, question.id);

  return (
    <motion.section
      role="dialog"
      aria-label="Agent question"
      aria-description={description}
      aria-busy={answering === "answered"}
      initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, y: 6, scale: 0.985 }}
      transition={reduce ? { duration: 0 } : SPRING_SWAP}
      className="flex max-h-[min(72vh,620px)] w-full flex-col overflow-hidden rounded-card bg-surface shadow-overlay"
    >
      <ScrollArea className="grid flex-1 gap-3 p-4">
        {several && (
          <Tabs
            label="Questions"
            value={String(active)}
            options={questions.map((item, index) => ({
              value: String(index),
              label: tabLabel(item, index),
              icon: questionAnswered(item, drafts) ? Tick02Icon : undefined,
              controls: "question-panel",
            }))}
            onChange={(value) => setActive(Number(value))}
            className="flex-wrap"
          />
        )}

        <div
          key={question.id}
          id="question-panel"
          ref={panelRef}
          role={several ? "tabpanel" : question.multiSelect ? "group" : "radiogroup"}
          aria-label={several ? tabLabel(question, active) : question.question}
          className="grid gap-1.5"
        >
          <h2 className="text-15 font-semibold text-ink">{question.question}</h2>
          {question.multiSelect && <p className="text-12 text-ink-3">Pick any that apply.</p>}
          {question.options.map((option, index) => {
            const picked = draft.picked.includes(option.label);
            return (
              <button
                key={`${index}-${option.label}`}
                type="button"
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={picked}
                disabled={!pending}
                onClick={() => pick(question, option.label)}
                className={`flex w-full items-start gap-2 rounded-control border px-2.5 py-2 text-left transition-colors disabled:cursor-default ${picked ? "border-line-strong bg-inset" : "border-line bg-surface enabled:hover:border-line-strong enabled:hover:bg-hover enabled:active:bg-hover-2"}`}
              >
                {/* The row is the control (role and aria-checked), so it draws only the box. */}
                <CheckboxBox checked={picked} radio={!question.multiSelect} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block text-13 font-medium text-ink">{option.label}</span>
                  {option.description && <span className="block text-12 text-ink-2">{option.description}</span>}
                </span>
              </button>
            );
          })}
          {question.allowOther && (
            <div className="flex items-center gap-1.5">
              <Input
                type={question.secret ? "password" : "text"}
                value={draft.typed}
                disabled={!pending}
                onChange={(event) => setDrafts(typeAnswer(drafts, question, event.target.value))}
                onKeyDown={(event) => handleFieldKeyDown(event, question)}
                onPaste={(event) => {
                  if (question.secret) return;
                  const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                  if (!files.length) return;
                  event.preventDefault();
                  void addImages(question, files);
                }}
                placeholder={question.options.length ? "Other…" : "Type your answer"}
                aria-label={`Your own answer to: ${question.question}`}
                autoComplete="off"
                className="min-w-0 flex-1"
              />
              {!question.secret && (
                <span className="relative flex shrink-0">
                  {dictationError && <DictationNotice error={dictationError} onOpenSettings={dictation.openSettings} />}
                  {dictation.download ? (
                    <button
                      type="button"
                      aria-label={`Downloading speech model, ${Math.round((dictation.download.received / dictation.download.total) * 100)}%. Cancel`}
                      onClick={dictation.cancel}
                      className="flex size-8 items-center justify-center rounded-full text-ink"
                    >
                      <DownloadRing size={28} progress={dictation.download.received / dictation.download.total}>
                        <DroppingArrow size={14} well={20} />
                      </DownloadRing>
                    </button>
                  ) : dictating ? (
                    <span data-dictation-capsule className="flex h-8 items-center gap-1 rounded-full bg-hover px-1">
                      <button
                        type="button"
                        aria-label="Discard dictation"
                        title="Discard dictation"
                        onClick={dictation.cancel}
                        className="flex size-6 items-center justify-center rounded-full text-ink-2 transition-colors hover:text-ink"
                      >
                        <Icon icon={Cancel01Icon} size={14} />
                      </button>
                      {dictation.phase === "recording" ? (
                        <button
                          ref={(node) => {
                            // oxlint-disable-next-line react/immutability -- the hook's meter ref, as the composer sets it: useDictation writes --level on it each frame.
                            dictation.meter.current = node;
                          }}
                          type="button"
                          aria-label="Stop dictation"
                          title="Stop dictation"
                          onClick={() => void dictation.stop()}
                          className="relative flex size-6 items-center justify-center rounded-full"
                        >
                          <span
                            aria-hidden
                            className="absolute inset-0.5 rounded-full bg-red/25 motion-safe:transition-transform motion-safe:duration-75"
                            style={{ transform: "scale(calc(1 + var(--level, 0) * 0.38))" }}
                          />
                          <span aria-hidden className="relative block size-2.5 rounded-inline bg-red" />
                        </button>
                      ) : (
                        <span aria-hidden className="flex size-6 items-center justify-center">
                          <span className="block size-4 rounded-full border-2 border-line border-t-ink-2 border-r-ink-2 motion-safe:animate-spin" />
                        </span>
                      )}
                    </span>
                  ) : (
                    <IconButton label="Dictate" icon={Mic01Icon} size={32} disabled={!pending} onClick={() => startDictation(question)} />
                  )}
                </span>
              )}
              {!question.secret && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept={IMAGE_TYPES.join(",")}
                    multiple
                    hidden
                    aria-label="Choose images for your answer"
                    onChange={(event) => {
                      void addImages(question, Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                  <IconButton label="Attach images" icon={Image01Icon} size={32} disabled={!pending} onClick={() => fileRef.current?.click()} />
                </>
              )}
            </div>
          )}
          {!!draft.images?.length && (
            <Attachments
              images={draft.images}
              removeImage={
                pending
                  ? (id) =>
                      setDrafts((current) =>
                        setAnswerImages(
                          current,
                          question,
                          (draftOf(current, question.id).images ?? []).filter((image) => image.id !== id),
                        ),
                      )
                  : undefined
              }
            />
          )}
          <InlineError size={12}>{imageError}</InlineError>
        </div>
      </ScrollArea>

      <AnimatePresence initial={false}>
        {pending && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 6 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="flex flex-wrap justify-start gap-2 border-t border-line bg-inset px-4 py-3"
          >
            <Button variant="secondary" onClick={() => onAnswer(null)}>
              <Icon icon={Cancel01Icon} size={14} />
              Dismiss
            </Button>
            <Button disabled={!ready || dictating} onClick={advance}>
              <Icon icon={Tick02Icon} size={14} />
              {action === "next" ? "Next" : count === 1 ? "Send answer" : "Send answers"}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
