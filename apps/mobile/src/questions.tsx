import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ArrowLeft01Icon, ArrowRight01Icon, ArrowUp01Icon, PencilEdit02Icon, ShieldAlertIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { AgentQuestion, PermissionDecision, PermissionRequest, QuestionAnswers, QuestionRequest } from "@milagre/shared/model";
import { NEGOTIATION_ROUNDS } from "@milagre/shared/limits";
import { takeActivityDraft } from "./activity-drafts";
import { Icon } from "./icons";
import { InboxPage, InboxPager } from "./inbox-motion";
import { IconButton, PillButton, useStyles } from "./ui";
import { useTheme } from "./theme";

export type InboxQuestionDraft = {
  page: number;
  picked: QuestionAnswers;
  typed: Record<string, string>;
};

const RECOMMENDED = /\s*\((recommended)\)\s*$/i;

/**
 * The agent's questions, Claude-style: the card takes the composer's place, one question at a time.
 * A single-choice pick answers and moves on; multi-select gets a Send button; the last row types an answer.
 */
export function Questions({
  request,
  busy,
  initialAnswers = {},
  confirmSingle = false,
  submit,
  variant = "card",
  draft,
  onDraftChange,
}: {
  variant?: "card" | "inline";
  draft?: InboxQuestionDraft;
  onDraftChange?: (draft: InboxQuestionDraft) => void;
  request: QuestionRequest;
  busy: boolean;
  initialAnswers?: QuestionAnswers;
  /** The inbox keeps the choice editable until Send, like desktop's inbox. */
  confirmSingle?: boolean;
  submit: (answers: QuestionAnswers | null, summary: string) => void;
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
  const { page, picked, typed } = current;
  const change = (patch: Partial<InboxQuestionDraft>) => {
    if (onDraftChange) onDraftChange({ ...current, ...patch });
    else setLocalDraft((previous) => ({ ...previous, ...patch }));
  };
  const [direction, setDirection] = useState(1);
  const setPage = (next: number) => {
    setDirection(next > page ? 1 : -1);
    change({ page: next });
  };
  const inline = variant === "inline";
  const questions = request.questions;
  const question = questions[Math.min(page, questions.length - 1)];
  const answerOf = (q: AgentQuestion) => [...(picked[q.id] || []), ...(typed[q.id]?.trim() ? [typed[q.id].trim()] : [])];
  function finish(next: QuestionAnswers, nextTyped = typed) {
    const answers = Object.fromEntries(questions.map((q) => [q.id, [...(next[q.id] || []), ...(nextTyped[q.id]?.trim() ? [nextTyped[q.id].trim()] : [])]]));
    const open = questions.findIndex((q) => !answers[q.id].length);
    if (open >= 0) {
      setPage(open);
      return;
    }
    submit(answers, questions.map((q) => `${q.header || q.question}: ${q.secret ? "[hidden answer]" : answers[q.id].join(", ")}`).join("\n"));
  }
  function choose(label: string) {
    if (question.multiSelect) {
      change({
        picked: {
          ...picked,
          [question.id]: picked[question.id]?.includes(label)
            ? picked[question.id].filter((value) => value !== label)
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
    if (page === questions.length - 1 && !confirmSingle) finish(next, nextTyped);
  }
  function sendTyped() {
    if (!typed[question.id]?.trim()) return;
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
    <View style={{ gap: inline ? 10 : 4 }}>
      <View style={{ paddingHorizontal: inline ? 0 : 10, paddingBottom: 8, gap: 3 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.ink,
            fontSize: 17,
            fontWeight: "600",
            lineHeight: 22,
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
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 11,
                paddingHorizontal: 12,
                borderRadius: 14,
                borderCurve: "continuous",
                borderWidth: on ? 1.5 : 1,
                borderColor: on ? colors.ink : colors.line,
                backgroundColor: on ? colors.surface : colors.page,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: question.multiSelect ? 7 : 13,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: on ? colors.ink : colors.surface,
                  borderWidth: on ? 0 : 1,
                  borderColor: colors.lineStrong,
                }}
              >
                {on && question.multiSelect ? (
                  <Icon icon={Tick02Icon} tone="onInk" size={15} strokeWidth={2.4} />
                ) : (
                  <Text
                    style={{
                      color: on ? colors.onInk : colors.ink2,
                      fontSize: 13,
                      fontWeight: "600",
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
                      fontSize: 15,
                      fontWeight: "500",
                    }}
                  >
                    {option.label.replace(RECOMMENDED, "")}
                  </Text>
                  {recommended && (
                    <View
                      style={{
                        paddingHorizontal: 6,
                        paddingVertical: 1,
                        borderRadius: 6,
                        backgroundColor: colors.accentTint,
                      }}
                    >
                      <Text
                        style={{
                          color: colors.accentInk,
                          fontSize: 10,
                          fontWeight: "600",
                        }}
                      >
                        Recommended
                      </Text>
                    </View>
                  )}
                </View>
                {!!option.description && <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{option.description}</Text>}
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
              minHeight: 50,
              paddingLeft: 12,
              paddingRight: 6,
              borderRadius: 14,
              borderCurve: "continuous",
              borderWidth: typed[question.id] ? 1.5 : 1,
              borderColor: typed[question.id] ? colors.ink : colors.line,
              backgroundColor: typed[question.id] ? colors.surface : colors.page,
            }}
          >
            <View style={{ width: 26, alignItems: "center" }}>
              <Icon icon={PencilEdit02Icon} tone="ink2" size={16} />
            </View>
            <TextInput
              accessibilityLabel={`Your own answer to: ${question.question}`}
              placeholder="Type your answer…"
              placeholderTextColor={colors.ink3}
              autoCorrect={!inline}
              secureTextEntry={question.secret}
              value={typed[question.id] || ""}
              onChangeText={(text) => {
                change({
                  typed: { ...typed, [question.id]: text },
                  ...(confirmSingle && !question.multiSelect ? { picked: { ...picked, [question.id]: [] } } : {}),
                });
              }}
              onSubmitEditing={sendTyped}
              returnKeyType="send"
              editable={!busy}
              style={{
                flex: 1,
                color: colors.ink,
                fontSize: 15,
                paddingVertical: 12,
              }}
            />
            {!!typed[question.id]?.trim() && !question.multiSelect && (
              <IconButton label="Send answer" icon={ArrowUp01Icon} filled size={32} onPress={sendTyped} disabled={busy} />
            )}
          </View>
        )}
      </View>
      {(question.multiSelect || (confirmSingle && page === questions.length - 1)) && (
        <PillButton
          title={confirmSingle ? "Send answer" : count ? `Send ${count} answer${count === 1 ? "" : "s"}` : "Pick at least one"}
          disabled={busy || !count}
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
          ? { gap: 10 }
          : {
              backgroundColor: colors.surface,
              borderRadius: 24,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: colors.lineStrong,
              padding: 8,
              paddingTop: 8,
              gap: 4,
              boxShadow: "0 8px 28px #00000017",
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
                <Text style={{ color: colors.ink2, fontSize: 13 }}>
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
              borderRadius: 18,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: colors.lineStrong,
              padding: 14,
              gap: 10,
            }
      }
    >
      <View style={{ gap: 5 }}>
        {inline && <Text style={styles.caption}>{approval.tool}</Text>}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {!inline && <Icon icon={ShieldAlertIcon} tone="orange" size={16} strokeWidth={2} />}
          <Text
            accessibilityRole="header"
            style={{
              color: colors.ink,
              fontSize: 17,
              fontWeight: "600",
              flex: 1,
            }}
          >
            {approval.title}
          </Text>
        </View>
        {!!approval.description && <Text style={[styles.muted, { lineHeight: 20 }]}>{approval.description}</Text>}
        {approval.delegation?.negotiation && <Text style={styles.caption}>Negotiation, up to {NEGOTIATION_ROUNDS} rounds.</Text>}
      </View>
      {parameters.map(([label, text]) => (
        <View key={label} style={{ gap: 5 }}>
          <Text style={styles.caption}>{label}</Text>
          <Text
            selectable
            style={label === "Command" || label === "Changes" || label === "Details" ? [styles.code, { fontSize: 12 }] : [styles.muted, { lineHeight: 20 }]}
          >
            {text}
          </Text>
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <PillButton title="Deny" secondary disabled={busy} onPress={() => respond("deny")} style={{ flex: 1, height: 44 }} />
        <PillButton title="Allow once" disabled={busy} onPress={() => respond("allow")} style={{ flex: 1, height: 44 }} />
      </View>
      {approval.allowForChat && (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => respond("allow-for-chat")}
          style={{
            alignSelf: "center",
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text style={{ color: colors.ink2, fontSize: 13, fontWeight: "500" }}>
            {approval.kind === "delegation" ? "Always allow for this Link in this Chat" : "Always allow in this Chat"}
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
