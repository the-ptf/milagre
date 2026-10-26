import React, { useEffect } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Alert02Icon, ArrowRight01Icon, EyeIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import type { GuideExcerpt, GuideStop, PullRequestDetail } from "@milagre/shared/pull-request-review";
import type { Client } from "./client";
import { Icon } from "./icons";
import { ErrorNotice, PageScroll, tap, useStyles } from "./ui";
import { fonts, useTheme } from "./theme";
import { usePrDetail, usePrGuide } from "./pr-store";
import { prefillChat } from "./pr-chat";
import { SmallButton } from "./pr-overview";

const ATTENTION = {
  risk: "A risk to judge",
  tradeoff: "A tradeoff to weigh",
  contract: "A contract change",
  product: "A product call",
  accessibility: "An accessibility check",
} as const;

const KIND = { contract: "Contract", implementation: "Implementation", ui: "UI", tests: "Tests", config: "Config" } as const;

export type PrGuideProps = {
  client: Client;
  cwd: string;
  number: number;
  stop: number;
  chatKey?: string;
  provider?: string;
  onChat: () => void;
  onStop: (stop: number) => void;
  onFinish: () => void;
};

/** The review guide one stop at a time: progress, what changed and why, where to look, then the next stop. */
export function PrGuideStop({ client, cwd, number, stop, chatKey, provider, onChat, onStop, onFinish }: PrGuideProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr } = usePrDetail(client, cwd, number);
  const { result, write, markRead } = usePrGuide(client, cwd, pr?.url);
  const guide = result?.ok ? result.guide : null;
  const current = guide?.stops[stop];
  useEffect(() => {
    if (current) markRead(stop);
  }, [current, stop, markRead]);

  if (!pr || !result) return <Centered>{<ActivityIndicator color={colors.ink3} />}</Centered>;
  if (!result.ok) return <ErrorNotice message={result.message} retry={() => void write(number, provider)} retryTitle="Try again" />;
  if (result.writing && !guide)
    return (
      <Centered>
        <ActivityIndicator color={colors.ink3} />
        <Text style={[styles.muted, { textAlign: "center" }]}>An agent is reading the change. The guide shows here when it is written.</Text>
      </Centered>
    );
  if (!guide || !current)
    return (
      <Centered>
        <Text style={[styles.muted, { textAlign: "center" }]}>{result.error || "This PR has no review guide yet."}</Text>
        <SmallButton title="Write a guide" filled onPress={() => void write(number, provider)} />
      </Centered>
    );

  const last = stop === guide.stops.length - 1;
  const stale = guide.headRefOid !== pr.headRefOid;
  return (
    <View style={{ flex: 1 }}>
      <PageScroll contentContainerStyle={{ gap: 16, paddingBottom: 110 }}>
        <View accessibilityLabel={`${result.read.length} of ${guide.stops.length} stops read`} style={{ flexDirection: "row", gap: 4 }}>
          {guide.stops.map((_entry, index) => (
            <View
              key={index}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                backgroundColor: index === stop ? colors.accent : result.read.includes(index) ? colors.green : colors.line,
              }}
            />
          ))}
        </View>
        {(stale || result.writing) && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 14, backgroundColor: colors.hover }}>
            <Text style={[styles.caption, { flex: 1 }]}>{result.writing ? "Rewriting for the latest push…" : "Written before the latest push."}</Text>
            {!result.writing && <SmallButton title="Rewrite" onPress={() => void write(number, provider)} />}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[styles.section, { color: colors.accentInk }]}>{KIND[current.kind]}</Text>
          {current.attention && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 8,
                height: 22,
                borderRadius: 11,
                backgroundColor: colors.orangeTint,
              }}
            >
              <Icon icon={EyeIcon} tone="orange" size={11} />
              <Text style={{ color: colors.orange, fontSize: 11, fontWeight: "600" }}>Look closely</Text>
            </View>
          )}
        </View>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 22, fontWeight: "700", lineHeight: 28 }}>
          {current.title}
        </Text>
        <Text selectable style={{ color: colors.ink2, fontSize: 16, lineHeight: 24 }}>
          {current.summary}
        </Text>
        {current.attention && (
          <View
            style={{
              flexDirection: "row",
              gap: 10,
              padding: 14,
              borderRadius: 16,
              borderCurve: "continuous",
              backgroundColor: colors.orangeTint,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.orange,
            }}
          >
            <Icon icon={Alert02Icon} tone="orange" size={18} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: colors.orange, fontSize: 14, fontWeight: "600" }}>{ATTENTION[current.attention.kind]}</Text>
              <Text selectable style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>
                {current.attention.text}
              </Text>
            </View>
          </View>
        )}
        {current.excerpts.map((excerpt) => (
          <Excerpt key={`${excerpt.path}:${excerpt.startLine}`} excerpt={excerpt} />
        ))}
        {current.files.length > 0 && (
          <View style={{ gap: 8 }}>
            <Text style={styles.label}>Also in this stop</Text>
            {current.files.map((file) => (
              <View key={file.path} style={{ gap: 2 }}>
                <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.accentInk, fontSize: 13, fontFamily: fonts.mono }}>
                  {file.path}
                </Text>
                {!!file.note && <Text style={styles.caption}>{file.note}</Text>}
              </View>
            ))}
          </View>
        )}
        {current.questions.length > 0 && (
          <View style={{ gap: 8 }}>
            <Text style={styles.label}>Questions to consider</Text>
            {current.questions.map((question) => (
              <Text key={question} selectable style={{ color: colors.ink2, fontSize: 15, lineHeight: 22 }}>
                • {question}
              </Text>
            ))}
          </View>
        )}
        {guide.notCovered.length > 0 && last && <Text style={styles.caption}>Not in the tour: {guide.notCovered.join(", ")}</Text>}
      </PageScroll>
      <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, bottom: 20, flexDirection: "row", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask in Chat about this stop"
          onPress={() => {
            tap();
            if (prefillChat(chatKey, askAbout(pr, current))) onChat();
          }}
          style={({ pressed }) => ({
            width: 52,
            height: 52,
            borderRadius: 26,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.lineStrong,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon icon={SparklesIcon} tone="accentInk" size={20} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={last ? "Finish review" : `Next stop, ${guide.stops[stop + 1]?.title ?? ""}`}
          onPress={() => {
            tap();
            if (last) onFinish();
            else onStop(stop + 1);
          }}
          style={({ pressed }) => ({
            flex: 1,
            height: 52,
            borderRadius: 26,
            paddingHorizontal: 18,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: colors.ink,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.onInk, fontSize: 12, opacity: 0.7 }}>{last ? "Last stop" : `Next · ${stop + 2} of ${guide.stops.length}`}</Text>
            <Text numberOfLines={1} style={{ color: colors.onInk, fontSize: 15, fontWeight: "600" }}>
              {last ? "Finish review" : guide.stops[stop + 1]?.title}
            </Text>
          </View>
          <Icon icon={ArrowRight01Icon} tone="onInk" size={18} />
        </Pressable>
      </View>
    </View>
  );
}

const askAbout = (pr: PullRequestDetail, stop: GuideStop) => `About "${stop.title}" in the review guide for PR #${pr.number}: `;

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 32 }}>{children}</View>;
}

/** Lines of the head commit the stop points at, the PR's own lines tinted, each lettered note marked on its line. */
function Excerpt({ excerpt }: { excerpt: GuideExcerpt }) {
  const styles = useStyles();
  const { colors, codeSize } = useTheme();
  const code = { fontFamily: fonts.mono, fontSize: codeSize, lineHeight: Math.round(codeSize * 1.5) } as const;
  const notes = new Map(excerpt.notes.map((note) => [note.line, note]));
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          borderRadius: 14,
          borderCurve: "continuous",
          overflow: "hidden",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.lineStrong,
          backgroundColor: colors.surface,
        }}
      >
        <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.caption, { paddingHorizontal: 12, paddingVertical: 8, fontFamily: fonts.mono }]}>
          {excerpt.path} · L{excerpt.startLine}–{excerpt.endLine}
        </Text>
        {excerpt.lines.map((line) => {
          const note = notes.get(line.number);
          return (
            <View key={line.number} style={{ flexDirection: "row", alignItems: "flex-start", backgroundColor: line.added ? colors.diffAdd : "transparent" }}>
              <Text style={[code, { width: 40, paddingRight: 6, textAlign: "right", color: colors.ink3, fontVariant: ["tabular-nums"] }]}>{line.number}</Text>
              <Text style={[code, { flex: 1, paddingRight: 8, color: colors.ink }]}>{line.text || " "}</Text>
              {note && <Marker letter={note.letter} />}
            </View>
          );
        })}
      </View>
      {excerpt.notes.map((note) => (
        <View key={note.letter} style={{ flexDirection: "row", gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.hover }}>
          <Marker letter={note.letter} />
          <Text selectable style={{ flex: 1, color: colors.ink2, fontSize: 14, lineHeight: 20 }}>
            {note.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Marker({ letter }: { letter: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        marginRight: 6,
        marginTop: 1,
        backgroundColor: colors.orange,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: colors.page, fontSize: 10, fontWeight: "700" }}>{letter}</Text>
    </View>
  );
}
