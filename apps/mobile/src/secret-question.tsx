import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Clock01Icon, LockKeyIcon, ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import type { QuestionAnswers, QuestionRequest } from "@milagre/shared/model";
import { formatCountdown } from "@milagre/shared/display-clock";
import { Icon } from "./icons";
import { PageScroll, PillButton } from "./ui";
import { useTheme } from "./theme";
import { useDisplayNow, useScreenActive } from "./display-clock";
import { radius, type } from "./design-tokens";

/** The last minute reads in the attention tone, so a running-out request is noticed before it closes. */
const URGENT_MS = 60_000;

/**
 * A secret never enters the inbox's saved drafts or the ordinary answer summary.
 * "card" sits in the Chat like the question card; "inline" goes inside an inbox card, which brings its own frame.
 */
export function SecretQuestion({
  request,
  busy,
  submit,
  variant = "card",
}: {
  request: QuestionRequest;
  busy: boolean;
  submit: (answers: QuestionAnswers | null, summary: string) => void;
  variant?: "card" | "inline";
}) {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  const { colors } = useTheme();
  const active = useScreenActive();
  const deadline = request.secretRequest?.expiresAt;
  const now = useDisplayNow(1000, deadline !== undefined && !busy);
  const expired = deadline !== undefined && now >= deadline;
  const urgent = deadline !== undefined && deadline - now <= URGENT_MS;
  const description = request.secretRequest?.description.trim();
  if ((!active || expired) && revealed) setRevealed(false);
  if (expired && value) setValue("");
  const answer = (given: QuestionAnswers | null) => {
    setValue("");
    setRevealed(false);
    submit(given, "");
  };
  const save = () => {
    if (!busy && value.trim() && (deadline === undefined || Date.now() < deadline)) answer({ secret: [value] });
  };
  return (
    <View
      accessibilityLabel="Secret request"
      style={
        variant === "inline"
          ? { gap: 16 }
          : {
              gap: 16,
              padding: 16,
              borderRadius: radius.sheet,
              borderCurve: "continuous",
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.lineStrong,
              boxShadow: "0 8px 28px #00000017",
            }
      }
    >
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon icon={LockKeyIcon} size={14} tone="ink3" />
          <Text style={{ color: colors.ink3, fontSize: type.footnote, fontWeight: "600" }}>Private entry</Text>
        </View>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.body, fontWeight: "600", lineHeight: 22 }}>
          {request.questions[0]?.question}
        </Text>
        {!!description && (
          <PageScroll
            nestedScrollEnabled
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={{ padding: 0, paddingBottom: 0 }}
            style={{ maxHeight: 120 }}
          >
            <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: 20 }}>{description}</Text>
          </PageScroll>
        )}
      </View>
      <View style={{ gap: 6 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            minHeight: 50,
            borderRadius: radius.card,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: focused ? colors.accent : colors.line,
            backgroundColor: colors.page,
          }}
        >
          <TextInput
            accessibilityLabel="Secret"
            placeholder="Paste or type the secret"
            placeholderTextColor={colors.ink3}
            secureTextEntry={!revealed}
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            maxLength={10000}
            value={value}
            onChangeText={setValue}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setRevealed(false);
            }}
            editable={!busy && !expired}
            returnKeyType="done"
            onSubmitEditing={save}
            style={{
              flex: 1,
              minWidth: 0,
              color: colors.ink,
              fontSize: type.body,
              padding: 12,
              paddingLeft: 16,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? "Hide secret" : "Show secret"}
            disabled={busy || expired || !value}
            onPress={() => setRevealed((current) => !current)}
            style={({ pressed }) => ({
              width: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: busy || expired || !value ? 0.4 : pressed ? 0.6 : 1,
            })}
          >
            <Icon icon={revealed ? ViewOffIcon : ViewIcon} size={20} tone="ink2" />
          </Pressable>
        </View>
        {deadline !== undefined && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 4 }}>
            <Icon icon={Clock01Icon} size={14} tone={urgent ? "orangeInk" : "ink3"} />
            <Text
              accessibilityRole="timer"
              style={{
                color: urgent ? colors.orangeInk : colors.ink3,
                fontSize: type.footnote,
                fontVariant: ["tabular-nums"],
              }}
            >
              {expired ? "Request expired" : `${formatCountdown(deadline - now)} left to enter`}
            </Text>
          </View>
        )}
      </View>
      <View style={{ gap: 8 }}>
        <PillButton
          title="Save securely"
          disabled={busy || expired || !value.trim()}
          loading={busy}
          onPress={save}
          style={{ height: "auto", minHeight: 44, paddingVertical: 12 }}
        />
        <PillButton
          title="Decline"
          secondary
          disabled={busy}
          onPress={() => answer(null)}
          style={{
            height: "auto",
            minHeight: 44,
            paddingVertical: 12,
            borderWidth: 0,
          }}
        />
      </View>
    </View>
  );
}
