import { useEffect, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent, RefObject } from "react";
import { ArrowLeft01Icon, ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { answerPlaceholder, questionPosition, QUESTION_COMPOSER_COPY as COPY } from "@milagre/shared/question-composer";
import type { AgentQuestion, QuestionAnswers, QuestionImages, QuestionRequest } from "../../model";
import {
  advancesOnPick,
  draftAnswers,
  draftImages,
  draftOf,
  nextTab,
  pickOption,
  primaryAction,
  primaryEnabled,
  questionAnswered,
  sendsOnPick,
  setAnswerImages,
  tabLabel,
  typeAnswer,
} from "../../lib/question-answers";
import type { QuestionDrafts } from "../../lib/question-answers";
import { usePastedImages, type ImageDraft } from "../usePastedImages";
import { PromptComposer } from "../PromptComposer";
import { ScrollArea } from "../primitives/ScrollArea";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { Tabs } from "../primitives/Tabs";

export type ComposerQuestionProps = {
  request: QuestionRequest;
  waiting: number;
  onAnswer: (answers: QuestionAnswers | null, images?: QuestionImages) => void;
};

type PromptProps = ComponentProps<typeof PromptComposer>;
type QuestionPromptProps = Omit<PromptProps, "draft" | "onDraftChange" | "header" | "sendReady" | "quotes" | "onRemoveQuote"> & {
  question: ComposerQuestionProps;
};

const NO_HISTORY: string[] = [];

/** The composer while the agent waits on a question: its options above the prompt, and the prompt as the typed answer. */
export function QuestionPromptComposer({ question, ...props }: QuestionPromptProps) {
  const images = usePastedImages(`question:${question.request.requestId}`);
  const answer = useComposerQuestion(question, images);
  return (
    <PromptComposer
      {...props}
      imageDraft={images}
      history={NO_HISTORY}
      draft={answer.typed}
      onDraftChange={answer.type}
      header={answer.banner}
      sendReady={answer.ready}
      placeholder={answer.placeholder}
      onSend={answer.advance}
      running={false}
      onStop={undefined}
      suggestion={undefined}
    />
  );
}

function withComposerImages(drafts: QuestionDrafts, question: AgentQuestion, images: ImageDraft): QuestionDrafts {
  if (!images.images.length) return drafts;
  return setAnswerImages(drafts, question, [...(draftOf(drafts, question.id).images ?? []), ...images.images]);
}

function useComposerQuestion({ request, waiting, onAnswer }: ComposerQuestionProps, images: ImageDraft) {
  const [drafts, setDrafts] = useState<QuestionDrafts>({});
  const [selected, setSelected] = useState(0);
  const optionsRef = useRef<HTMLDivElement>(null);
  const focusOptions = useRef(false);
  const questions = request.questions;
  const active = Math.min(selected, Math.max(0, questions.length - 1));
  const question = questions[active]!;
  const current = withComposerImages(drafts, question, images);
  const ready = primaryEnabled(questions, current, active);

  useEffect(() => {
    if (!focusOptions.current) return;
    focusOptions.current = false;
    const target = optionsRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? optionsRef.current?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [active]);

  function moveTo(index: number, focus = false) {
    if (images.images.length) {
      setDrafts(current);
      images.clear();
    }
    focusOptions.current = focus;
    setSelected(index);
  }

  function send(next: QuestionDrafts) {
    const answers = draftAnswers(questions, next);
    if (answers) onAnswer(answers, draftImages(questions, next));
  }

  function pick(label: string) {
    const picked = pickOption(current, question, label);
    const next = question.multiSelect ? picked : typeAnswer(picked, question, "");
    setDrafts(next);
    if (sendsOnPick(questions)) send(next);
    else if (advancesOnPick(questions, active)) moveTo(nextTab(questions.length, active), true);
  }

  function advance() {
    if (!ready) return;
    if (primaryAction(questions, active) === "next") moveTo(nextTab(questions.length, active));
    else send(current);
  }

  function pickWithKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const option = /^[1-9]$/.test(event.key) ? question.options[Number(event.key) - 1] : undefined;
    if (!option) return;
    event.preventDefault();
    pick(option.label);
  }

  const banner = (
    <QuestionBanner
      request={request}
      waiting={waiting}
      active={active}
      drafts={current}
      optionsRef={optionsRef}
      onSelect={(index) => moveTo(index)}
      onPick={pick}
      onKeyDown={pickWithKey}
      onSkip={() => onAnswer(null)}
    />
  );
  return {
    banner,
    ready,
    advance,
    typed: draftOf(drafts, question.id).typed,
    type: (value: string) => {
      if (question.allowOther) setDrafts((latest) => typeAnswer(latest, question, value));
    },
    placeholder: answerPlaceholder(question),
  };
}

function QuestionBanner({
  request,
  waiting,
  active,
  drafts,
  optionsRef,
  onSelect,
  onPick,
  onKeyDown,
  onSkip,
}: {
  request: QuestionRequest;
  waiting: number;
  active: number;
  drafts: QuestionDrafts;
  optionsRef: RefObject<HTMLDivElement | null>;
  onSelect: (index: number) => void;
  onPick: (label: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSkip: () => void;
}) {
  const questions = request.questions;
  const question = questions[active]!;
  const several = questions.length > 1;
  const draft = draftOf(drafts, question.id);
  const more = waiting > 0 ? ` ${waiting} more ${waiting === 1 ? "question is" : "questions are"} waiting after this one.` : "";
  return (
    <section
      data-composer-question
      aria-label="Agent question"
      aria-description={`${several ? `The agent has ${questions.length} questions.` : "The agent has a question."}${more}`}
      onKeyDown={onKeyDown}
      className="-mx-1 -mt-1 border-b border-line pb-2"
    >
      <div className="flex min-h-7 items-center gap-1">
        {several ? (
          <Tabs
            label="Questions"
            value={String(active)}
            options={questions.map((item, index) => ({
              value: String(index),
              label: tabLabel(item, index),
              icon: questionAnswered(item, drafts) ? Tick02Icon : undefined,
              controls: "composer-question-options",
            }))}
            onChange={(value) => onSelect(Number(value))}
            className="flex-1 overflow-x-auto"
          />
        ) : (
          <h2 className="min-w-0 flex-1 px-1 text-15 font-semibold text-ink">{question.question}</h2>
        )}
        {several && (
          <span className="flex shrink-0 items-center text-12 text-ink-3 tabular-nums">
            <IconButton label={COPY.previous} icon={ArrowLeft01Icon} size={24} disabled={active === 0} onClick={() => onSelect(active - 1)} />
            {questionPosition(active, questions.length)}
            <IconButton label={COPY.next} icon={ArrowRight01Icon} size={24} disabled={active === questions.length - 1} onClick={() => onSelect(active + 1)} />
          </span>
        )}
        <Button variant="quiet" size={24} aria-label={COPY.skipLabel} onClick={onSkip}>
          {COPY.skip}
        </Button>
      </div>
      {several && <h2 className="mt-1 px-1 text-15 font-semibold text-ink">{question.question}</h2>}
      {question.multiSelect && <p className="mt-0.5 px-1 text-12 text-ink-3">{COPY.pickAny}</p>}
      {question.options.length > 0 && (
        <ScrollArea className="mt-2.5 max-h-[min(40vh,320px)]">
          <div
            ref={optionsRef}
            key={question.id}
            id="composer-question-options"
            role={question.multiSelect ? "group" : "radiogroup"}
            aria-label={question.question}
            className="grid gap-0.5"
          >
            {question.options.map((option, index) => {
              const picked = draft.picked.includes(option.label);
              return (
                <button
                  key={`${index}-${option.label}`}
                  type="button"
                  role={question.multiSelect ? "checkbox" : "radio"}
                  aria-checked={picked}
                  onClick={() => onPick(option.label)}
                  className={`flex w-full items-start gap-2.5 rounded-control px-1.5 py-1.5 text-left transition-colors ${picked ? "bg-hover-2" : "hover:bg-hover active:bg-hover-2"}`}
                >
                  <span
                    aria-hidden
                    className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-chip text-11 font-semibold ${picked ? "bg-ink text-on-ink" : "bg-field text-ink-2"}`}
                  >
                    {question.multiSelect && picked ? <Icon icon={Tick02Icon} size={12} /> : index < 9 ? index + 1 : ""}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-13 font-medium text-ink">{option.label}</span>
                    {option.description && <span className="block text-12 text-ink-2">{option.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
