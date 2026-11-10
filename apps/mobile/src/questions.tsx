import { SecretQuestion } from "./secret-question";
import { BugReportQuestion } from "./bug-report-question";
import { useEffect, useRef, useState } from "react";
import { Image, Linking, Pressable, Text, TextInput, View } from "react-native";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Image01Icon,
  PencilEdit02Icon,
  ShieldAlertIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { AgentQuestion, PermissionDecision, PermissionRequest, QuestionAnswers, QuestionRequest } from "@milagre/shared/model";
import { NEGOTIATION_ROUNDS } from "@milagre/shared/limits";
import { NOTICE_SECONDS } from "@milagre/shared/voice-dictation";
import { SETUP_APPROVAL_COPY } from "@milagre/shared/model-copy";
import { takeActivityDraft } from "./activity-drafts";
import { pickAttachments } from "./attachment-picker";
import type { Attachment } from "./attachments";
import { Icon } from "./icons";
import { InboxPage, InboxPager } from "./inbox-motion";
import { DictationNotice } from "./dictation-notice";
import { useVoiceDictation, type DictationChat } from "./voice-dictation-hook";
import { DictationCapsule, MIC_SIZE, VoiceMicButton } from "./voice-mic-button";
import { IconButton, InlineError, PillButton, pressStyle, PullDown, Tag, useStyles } from "./ui";
import { lineHeight, radius, type } from "./design-tokens";
import { useTheme } from "./theme";

export type InboxQuestionDraft = {
  page: number;
  picked: QuestionAnswers;
  typed: Record<string, string>;
  /** Photos attached to each question's answer, by question id. */
  images?: Record<string, Attachment[]>;
};

/** Photos attached to the answers, by question id: the caller uploads them and the agent gets their paths. */
export type AnswerImages = Record<string, Attachment[]>;

const NO_ANSWERS: QuestionAnswers = {};
const NO_IMAGES: Attachment[] = [];
const MAX_IMAGES = 10;

/** A typed answer with dictated words after it, a space between them. */
function withDictation(typed: string, words: string): string {
  const said = words.trim();
  if (!said) return typed;
  return typed && !/\s$/.test(typed) ? `${typed} ${said}` : `${typed}${said}`;
}

/** What the answer card and the summary say for a question's attached photos. */
const imagesLabel = (count: number) => (count === 1 ? "1 image" : `${count} images`);

/** The answers as the answer card shows them, with each question's photos counted, as the Mac records them. */
export function answersWithImages(answers: QuestionAnswers, images: AnswerImages | undefined): QuestionAnswers {
  const shown = { ...answers };
  for (const [id, list] of Object.entries(images ?? {})) if (list.length) shown[id] = [...(shown[id] ?? []), imagesLabel(list.length)];
  return shown;
}

const RECOMMENDED = /\s*\((recommended)\)\s*$/i;

/**
 * The agent's questions, Claude-style: the card takes the composer's place, one question at a time.
 * A single-choice pick moves on; a batch's last question waits for Send, matching desktop.
 */
export function Questions({
  request,
  busy,
  initialAnswers = NO_ANSWERS,
  confirmSingle = false,
  submit,
  variant = "card",
  draft,
  onDraftChange,
  dictationChat,
}: {
  /** The Chat asking: dictation reads its Project's words and its agent fixes misheard names, as in the composer. */
  dictationChat?: DictationChat;
  variant?: "card" | "inline";
  draft?: InboxQuestionDraft;
  onDraftChange?: (draft: InboxQuestionDraft) => void;
  request: QuestionRequest;
  busy: boolean;
  initialAnswers?: QuestionAnswers;
  /** The inbox keeps the choice editable until Send, like desktop's inbox. */
  confirmSingle?: boolean;
  submit: (answers: QuestionAnswers | null, summary: string, images?: AnswerImages) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [localDraft, setLocalDraft] = useState<InboxQuestionDraft>(() => ({
    page: Math.max(
      0,
      request.questions.findIndex((q) => !initialAnswers[q.id]?.length),
    ),
    picked: initialAnswers,
    typed: {},
  }));
  const current = draft ?? localDraft;
  // Dictation lands after a render or two: its edits start from the latest draft, not the one it began on.
  const latest = useRef(current);
  latest.current = current;
  const { page, picked, typed } = current;
  const images = current.images ?? {};
  const [pickError, setPickError] = useState("");
  const picking = useRef(false);
  const change = (patch: Partial<InboxQuestionDraft>) => {
    if (onDraftChange) onDraftChange({ ...latest.current, ...patch });
    else setLocalDraft((previous) => ({ ...previous, ...patch }));
  };
  const [direction, setDirection] = useState(1);
  // The typed-answer row is the field, so its edge (not the text alone) turns accent while focused.
  const [typing, setTyping] = useState(false);
  const setTyped = (target: AgentQuestion, text: string) =>
    change({
      typed: { ...latest.current.typed, [target.id]: text },
      ...(confirmSingle && !target.multiSelect ? { picked: { ...latest.current.picked, [target.id]: [] } } : {}),
    });
  // A dictated answer goes after what was typed: the words show as they're heard, and the fix-up may rewrite them after.
  const dictated = useRef<{ question: AgentQuestion; base: string } | null>(null);
  const dictation = useVoiceDictation((text, _anchor, correction) => {
    const target = dictated.current;
    dictated.current = null;
    if (!target) return;
    const value = withDictation(target.base, text);
    setTyped(target.question, value);
    void correction?.text.then((fixed) => {
      if ((latest.current.typed[target.question.id] ?? "") !== value) return;
      setTyped(target.question, withDictation(target.base, fixed));
    });
  }, dictationChat);
  const dictating = dictation.phase !== "idle";
  const heard = dictation.partial.text;
  useEffect(() => {
    const target = dictated.current;
    if (target && heard) setTyped(target.question, withDictation(target.base, heard));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only new words move the field.
  }, [heard]);
  // A take that ends without words (cancelled, no speech, failed) puts back what was typed before it.
  useEffect(() => {
    const target = dictated.current;
    if (dictating || !target) return;
    dictated.current = null;
    setTyped(target.question, target.base);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs when a take ends.
  }, [dictating]);
  const { error: dictationError, dismiss: dismissDictationError } = dictation;
  useEffect(() => {
    if (!dictationError || dictationError.kind === "permission") return;
    const timer = setTimeout(dismissDictationError, NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [dictationError, dismissDictationError]);
  const setPage = (next: number) => {
    setDirection(next > page ? 1 : -1);
    change({ page: next });
  };
  const inline = variant === "inline";
  const questions = request.questions;
  const confirmLast = confirmSingle || questions.length > 1;
  const question = questions[Math.max(0, Math.min(page, questions.length - 1))];
  if (request.secretRequest) return <SecretQuestion key={request.requestId} variant={variant} request={request} busy={busy} submit={submit} />;
  if (request.bugReport) return <BugReportQuestion key={request.requestId} variant={variant} request={request} busy={busy} submit={submit} />;
  if (!question) return null;
  const imagesOf = (q: AgentQuestion) => images[q.id] ?? NO_IMAGES;
  const answerOf = (q: AgentQuestion) => {
    const answer = typed[q.id]?.trim();
    return [...(picked[q.id] || []), ...(answer ? [answer] : []), ...imagesOf(q).map((item) => item.name)];
  };
  function finish(next: QuestionAnswers, nextTyped = typed) {
    const answers = Object.fromEntries(
      questions.map((q) => {
        const answer = nextTyped[q.id]?.trim();
        return [q.id, [...(next[q.id] || []), ...(answer ? [answer] : [])]];
      }),
    );
    // A question answered with photos alone is answered too: the agent gets their paths.
    const open = questions.findIndex((q) => !answers[q.id]?.length && !imagesOf(q).length);
    if (open >= 0) {
      setPage(open);
      return;
    }
    const attached = Object.fromEntries(questions.flatMap((q) => (imagesOf(q).length ? [[q.id, imagesOf(q)]] : [])));
    const shown = (q: AgentQuestion) => [
      ...(q.secret ? (answers[q.id]?.length ? ["[hidden answer]"] : []) : (answers[q.id] ?? [])),
      ...(imagesOf(q).length ? [imagesLabel(imagesOf(q).length)] : []),
    ];
    submit(answers, questions.map((q) => `${q.header || q.question}: ${shown(q).join(", ")}`).join("\n"), Object.keys(attached).length ? attached : undefined);
  }
  async function attach(kind: "photos" | "camera" | "paste") {
    if (!question || picking.current) return;
    picking.current = true;
    setPickError("");
    const target = question.id;
    try {
      const added = await pickAttachments(kind);
      const photos = added.filter((item) => item.image);
      if (photos.length < added.length) setPickError("Only photos can go with an answer.");
      if (!photos.length) return;
      const all = Object.values(images).reduce((total, list) => total + list.length, 0);
      if (all + photos.length > MAX_IMAGES) {
        setPickError(`Attach at most ${MAX_IMAGES} photos to your answers.`);
        return;
      }
      change({ images: { ...images, [target]: [...(images[target] ?? []), ...photos] } });
    } catch (failure) {
      setPickError((failure as Error).message);
    } finally {
      picking.current = false;
    }
  }
  function removeImage(id: string) {
    if (!question) return;
    change({ images: { ...images, [question.id]: imagesOf(question).filter((item) => item.id !== id) } });
  }
  function choose(label: string) {
    if (!question) return;
    if (question.multiSelect) {
      change({
        picked: {
          ...picked,
          [question.id]: picked[question.id]?.includes(label)
            ? (picked[question.id] ?? []).filter((value) => value !== label)
            : [...(picked[question.id] || []), label],
        },
      });
      return;
    }
    setDirection(1);
    const next = { ...picked, [question.id]: [label] };
    const nextTyped = { ...typed, [question.id]: "" };
    change({
      picked: next,
      typed: nextTyped,
      page: page < questions.length - 1 ? page + 1 : page,
    });
    if (page === questions.length - 1 && !confirmLast) finish(next, nextTyped);
  }
  function startDictation(target: AgentQuestion) {
    const base = typed[target.id] ?? "";
    dictated.current = { question: target, base };
    void dictation.start({ draft: base, selection: { start: base.length, end: base.length } });
  }
  function sendTyped() {
    if (!question || dictating || (!typed[question.id]?.trim() && !imagesOf(question).length)) return;
    setDirection(1);
    const next = question.multiSelect ? picked : { ...picked, [question.id]: [] };
    change({
      picked: next,
      page: page < questions.length - 1 ? page + 1 : page,
    });
    if (page === questions.length - 1) finish(next);
  }
  const count = answerOf(question).length;
  const body = (
    <View style={{ gap: inline ? 12 : 4 }}>
      <View style={{ paddingHorizontal: inline ? 0 : 8, paddingBottom: 8, gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.ink,
            fontSize: type.body,
            fontWeight: "600",
            lineHeight: lineHeight.body,
          }}
        >
          {question.question}
        </Text>
        {question.multiSelect && <Text style={styles.caption}>Pick any that apply.</Text>}
      </View>
      <View accessibilityRole={question.multiSelect ? undefined : "radiogroup"} style={{ gap: 4 }}>
        {question.options.map((option, index) => {
          const on = !!picked[question.id]?.includes(option.label);
          const recommended = RECOMMENDED.test(option.label);
          return (
            <Pressable
              key={option.label}
              accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
              accessibilityState={{ checked: on, disabled: busy }}
              disabled={busy}
              onPress={() => choose(option.label)}
              style={({ pressed }) => [
                {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: radius.card,
                  borderCurve: "continuous",
                  borderWidth: on ? 1.5 : 1,
                  borderColor: on ? colors.ink : colors.line,
                  backgroundColor: on ? colors.surface : colors.page,
                },
                pressStyle({ pressed, disabled: busy, kind: "row" }),
              ]}
            >
              <View
                style={{
                  minWidth: 24,
                  minHeight: 24,
                  borderRadius: question.multiSelect ? radius.chip : radius.full,
                  borderCurve: "continuous",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: on ? colors.ink : colors.surface,
                  borderWidth: on ? 0 : 1,
                  borderColor: colors.lineStrong,
                }}
              >
                {on && question.multiSelect ? (
                  <Icon icon={Tick02Icon} tone="onInk" size={16} />
                ) : (
                  <Text
                    maxFontSizeMultiplier={1.3}
                    style={{
                      color: on ? colors.onInk : colors.ink2,
                      fontSize: type.footnote,
                      lineHeight: lineHeight.footnote,
                      fontWeight: "600",
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {index + 1}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <Text
                    style={{
                      color: colors.ink,
                      fontSize: type.subheadline,
                      lineHeight: lineHeight.subheadline,
                      fontWeight: "500",
                    }}
                  >
                    {option.label.replace(RECOMMENDED, "")}
                  </Text>
                  {recommended && <Tag label="Recommended" />}
                </View>
                {!!option.description && (
                  <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{option.description}</Text>
                )}
              </View>
            </Pressable>
          );
        })}
        {(question.allowOther || !question.options.length) && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              minHeight: 48,
              paddingLeft: 12,
              paddingRight: 6,
              borderRadius: radius.card,
              borderCurve: "continuous",
              borderWidth: typed[question.id] ? 1.5 : 1,
              borderColor: typing ? colors.accent : typed[question.id] ? colors.ink : colors.line,
              backgroundColor: typed[question.id] ? colors.surface : colors.page,
            }}
          >
            <View style={{ width: 24, alignItems: "center" }}>
              <Icon icon={PencilEdit02Icon} tone="ink2" size={16} />
            </View>
            {/* ponytail: a bare TextInput, as Field `bare` would draw it; the bordered row is its field. */}
            <TextInput
              accessibilityLabel={`Your own answer to: ${question.question}`}
              placeholder="Type your answer…"
              placeholderTextColor={colors.ink3}
              selectionColor={colors.accent}
              autoCorrect={!inline}
              secureTextEntry={question.secret}
              value={typed[question.id] || ""}
              onChangeText={(text) => setTyped(question, text)}
              onSubmitEditing={sendTyped}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
              returnKeyType="send"
              editable={!busy}
              style={{ flex: 1, minHeight: 44, color: colors.ink, fontSize: type.subheadline, paddingVertical: 12 }}
            />
            {!question.secret && dictation.available && (
              <View style={{ position: "relative" }}>
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
                    onDiscard={() => void dictation.cancel()}
                    onStop={() => void dictation.stop()}
                  />
                ) : (
                  <VoiceMicButton onPress={() => startDictation(question)} />
                )}
              </View>
            )}
            {!question.secret && !dictating && (
              <PullDown
                label="Attach photos to your answer"
                nativeTrigger={{ systemImage: "photo", disabled: busy }}
                sections={[
                  {
                    items: [
                      { id: "photos", title: "Photo Library", systemImage: "photo.on.rectangle", disabled: busy },
                      { id: "camera", title: "Take Photo", systemImage: "camera", disabled: busy },
                      { id: "paste", title: "Paste image", systemImage: "doc.on.clipboard", disabled: busy },
                    ],
                  },
                ]}
                onSelect={(kind) => void attach(kind as "photos" | "camera" | "paste")}
              >
                <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", opacity: busy ? 0.35 : 1 }}>
                  <Icon icon={Image01Icon} tone="ink2" size={18} />
                </View>
              </PullDown>
            )}
            {(!!typed[question.id]?.trim() || imagesOf(question).length > 0) && !question.multiSelect && !dictating && (
              <IconButton label="Send answer" icon={ArrowUp01Icon} filled size={32} onPress={sendTyped} disabled={busy} />
            )}
          </View>
        )}
        {imagesOf(question).length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 4 }}>
            {imagesOf(question).map((item) => (
              <View key={item.id} style={{ width: 64, height: 64 }}>
                <Image
                  source={{ uri: item.uri }}
                  accessibilityLabel={item.name}
                  style={{ width: 64, height: 64, borderRadius: radius.control, backgroundColor: colors.field }}
                />
                <View style={{ position: "absolute", top: -10, right: -10 }}>
                  <IconButton label={`Remove ${item.name}`} icon={Cancel01Icon} filled size={32} disabled={busy} onPress={() => removeImage(item.id)} />
                </View>
              </View>
            ))}
          </View>
        )}
        <InlineError message={pickError} style={{ paddingHorizontal: inline ? 0 : 4 }} />
      </View>
      {(question.multiSelect || (confirmLast && page === questions.length - 1)) && (
        <PillButton
          title={
            confirmLast
              ? questions.length > 1
                ? "Send answers"
                : "Send answer"
              : count
                ? `Send ${count} answer${count === 1 ? "" : "s"}`
                : "Pick at least one"
          }
          disabled={busy || !count || dictating}
          loading={busy}
          onPress={() => finish(picked)}
          style={{ marginTop: 6 }}
        />
      )}
    </View>
  );
  return (
    <View
      accessibilityLabel="Agent question"
      style={
        inline
          ? { gap: 12 }
          : {
              backgroundColor: colors.surface,
              borderRadius: radius.composer,
              borderCurve: "continuous",
              padding: 8,
              gap: 4,
              boxShadow: colors.shadowOverlay,
            }
      }
    >
      {questions.length > 1 && (
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 2 }}>
          {questions.length > 1 &&
            (inline ? (
              <InboxPager index={page} count={questions.length} select={setPage} label="question" />
            ) : (
              <>
                <IconButton label="Previous question" icon={ArrowLeft01Icon} size={32} disabled={page === 0} onPress={() => setPage(page - 1)} />
                <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
                  {page + 1} of {questions.length}
                </Text>
                <IconButton
                  label="Next question"
                  icon={ArrowRight01Icon}
                  size={32}
                  disabled={page === questions.length - 1}
                  onPress={() => setPage(page + 1)}
                />
              </>
            ))}
          <View style={{ flex: 1 }} />
        </View>
      )}
      {inline ? (
        <InboxPage pageKey={question.id} direction={direction}>
          {body}
        </InboxPage>
      ) : (
        body
      )}
    </View>
  );
}

/** Desktop's approval card: what the agent wants to run or change, then Deny, Always allow in this Chat, and Allow once. */
export function Approval({
  approval,
  busy,
  respond,
  variant = "card",
}: {
  approval: PermissionRequest;
  busy: boolean;
  respond: (decision: PermissionDecision) => void;
  variant?: "card" | "inline";
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const inline = variant === "inline";
  const parameters = [
    ["To", approval.delegation?.target],
    ["Message", approval.delegation?.message],
    ["Project", approval.setup?.projectPath],
    ["Source", approval.setup?.source],
    ["Computer", approval.setup?.computer],
    ["Command", approval.command],
    ["Folder", approval.cwd],
    [approval.files?.length === 1 ? "File" : "Files", approval.files?.join("\n")],
    ["Changes", approval.diff],
    ["Details", approval.detail],
    ["Reason", approval.reason],
  ].filter((pair): pair is [string, string] => !!pair[1]);
  return (
    <View
      accessibilityLabel="Tool approval"
      style={
        inline
          ? { gap: 16 }
          : {
              backgroundColor: colors.surface,
              borderRadius: radius.sheet,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: colors.lineStrong,
              padding: 16,
              gap: 12,
            }
      }
    >
      <View style={{ gap: 4 }}>
        {inline && <Text style={styles.caption}>{approval.tool}</Text>}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {!inline && <Icon icon={ShieldAlertIcon} tone="orange" size={16} />}
          <Text
            accessibilityRole="header"
            style={{
              color: colors.ink,
              fontSize: type.body,
              lineHeight: lineHeight.body,
              fontWeight: "600",
              flex: 1,
            }}
          >
            {approval.title}
          </Text>
        </View>
        {!!approval.description && <Text style={styles.muted}>{approval.description}</Text>}
        {approval.delegation?.negotiation && <Text style={styles.caption}>Negotiation, up to {NEGOTIATION_ROUNDS} rounds.</Text>}
      </View>
      {parameters.map(([label, text]) => (
        <View key={label} style={{ gap: 4 }}>
          <Text style={styles.caption}>{label}</Text>
          <Text
            selectable
            style={
              label === "Command" || label === "Changes" || label === "Details"
                ? [styles.code, { fontSize: type.caption1, lineHeight: lineHeight.caption1 }]
                : styles.muted
            }
          >
            {text}
          </Text>
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <PillButton
          title={approval.kind === "setup" ? SETUP_APPROVAL_COPY.deny : "Deny"}
          secondary
          disabled={busy}
          onPress={() => respond("deny")}
          style={{ flex: 1 }}
        />
        <PillButton
          title={approval.kind === "setup" ? SETUP_APPROVAL_COPY.allow : "Allow once"}
          disabled={busy}
          onPress={() => respond("allow")}
          style={{ flex: 1 }}
        />
      </View>
      {approval.allowForChat && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => respond("allow-for-chat")}
          style={({ pressed }) => [
            {
              alignSelf: "center",
              minHeight: 44,
              justifyContent: "center",
            },
            pressStyle({ pressed, disabled: busy }),
          ]}
        >
          <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>
            {approval.kind === "setup"
              ? SETUP_APPROVAL_COPY.always
              : approval.delegation?.computer
                ? `Always allow for ${approval.delegation.computer} in this Chat`
                : approval.kind === "delegation"
                  ? "Always allow for this Link in this Chat"
                  : "Always allow in this Chat"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function ActivityQuestions(
  props: Parameters<typeof Questions>[0] & {
    hostId: string;
    projectPath: string;
    sessionId: number;
  },
) {
  const [initialAnswers] = useState(() => takeActivityDraft(props.hostId, props.projectPath, props.sessionId, props.request.requestId));
  return <Questions {...props} initialAnswers={initialAnswers} />;
}
