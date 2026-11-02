import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Polyline, Rect, Text as SvgText } from "react-native-svg";
import type { GenuiProps } from "@milagre/shared/genui";
import { useTheme } from "../theme";
import { lineHeight, radius, type } from "../design-tokens";

import { CHART_WIDTH as WIDTH, CHART_HEIGHT as HEIGHT, CHART_PAD as PAD, chartGeometry } from "@milagre/shared/genui";

function Labels({ labels, slot, color }: { labels: readonly string[]; slot: number; color: string }) {
  const every = Math.max(1, Math.ceil(48 / slot));
  return (
    <>
      {labels.map((label, index) =>
        index % every === 0 ? (
          <SvgText key={index} x={PAD.left + slot * index + slot / 2} y={HEIGHT - 6} textAnchor="middle" fontSize={type.caption2} fill={color}>
            {label.length > 8 ? `${label.slice(0, 7)}…` : label}
          </SvgText>
        ) : null,
      )}
    </>
  );
}

/** What a screen reader reads for a chart: its title, then each label with its value. */
const summary = (title: string | undefined, labels: readonly string[], values: readonly number[]) =>
  `${title ?? "Chart"}: ${values.map((value, index) => `${labels[index] ?? index + 1} ${value}`).join(", ")}`;

function Frame({ title, label, children }: { title?: string; label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.surface,
        padding: 12,
        gap: 6,
      }}
    >
      {title && <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>{title}</Text>}
      {/* Scales with the column at its own proportions, so an iPad's labels and dots don't stretch sideways. */}
      <View style={{ width: "100%", maxWidth: 448, aspectRatio: WIDTH / HEIGHT }}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          {children}
        </Svg>
      </View>
    </View>
  );
}

export function BarChart({ labels, values, title }: GenuiProps<"BarChart">) {
  const { colors } = useTheme();
  const { slot, y, zero } = chartGeometry(values);
  return (
    <Frame title={title} label={summary(title, labels, values)}>
      {values.map((value, index) => (
        <Rect
          key={index}
          x={PAD.left + slot * index + slot * 0.15}
          y={Math.min(y(value), zero)}
          width={slot * 0.7}
          height={Math.max(1, Math.abs(zero - y(value)))}
          rx={2}
          fill={colors.accent}
        />
      ))}
      <Labels labels={labels.slice(0, values.length)} slot={slot} color={colors.ink3} />
    </Frame>
  );
}

export function LineChart({ labels, values, title }: GenuiProps<"LineChart">) {
  const { colors } = useTheme();
  const { slot, y } = chartGeometry(values);
  const points = values.map((value, index) => `${PAD.left + slot * index + slot / 2},${y(value)}`).join(" ");
  return (
    <Frame title={title} label={summary(title, labels, values)}>
      <Polyline points={points} fill="none" stroke={colors.accent} strokeWidth={2} strokeLinejoin="round" />
      {values.map((value, index) => (
        <Circle key={index} cx={PAD.left + slot * index + slot / 2} cy={y(value)} r={2.5} fill={colors.accent} />
      ))}
      <Labels labels={labels.slice(0, values.length)} slot={slot} color={colors.ink3} />
    </Frame>
  );
}
