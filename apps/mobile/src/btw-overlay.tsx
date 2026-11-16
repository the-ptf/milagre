import { Pressable, Text, View } from "react-native";
import { Cancel01Icon, MessageSquareQuoteIcon, StopIcon } from "@hugeicons/core-free-icons";
import type { BtwState } from "@milagre/shared/model";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon, SpinnerRing } from "./icons";
import { Markdown } from "./markdown";
import { useTheme } from "./theme";
import { IconButton, PageScroll, pressStyle, tap, useStyles } from "./ui";

export function BtwOverlay({
  btw,
  onDismiss,
  onStop,
  onBringBack,
}: {
  btw: BtwState;
  onDismiss: () => void;
  onStop: () => void;
  onBringBack?: (text: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const running = btw.status === "running";
  const hasText = Boolean(btw.text.trim());

  return (
    <View
      accessibilityLabel="Side question"
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.sheet,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.lineStrong,
        boxShadow: colors.shadowRaised,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingLeft: space.xl,
          paddingRight: space.md,
          paddingVertical: space.sm,
          borderBottomWidth: 1,
          borderColor: colors.line,
        }}
      >
        <View
          style={{
            backgroundColor: colors.field,
            borderRadius: radius.chip,
            borderCurve: "continuous",
            paddingHorizontal: space.sm,
            paddingVertical: space.xxs,
          }}
        >
          <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>/btw</Text>
        </View>
        <View style={{ flex: 1 }} />
        {running && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop side question"
            onPress={() => {
              tap();
              onStop();
            }}
            style={({ pressed }) => [
              { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md },
              pressStyle({ pressed }),
            ]}
          >
            <Icon icon={StopIcon} tone="ink2" size={12} />
            <Text style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "600" }}>Stop</Text>
          </Pressable>
        )}
        {!running && hasText && onBringBack && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Bring back into composer"
            onPress={() => {
              tap();
              onBringBack(btw.text.trim());
              onDismiss();
            }}
            style={({ pressed }) => [
              { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md },
              pressStyle({ pressed }),
            ]}
          >
            <Icon icon={MessageSquareQuoteIcon} tone="ink2" size={12} />
            <Text style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "600" }}>Bring back</Text>
          </Pressable>
        )}
        <IconButton label="Dismiss side answer" icon={Cancel01Icon} size={44} onPress={onDismiss} />
      </View>
      <Text
        style={{
          color: colors.ink,
          fontSize: type.subheadline,
          lineHeight: lineHeight.subheadline,
          fontWeight: "500",
          paddingHorizontal: space.xl,
          paddingTop: space.md,
        }}
      >
        {btw.question}
      </Text>
      <PageScroll
        style={{ maxHeight: 220 }}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {hasText ? (
          <Markdown text={btw.text} streaming={running} />
        ) : running ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <SpinnerRing size={12} tone="ink3" />
            <Text style={styles.caption}>{btw.steps.findLast((step) => step.status === "running")?.title || "Thinking\u2026"}</Text>
          </View>
        ) : btw.status === "failed" ? (
          <Text style={{ color: colors.redInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{btw.error || "Side question failed."}</Text>
        ) : btw.status === "cancelled" ? (
          <Text style={styles.caption}>Stopped.</Text>
        ) : (
          <Text style={styles.caption}>No text response.</Text>
        )}
      </PageScroll>
    </View>
  );
}
