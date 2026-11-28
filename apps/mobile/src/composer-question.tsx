import { useRef, useState, type ComponentProps } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { ArrowRight01Icon, ArrowUp01Icon, Attachment01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { AgentQuestion, QuestionAnswers, QuestionRequest } from "@milagre/shared/model";
import { answerPlaceholder, QUESTION_COMPOSER_COPY as COPY } from "@milagre/shared/question-composer";
import { takeActivityDraft } from "./activity-drafts";
import { pickAttachments, preparePastedImage, type PastedImage } from "./attachment-picker";
import type { Attachment } from "./attachments";
import { ComposerGlass } from "./composer-glass";
import { Icon } from "./icons";
import { PromptField } from "./prompt-field";
import { DISABLED_OPACITY, IconButton, InlineError, pressStyle, PullDown, useStyles } from "./ui";
import { useTheme } from "./theme";
import { lineHeight, radius, space, type } from "./design-tokens";

type AnswerImages = Record<string, Attachment[]>;
type FieldProps = Omit<ComponentProps<typeof PromptField>, "draft" | "onChangeText" | "onSubmit" | "placeholder" | "renderControls" | "onImagePaste">;

const MAX_IMAGES = 10;
const NO_IMAGES: Attachment[] = [];

/** The composer while the agent waits on a question: its options above the prompt, and the prompt as the typed answer. */
export function ComposerQuestion({
  request,
  busy,
  initialAnswers,
  field,
  submit,
  bare = false,
}: {
  request: QuestionRequest;
  busy: boolean;
  initialAnswers: QuestionAnswers;
  field: FieldProps;
  /** On a sheet's own surface: no glass card or shadow around it. */
  bare?: boolean;
  submit: (answers: QuestionAnswers | null, summary: string, images?: AnswerImages) => void;
}) {
  const { colors } = useTheme();
  const questions = request.questions;
  const [page, setPage] = useState(() =>
    Math.max(
      0,
      questions.findIndex((q) => !initialAnswers[q.id]?.length),
    ),
  );
  const [picked, setPicked] = useState<QuestionAnswers>(initialAnswers);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [images, setImages] = useState<AnswerImages>({});
  const [pickError, setPickError] = useState("");
  const attaching = useRef(false);
  const question = questions[Math.min(page, questions.length - 1)]!;
  const last = page === questions.length - 1;
  const imagesOf = (q: AgentQuestion) => images[q.id] ?? NO_IMAGES;
  const answerOf = (q: AgentQuestion, nextPicked = picked, nextTyped = typed) => {
    const text = q.allowOther ? nextTyped[q.id]?.trim() : "";
    return [...(nextPicked[q.id] ?? []), ...(text ? [text] : [])];
  };
  const answered = (q: AgentQuestion) => answerOf(q).length > 0 || imagesOf(q).length > 0;
  const ready = !busy && (last ? questions.every(answered) : answered(question));

  function finish(nextPicked: QuestionAnswers, nextTyped = typed) {
    const answers = Object.fromEntries(questions.map((q) => [q.id, answerOf(q, nextPicked, nextTyped)]));
    const open = questions.findIndex((q) => !answers[q.id]?.length && !imagesOf(q).length);
    if (open >= 0) return setPage(open);
    const attached = Object.fromEntries(questions.flatMap((q) => (imagesOf(q).length ? [[q.id, imagesOf(q)]] : [])));
    const shown = (q: AgentQuestion) => [...(answers[q.id] ?? []), ...(imagesOf(q).length ? [`${imagesOf(q).length} photos`] : [])];
    submit(answers, questions.map((q) => `${q.header || q.question}: ${shown(q).join(", ")}`).join("\n"), Object.keys(attached).length ? attached : undefined);
  }

  function choose(label: string) {
    if (busy) return;
    const current = picked[question.id] ?? [];
    if (question.multiSelect) {
      setPicked({ ...picked, [question.id]: current.includes(label) ? current.filter((value) => value !== label) : [...current, label] });
      return;
    }
    const nextPicked = { ...picked, [question.id]: [label] };
    const nextTyped = { ...typed, [question.id]: "" };
    setPicked(nextPicked);
    setTyped(nextTyped);
    if (questions.length === 1) finish(nextPicked, nextTyped);
    else if (!last) setPage(page + 1);
  }

  function typeAnswer(value: string) {
    if (!question.allowOther) return;
    setTyped({ ...typed, [question.id]: value });
    if (!question.multiSelect && value.trim()) setPicked({ ...picked, [question.id]: [] });
  }

  function advance() {
    if (!ready) return;
    if (last) finish(picked);
    else setPage(page + 1);
  }

  async function attach(take: () => Promise<Attachment[]>) {
    if (attaching.current) return;
    attaching.current = true;
    setPickError("");
    const target = question.id;
    try {
      const photos = (await take()).filter((item) => item.image);
      const total = Object.values(images).reduce((sum, list) => sum + list.length, 0);
      if (total + photos.length > MAX_IMAGES) return setPickError(`Attach at most ${MAX_IMAGES} photos to your answers.`);
      setImages((current) => ({ ...current, [target]: [...(current[target] ?? []), ...photos] }));
    } catch (failure) {
      setPickError((failure as Error).message);
    } finally {
      attaching.current = false;
    }
  }

  return (
    <View
      accessibilityLabel="Agent question"
      style={
        bare
          ? { gap: 4 }
          : {
              borderRadius: radius.composer,
              borderCurve: "continuous",
              paddingTop: 8,
              paddingHorizontal: 8,
              paddingBottom: 6,
              gap: 4,
              boxShadow: colors.shadowRaised,
            }
      }
    >
      {!bare && <ComposerGlass radius={radius.composer} />}
      <QuestionHeader request={request} page={page} answered={answered} busy={busy} onSelect={setPage} onSkip={() => submit(null, "")} />
      <QuestionOptions question={question} picked={picked[question.id] ?? []} busy={busy} onChoose={choose} />
      {imagesOf(question).length > 0 && (
        <AnswerPhotos
          photos={imagesOf(question)}
          busy={busy}
          onRemove={(id) => setImages({ ...images, [question.id]: imagesOf(question).filter((item) => item.id !== id) })}
        />
      )}
      <InlineError message={pickError} style={{ paddingHorizontal: 8 }} />
      <PromptField
        key={question.id}
        {...field}
        draft={typed[question.id] ?? ""}
        onChangeText={typeAnswer}
        onSubmit={advance}
        placeholder={answerPlaceholder(question)}
        onImagePaste={(image: PastedImage) => void attach(async () => [await preparePastedImage(image)])}
        renderControls={(mic) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            <PhotoPicker busy={busy} onPick={(kind) => void attach(() => pickAttachments(kind))} />
            <View style={{ flex: 1 }} />
            {mic}
            <IconButton
              label={last ? "Send answer" : COPY.next}
              icon={last ? ArrowUp01Icon : ArrowRight01Icon}
              filled
              size={36}
              loading={busy}
              disabled={!ready}
              onPress={advance}
            />
          </View>
        )}
      />
    </View>
  );
}

/** A Chat's question, starting from the answers picked in its Live Activity or notification. */
export function ActivityComposerQuestion({
  hostId,
  projectPath,
  sessionId,
  ...props
}: Omit<ComponentProps<typeof ComposerQuestion>, "initialAnswers"> & { hostId: string; projectPath: string; sessionId: number }) {
  const [initialAnswers] = useState(() => takeActivityDraft(hostId, projectPath, sessionId, props.request.requestId));
  return <ComposerQuestion {...props} initialAnswers={initialAnswers} />;
}

function QuestionHeader({
  request,
  page,
  answered,
  busy,
  onSelect,
  onSkip,
}: {
  request: QuestionRequest;
  page: number;
  answered: (question: AgentQuestion) => boolean;
  busy: boolean;
  onSelect: (page: number) => void;
  onSkip: () => void;
}) {
  const { colors } = useTheme();
  const questions = request.questions;
  const question = questions[page]!;
  const several = questions.length > 1;
  const title = { color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" } as const;
  return (
    <View style={{ paddingHorizontal: 4, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        {several ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" style={{ flex: 1 }} contentContainerStyle={{ gap: 4 }}>
            {questions.map((item, index) => (
              <Pressable
                key={item.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: index === page }}
                onPress={() => onSelect(index)}
                style={({ pressed }) => [
                  {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    minHeight: 32,
                    paddingHorizontal: space.lg,
                    borderRadius: radius.full,
                    backgroundColor: index === page ? colors.hover2 : "transparent",
                  },
                  pressStyle({ pressed, kind: "row" }),
                ]}
              >
                {answered(item) && <Icon icon={Tick02Icon} tone="ink2" size={12} />}
                <Text style={{ color: index === page ? colors.ink : colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>
                  {item.header.trim() || `Question ${index + 1}`}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text accessibilityRole="header" style={[title, { flex: 1 }]}>
            {question.question}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={COPY.skipLabel}
          disabled={busy}
          onPress={onSkip}
          hitSlop={6}
          style={({ pressed }) => [{ minHeight: 32, paddingHorizontal: space.lg, justifyContent: "center" }, pressStyle({ pressed, disabled: busy })]}
        >
          <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>{COPY.skip}</Text>
        </Pressable>
      </View>
      {several && (
        <Text accessibilityRole="header" style={title}>
          {question.question}
        </Text>
      )}
    </View>
  );
}

function QuestionOptions({
  question,
  picked,
  busy,
  onChoose,
}: {
  question: AgentQuestion;
  picked: string[];
  busy: boolean;
  onChoose: (label: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line, paddingTop: space.md, paddingBottom: space.sm }}>
      {question.multiSelect && (
        <Text style={[styles.caption, { paddingHorizontal: space.xs, marginTop: -space.sm, marginBottom: space.md }]}>{COPY.pickAny}</Text>
      )}
      <ScrollView style={{ maxHeight: 280 }} accessibilityRole={question.multiSelect ? undefined : "radiogroup"}>
        {question.options.map((option, index) => {
          const on = picked.includes(option.label);
          return (
            <Pressable
              key={`${index}-${option.label}`}
              accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
              accessibilityState={{ checked: on, disabled: busy }}
              disabled={busy}
              onPress={() => onChoose(option.label)}
              style={({ pressed }) => [
                {
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: space.lg,
                  minHeight: 44,
                  paddingVertical: 8,
                  paddingHorizontal: 6,
                  borderRadius: radius.control,
                  borderCurve: "continuous",
                  backgroundColor: on ? colors.hover2 : "transparent",
                },
                pressStyle({ pressed, disabled: busy, kind: "row" }),
              ]}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  marginTop: space.xxs,
                  borderRadius: radius.chip,
                  borderCurve: "continuous",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: on ? colors.ink : colors.field,
                }}
              >
                {on && question.multiSelect ? (
                  <Icon icon={Tick02Icon} tone="onInk" size={12} />
                ) : (
                  <Text maxFontSizeMultiplier={1.3} style={{ color: on ? colors.onInk : colors.ink2, fontSize: type.caption1, fontWeight: "600" }}>
                    {index + 1}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>{option.label}</Text>
                {!!option.description && (
                  <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{option.description}</Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function AnswerPhotos({ photos, busy, onRemove }: { photos: Attachment[]; busy: boolean; onRemove: (id: string) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 8, paddingTop: space.lg }}>
      {photos.map((item) => (
        <View key={item.id} style={{ width: 56, height: 56 }}>
          <Image
            source={{ uri: item.uri }}
            accessibilityLabel={item.name}
            style={{ width: 56, height: 56, borderRadius: radius.control, backgroundColor: colors.field }}
          />
          <View style={{ position: "absolute", top: -10, right: -10 }}>
            <IconButton label={`Remove ${item.name}`} icon={Cancel01Icon} filled size={32} disabled={busy} onPress={() => onRemove(item.id)} />
          </View>
        </View>
      ))}
    </View>
  );
}

function PhotoPicker({ busy, onPick }: { busy: boolean; onPick: (kind: "photos" | "camera" | "paste") => void }) {
  return (
    <PullDown
      label="Attach photos to your answer"
      nativeTrigger={{ systemImage: "paperclip", iconSize: 16, disabled: busy }}
      sections={[
        {
          items: [
            { id: "photos", title: "Photo Library", systemImage: "photo.on.rectangle", disabled: busy },
            { id: "camera", title: "Take Photo", systemImage: "camera", disabled: busy },
            { id: "paste", title: "Paste image", systemImage: "doc.on.clipboard", disabled: busy },
          ],
        },
      ]}
      onSelect={(kind) => onPick(kind as "photos" | "camera" | "paste")}
    >
      <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: busy ? DISABLED_OPACITY.control : 1 }}>
        <Icon icon={Attachment01Icon} tone="ink2" size={18} />
      </View>
    </PullDown>
  );
}
