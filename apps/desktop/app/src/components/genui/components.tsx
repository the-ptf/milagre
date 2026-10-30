import type { ReactNode } from "react";
import { useIsStreaming, useTriggerAction } from "@milagre/shared/genui-renderer";
import type { ComponentRenderProps } from "@milagre/shared/genui-renderer";
import { squareRows } from "@milagre/shared/genui";
import type { GenuiComponentName, GenuiProps } from "@milagre/shared/genui";
import { ScrollArea } from "../primitives/ScrollArea";
import { Button as ButtonPrimitive } from "../primitives/Button";
import { BarChart, LineChart } from "./charts";

export type GenuiRenderer<K extends GenuiComponentName> = (args: ComponentRenderProps<GenuiProps<K>>) => ReactNode;

const GAP = { s: "gap-1", m: "gap-2", l: "gap-4" } as const;

const Stack: GenuiRenderer<"Stack"> = ({ props, renderNode }) => (
  <div data-slot="genui-stack" className={`flex ${props.direction === "row" ? "flex-row flex-wrap items-start" : "flex-col"} ${GAP[props.gap ?? "m"]}`}>
    {renderNode(props.children)}
  </div>
);

// Sized from the user's chat text size, as markdown headings are.
const HEADING = {
  1: "text-[length:calc(var(--chat-size)+2px)] font-semibold text-ink",
  2: "text-[length:calc(var(--chat-size)+1px)] font-semibold text-ink",
  3: "text-[length:var(--chat-size)] font-medium text-ink-2",
} as const;

const Heading: GenuiRenderer<"Heading"> = ({ props }) => (
  <div role="heading" aria-level={props.level ?? 2} className={HEADING[props.level ?? 2]}>
    {props.text}
  </div>
);

const TONE = { default: "text-ink", muted: "text-ink-2", strong: "font-medium text-ink" } as const;

const Text: GenuiRenderer<"Text"> = ({ props }) => (
  <p className={`m-0 text-[length:var(--chat-size)] leading-[1.55] ${TONE[props.tone ?? "default"]}`}>{props.text}</p>
);

const KeyValue: GenuiRenderer<"KeyValue"> = ({ props }) => (
  <dl data-slot="genui-keyvalue" className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[length:var(--chat-size)]">
    {props.pairs.map(([key, value], index) => (
      <div key={index} className="contents">
        <dt className="text-ink-2">{key}</dt>
        <dd className="m-0 text-ink">{value}</dd>
      </div>
    ))}
  </dl>
);

const Table: GenuiRenderer<"Table"> = ({ props }) => {
  const rows = squareRows(props.columns, props.rows);
  return (
    <ScrollArea data-slot="genui-table" className="my-1 max-w-full rounded-card border border-line bg-surface">
      <table className="w-full border-collapse text-[length:var(--chat-size)]">
        <thead>
          <tr>
            {props.columns.map((column, index) => (
              <th key={index} className="border-b border-line px-3 py-1.5 text-left font-medium text-ink-2">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-1.5 text-ink">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
};

const CALLOUT = {
  info: "border-accent/30 bg-accent-tint text-ink",
  success: "border-green/30 bg-green-tint text-ink",
  warning: "border-orange/30 bg-orange-tint text-ink",
  danger: "border-red/30 bg-red-tint text-ink",
} as const;

const Callout: GenuiRenderer<"Callout"> = ({ props }) => (
  <div
    data-slot="genui-callout"
    data-tone={props.tone ?? "info"}
    className={`rounded-card border px-3 py-2 text-[length:var(--chat-size)] ${CALLOUT[props.tone ?? "info"]}`}
  >
    {props.title && <div className="mb-0.5 font-medium">{props.title}</div>}
    <div>{props.body}</div>
  </div>
);

const Progress: GenuiRenderer<"Progress"> = ({ props }) => {
  const value = Math.min(1, Math.max(0, Number.isFinite(props.value) ? props.value : 0));
  return (
    <div data-slot="genui-progress" className="text-[length:var(--chat-size)]">
      <div className="mb-1 flex justify-between text-ink-2">
        <span>{props.label}</span>
        <span>{Math.round(value * 100)}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-field"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
};

const Button: GenuiRenderer<"Button"> = ({ props }) => {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const secondary = props.variant === "secondary";
  return (
    <ButtonPrimitive
      variant={secondary ? "secondary" : "primary"}
      data-slot="genui-button"
      disabled={streaming}
      onClick={() => trigger(props.label, undefined, props.action as never)}
      className="self-start"
    >
      {props.label}
    </ButtonPrimitive>
  );
};

/** The chart components take flat props; wrap them so the renderer map has one shape. */
const flat =
  <K extends GenuiComponentName>(Component: (props: GenuiProps<K>) => ReactNode): GenuiRenderer<K> =>
  ({ props }) =>
    Component(props);

export const renderers: { [K in GenuiComponentName]: GenuiRenderer<K> } = {
  Stack,
  Heading,
  Text,
  KeyValue,
  Table,
  Callout,
  Progress,
  BarChart: flat<"BarChart">(BarChart),
  LineChart: flat<"LineChart">(LineChart),
  Button,
};
