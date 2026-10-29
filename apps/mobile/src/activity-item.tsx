import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { titleSpans } from "@milagre/shared/reply-parts";
import { Icon, type IconData } from "./icons";
import { ShimmerText, useShimmerReducedMotion } from "./running-logo";
import { useScreenActive } from "./display-clock";
import { fonts, useTheme } from "./theme";
import { PageScroll, useStyles } from "./ui";

type ActivityState = "idle" | "running" | "waiting" | "failed";
const TITLE_LINE = 20;

/** Activity titles share code chips and the running shimmer, including reduced-motion handling. */
export function ActivityTitle({
  title,
  shimmer,
  numberOfLines = 1,
  style: styleProp,
}: {
  title: string;
  shimmer: boolean;
  numberOfLines?: number;
  style?: TextStyle;
}) {
  const { colors } = useTheme();
  const active = useScreenActive();
  const reduced = useShimmerReducedMotion(active && shimmer);
  const sweeping = shimmer && active && !reduced;
  const style = styleProp ?? { color: colors.ink2, fontSize: 14 };
  const spans = (moving: boolean) =>
    titleSpans(title).map((span, index) =>
      span.code ? (
        <Text
          key={index}
          style={{
            fontFamily: fonts.mono,
            fontSize: (style.fontSize || 14) * 0.92,
            backgroundColor: moving ? undefined : colors.field,
            color: shimmer ? colors.ink3 : colors.ink,
          }}
        >
          {span.text}
        </Text>
      ) : (
        span.text
      ),
    );
  return sweeping ? (
    <ShimmerText settledChildren={spans(false)} style={style} numberOfLines={numberOfLines}>
      {spans(true)}
    </ShimmerText>
  ) : (
    <Text selectable numberOfLines={numberOfLines} style={[style, shimmer && { color: colors.ink3 }]}>
      {spans(false)}
    </Text>
  );
}

/** Shared tool/subagent disclosure. Adapters supply their data and output; presentation lives here. */
export function ActivityItem({
  title,
  icon,
  leading,
  summary,
  duration,
  error,
  state = "idle",
  status,
  note,
  children,
  loading = false,
  onPress,
  disclosureOnly = false,
  expanded: expandedByDefault = false,
}: {
  title: string;
  icon: IconData;
  leading?: ReactNode;
  summary?: string;
  duration?: string;
  error?: string;
  state?: ActivityState;
  status?: string;
  note?: string;
  children?: ReactNode;
  loading?: boolean;
  onPress?: () => void;
  disclosureOnly?: boolean;
  /** Open until the row is tapped; follows changes until then. */
  expanded?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? expandedByDefault;
  const expandable = !onPress && (children != null || loading);
  const failed = state === "failed";
  const stateLabel = status || (failed ? "Failed" : state === "waiting" ? "Waiting for approval" : state === "running" ? "Running" : "");
  const label = [title.replace(/`/g, ""), stateLabel, note].filter(Boolean).join(", ");
  const action = () => (onPress ? onPress() : setToggled(!expanded));
  const accessibilityState = expandable ? { expanded } : undefined;
  const headerStyle: ViewStyle = { minHeight: 44, paddingVertical: disclosureOnly ? 0 : 8, flexDirection: "row", alignItems: "center", gap: 10 };
  // The icon sits in a box one title line tall, so it centers on the first line whether the title wraps or not.
  const heading = (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <View style={{ height: TITLE_LINE, justifyContent: "center" }}>
        {leading ?? <Icon icon={failed ? Alert02Icon : icon} tone={failed ? "red" : "ink2"} size={16} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <ActivityTitle
          title={title}
          shimmer={state === "running"}
          numberOfLines={disclosureOnly && expanded ? 0 : 1}
          style={{ color: colors.ink2, fontSize: 14, lineHeight: TITLE_LINE }}
        />
        {!!note && <Text style={styles.label}>{note}</Text>}
      </View>
    </View>
  );
  const trailing = (
    <>
      {!!summary && (
        <Text numberOfLines={1} style={{ maxWidth: 120, flexShrink: 1, color: failed ? colors.redInk : colors.ink3, fontSize: 12 }}>
          {summary}
        </Text>
      )}
      {!!status && <Text style={{ color: failed ? colors.redInk : state === "waiting" ? colors.orangeInk : colors.ink3, fontSize: 12 }}>{status}</Text>}
      {(onPress || expandable) &&
        (onPress ? (
          <Icon icon={ArrowRight01Icon} tone="ink3" size={12} />
        ) : (
          <View style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}>
            <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
          </View>
        ))}
      {!!duration && <Text style={{ color: colors.ink3, fontSize: 12, fontVariant: ["tabular-nums"] }}>{duration}</Text>}
    </>
  );
  return (
    <View style={{ gap: 8 }}>
      {disclosureOnly ? (
        <View style={headerStyle}>
          {heading}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? "Hide" : "Show"} details for ${label}`}
            accessibilityState={accessibilityState}
            disabled={!expandable}
            onPress={action}
            hitSlop={4}
            style={({ pressed }) => ({
              flexDirection: "row",
              gap: 4,
              paddingLeft: 4,
              minWidth: 44,
              minHeight: 36,
              alignItems: "center",
              justifyContent: "flex-end",
              opacity: pressed ? 0.5 : 1,
            })}
          >
            {trailing}
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole={onPress || expandable ? "button" : "text"}
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          disabled={!onPress && !expandable}
          onPress={action}
          style={({ pressed }) => [headerStyle, { opacity: pressed ? 0.5 : 1 }]}
        >
          {heading}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>{trailing}</View>
        </Pressable>
      )}
      {!!error && (
        <Text
          selectable
          style={[styles.code, { marginLeft: 26, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: colors.red, color: colors.ink2, fontSize: 12 }]}
        >
          {error}
        </Text>
      )}
      {!onPress && expanded && expandable && (
        <PageScroll
          nestedScrollEnabled
          style={{ maxHeight: 320, backgroundColor: colors.field, borderRadius: 12, marginBottom: 8 }}
          contentContainerStyle={{ padding: 12, paddingBottom: 12, gap: 8 }}
        >
          {children ?? <Text style={styles.muted}>Loading output…</Text>}
        </PageScroll>
      )}
    </View>
  );
}
