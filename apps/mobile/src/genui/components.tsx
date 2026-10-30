import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useIsStreaming, useTriggerAction } from "@milagre/shared/genui-renderer";
import type { ComponentRenderProps } from "@milagre/shared/genui-renderer";
import type { GenuiComponentName, GenuiProps } from "@milagre/shared/genui";
import { squareRows } from "@milagre/shared/genui";
import { useTheme } from "../theme";
import { radius } from "../design-tokens";
import { Button as UiButton, PageScroll } from "../ui";
import { BarChart, LineChart } from "./charts";

export type GenuiRenderer<K extends GenuiComponentName> = (args: ComponentRenderProps<GenuiProps<K>>) => ReactNode;

const GAP = { s: 4, m: 8, l: 16 } as const;

/** Generated UI sits in the transcript, so its text follows the chat text size (Settings › Appearance), as markdown does. */
function useChatText() {
  const { textPx, typeScale } = useTheme();
  const at = (size: number) => ({ fontSize: size, lineHeight: Math.round(size * 1.4667) });
  return { body: at(textPx), scaled: (size: number) => at(Math.round(size * typeScale)) };
}

const Stack: GenuiRenderer<"Stack"> = ({ props, renderNode }) => (
  <View
    style={{ flexDirection: props.direction === "row" ? "row" : "column", flexWrap: props.direction === "row" ? "wrap" : "nowrap", gap: GAP[props.gap ?? "m"] }}
  >
    {renderNode(props.children)}
  </View>
);

const Heading: GenuiRenderer<"Heading"> = ({ props }) => {
  const { colors } = useTheme();
  const text = useChatText();
  const level = props.level ?? 2;
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: level === 3 ? colors.ink2 : colors.ink,
        ...(level === 1 ? text.scaled(17) : level === 2 ? text.scaled(16) : text.body),
        fontWeight: level === 3 ? "500" : "600",
      }}
    >
      {props.text}
    </Text>
  );
};

const TextBlock: GenuiRenderer<"Text"> = ({ props }) => {
  const { colors } = useTheme();
  const text = useChatText();
  const tone = props.tone ?? "default";
  return <Text style={{ color: tone === "muted" ? colors.ink2 : colors.ink, fontWeight: tone === "strong" ? "500" : "400", ...text.body }}>{props.text}</Text>;
};

const KeyValue: GenuiRenderer<"KeyValue"> = ({ props }) => {
  const { colors } = useTheme();
  const text = useChatText();
  return (
    <View style={{ gap: 4 }}>
      {props.pairs.map(([key, value], index) => (
        <View key={index} style={{ flexDirection: "row", gap: 12 }}>
          <Text style={{ color: colors.ink2, ...text.body, minWidth: 96 }}>{key}</Text>
          <Text style={{ color: colors.ink, ...text.body, flex: 1 }}>{value}</Text>
        </View>
      ))}
    </View>
  );
};

const Table: GenuiRenderer<"Table"> = ({ props }) => {
  const { colors } = useTheme();
  const text = useChatText();
  const rows = squareRows(props.columns, props.rows);
  const widths = props.columns.map((column, index) =>
    Math.min(240, Math.max(80, ...[column, ...rows.map((row) => row[index] ?? "")].map((cell) => cell.length * 8 + 24))),
  );
  const cellStyle = { paddingHorizontal: 12, paddingVertical: 6, flexGrow: 1 } as const;
  return (
    <View
      style={{
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.surface,
        overflow: "hidden",
      }}
    >
      <PageScroll horizontal contentContainerStyle={{ padding: 0, paddingBottom: 0, flexGrow: 1 }}>
        <View style={{ flexGrow: 1 }}>
          <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.line }}>
            {props.columns.map((column, index) => (
              <Text key={index} style={[cellStyle, { width: widths[index], color: colors.ink2, ...text.scaled(13), fontWeight: "500" }]}>
                {column}
              </Text>
            ))}
          </View>
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={{ flexDirection: "row", borderBottomWidth: rowIndex < rows.length - 1 ? 1 : 0, borderBottomColor: colors.line }}>
              {row.map((cell, cellIndex) => (
                <Text key={cellIndex} style={[cellStyle, { width: widths[cellIndex], color: colors.ink, ...text.scaled(13) }]}>
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </PageScroll>
    </View>
  );
};

const Callout: GenuiRenderer<"Callout"> = ({ props }) => {
  const { colors } = useTheme();
  const text = useChatText();
  const tone = props.tone ?? "info";
  // Info is neutral: accent is kept for focus, links and selection.
  const tint = { info: colors.field, success: colors.greenTint, warning: colors.orangeTint, danger: colors.redTint }[tone];
  const edge = { info: colors.lineStrong, success: colors.green, warning: colors.orange, danger: colors.red }[tone];
  return (
    <View
      style={{
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: edge,
        backgroundColor: tint,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2,
      }}
    >
      {props.title && <Text style={{ color: colors.ink, ...text.body, fontWeight: "500" }}>{props.title}</Text>}
      <Text style={{ color: colors.ink, ...text.body }}>{props.body}</Text>
    </View>
  );
};

const Progress: GenuiRenderer<"Progress"> = ({ props }) => {
  const { colors } = useTheme();
  const text = useChatText();
  const value = Math.min(1, Math.max(0, Number.isFinite(props.value) ? props.value : 0));
  const percent = Math.round(value * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={props.label}
      accessibilityValue={{ min: 0, max: 100, now: percent, text: `${percent}%` }}
      style={{ gap: 4 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: colors.ink2, ...text.scaled(13) }}>{props.label}</Text>
        <Text style={{ color: colors.ink2, ...text.scaled(13), fontVariant: ["tabular-nums"] }}>{percent}%</Text>
      </View>
      <View style={{ height: 6, borderRadius: radius.full, backgroundColor: colors.field, overflow: "hidden" }}>
        <View style={{ height: 6, borderRadius: radius.full, backgroundColor: colors.ink, width: `${value * 100}%` }} />
      </View>
    </View>
  );
};

const Button: GenuiRenderer<"Button"> = ({ props }) => {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  return (
    <UiButton
      title={props.label}
      secondary={props.variant === "secondary"}
      disabled={streaming}
      onPress={() => trigger(props.label, undefined, props.action as never)}
    />
  );
};

const flat =
  <K extends GenuiComponentName>(Component: (props: GenuiProps<K>) => ReactNode): GenuiRenderer<K> =>
  ({ props }) =>
    Component(props);

export const renderers: { [K in GenuiComponentName]: GenuiRenderer<K> } = {
  Stack,
  Heading,
  Text: TextBlock,
  KeyValue,
  Table,
  Callout,
  Progress,
  BarChart: flat<"BarChart">(BarChart),
  LineChart: flat<"LineChart">(LineChart),
  Button,
};
