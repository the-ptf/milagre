import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Bug01Icon, PencilEdit02Icon, ViewIcon } from "@hugeicons/core-free-icons";
import type { QuestionAnswers, QuestionRequest } from "@milagre/shared/model";
import { reportSegments } from "@milagre/shared/bug-report";
import { Icon } from "./icons";
import { PageScroll, PillButton } from "./ui";
import { fonts, useTheme } from "./theme";
import { lineHeight, radius, type } from "./design-tokens";

const TITLE_LIMIT = 160;

/**
 * A Milagre bug report waiting for the user (bug-reports.cjs), as desktop's BugReportCard: the exact title and text that
 * go to Milagre's public tracker, placeholders marked, editable before Post. An edit with more private details comes back
 * from the host redacted, as a new card. "card" sits in the Chat like the question card; "inline" goes inside an inbox
 * card, which brings its own frame.
 */
export function BugReportQuestion({
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
  const { colors } = useTheme();
  const report = request.bugReport!;
  const [title, setTitle] = useState(report.title);
  const [body, setBody] = useState(report.body);
  const [editing, setEditing] = useState(false);
  const replaced = report.redactions ?? 0;
  const ready = !busy && title.trim().length > 0 && title.length <= TITLE_LIMIT && body.trim().length > 0;
  const field = {
    borderRadius: radius.card,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.page,
  };
  return (
    <View
      accessibilityLabel="Milagre bug report"
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
          <Icon icon={Bug01Icon} size={12} tone="ink3" />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink3, fontSize: type.footnote, fontWeight: "600" }}>
            {report.repo}
          </Text>
        </View>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.body, fontWeight: "600", lineHeight: 22 }}>
          Report a Milagre bug
        </Text>
        <Text style={{ color: report.recheck ? colors.orangeInk : colors.ink2, fontSize: type.subheadline, lineHeight: 20 }}>
          {report.recheck
            ? "Your edit had more private details. Milagre replaced them; check the text again."
            : `This exact text goes to Milagre's public tracker under your GitHub account. ${
                replaced === 1 ? "1 private detail was" : `${replaced} private details were`
              } replaced with placeholders.`}
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.ink2, fontSize: type.footnote, fontWeight: "600", paddingLeft: 4 }}>Title</Text>
        <TextInput
          accessibilityLabel="Report title"
          value={title}
          onChangeText={setTitle}
          maxLength={TITLE_LIMIT}
          editable={!busy}
          autoCorrect={false}
          style={{ ...field, minHeight: 44, color: colors.ink, fontSize: type.callout, paddingHorizontal: 14, paddingVertical: 10 }}
        />
      </View>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: colors.ink2, fontSize: type.footnote, fontWeight: "600", paddingLeft: 4 }}>Report</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: editing, disabled: busy }}
            disabled={busy}
            onPress={() => setEditing((current) => !current)}
            hitSlop={8}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32, opacity: busy ? 0.4 : pressed ? 0.6 : 1 })}
          >
            <Icon icon={editing ? ViewIcon : PencilEdit02Icon} size={16} tone="ink2" />
            <Text style={{ color: colors.ink2, fontSize: type.footnote, fontWeight: "600" }}>{editing ? "Preview" : "Edit"}</Text>
          </Pressable>
        </View>
        {editing ? (
          <TextInput
            accessibilityLabel="Report text"
            value={body}
            onChangeText={setBody}
            editable={!busy}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
            textAlignVertical="top"
            style={{
              ...field,
              minHeight: 200,
              maxHeight: 280,
              color: colors.ink,
              fontFamily: fonts.mono,
              fontSize: type.caption1,
              lineHeight: lineHeight.footnote,
              padding: 12,
            }}
          />
        ) : (
          <PageScroll
            nestedScrollEnabled
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={{ padding: 12, paddingBottom: 12 }}
            style={{ ...field, maxHeight: 280 }}
          >
            <Text selectable style={{ color: colors.ink, fontFamily: fonts.mono, fontSize: type.caption1, lineHeight: lineHeight.footnote }}>
              {reportSegments(body).map((segment, index) =>
                segment.placeholder ? (
                  <Text key={index} style={{ color: colors.ink2, backgroundColor: colors.hover }}>
                    {segment.text}
                  </Text>
                ) : (
                  segment.text
                ),
              )}
            </Text>
          </PageScroll>
        )}
      </View>
      <View style={{ gap: 8 }}>
        <PillButton
          title="Post to GitHub"
          disabled={!ready}
          loading={busy}
          onPress={() => ready && submit({ title: [title.trim()], body: [body] }, "")}
          style={{ height: "auto", minHeight: 44, paddingVertical: 12 }}
        />
        <PillButton
          title="Cancel"
          secondary
          disabled={busy}
          onPress={() => submit(null, "")}
          style={{ height: "auto", minHeight: 44, paddingVertical: 12, borderWidth: 0 }}
        />
      </View>
    </View>
  );
}
