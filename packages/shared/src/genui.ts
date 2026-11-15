import { z } from "zod";
import { createLibrary, createParser, defineComponent, evaluateElementProps, tagSchemaId } from "@openuidev/lang-core";
import type { ActionEvent, ElementNode, ParseResult } from "@openuidev/lang-core";

export const GENUI_FENCE = "openui";

export const isGenuiFence = (info: string | undefined): boolean => (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() === GENUI_FENCE;

export const genuiLimits = { rows: 200, columns: 12, points: 100, text: 64 * 1024 } as const;

export const GENUI_ROOT = "Stack";

export const GENUI_ACTION_TYPE = "continue_conversation";

// An `Action([...])` evaluates to a plan of steps; the two object forms are the language's legacy action values.
// lang-core tags schema instances, and `.describe()` returns a clone, so the instance that is tagged is the one Button uses.
const action = z.union([
  z.object({ steps: z.array(z.any()) }),
  z.object({ type: z.literal("continue_conversation"), context: z.string().optional() }),
  z.object({ type: z.string(), params: z.record(z.string(), z.any()).optional() }),
]);
const actionProp = action.describe('Action([@ToAssistant("message")]); only @ToAssistant steps act');
tagSchemaId(actionProp, "ActionExpression");

const cell = z.string().max(2000);
const label = z.string().max(200);

/** In the order the skill lists them. Prop order is positional order in OpenUI Lang: `Table(columns, rows)`. */
export const GENUI_COMPONENTS = {
  Stack: {
    description: "Lays out children vertically (default) or in a row. The root of every block.",
    props: z.object({
      children: z.array(z.any()).describe("Child components"),
      direction: z.enum(["column", "row"]).optional().describe('"column" (default) or "row"'),
      gap: z.enum(["s", "m", "l"]).optional().describe("Space between children, default m"),
    }),
  },
  Heading: {
    description: "A short section title, one line, above the content it introduces.",
    props: z.object({
      text: label.describe("Title text"),
      level: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .optional()
        .describe("1 largest, 3 smallest; default 2"),
    }),
  },
  Text: {
    description: "A paragraph of plain text, no markdown.",
    props: z.object({
      text: z.string().max(4000).describe("The text"),
      tone: z.enum(["default", "muted", "strong"]).optional().describe("muted for secondary text, strong for emphasis"),
    }),
  },
  KeyValue: {
    description: "Labels and values in two columns: metrics, counts, dates.",
    props: z.object({
      pairs: z
        .array(z.tuple([label, cell]))
        .max(genuiLimits.rows)
        .describe('[["label", "value"], ...]'),
    }),
  },
  Table: {
    description: "A table of string cells. Use for lists of results with several attributes each.",
    props: z.object({
      columns: z.array(label).min(1).max(genuiLimits.columns).describe("Column headers"),
      rows: z
        .array(z.array(z.union([cell, z.number(), z.null()])).max(genuiLimits.columns))
        .max(genuiLimits.rows)
        .describe("Rows of cells, one string per column"),
    }),
  },
  Callout: {
    description: "A highlighted note: a warning, a success, an error or a tip.",
    props: z.object({
      body: z.string().max(4000).describe("The note"),
      tone: z.enum(["info", "success", "warning", "danger"]).optional().describe("info (default), success, warning or danger"),
      title: label.optional().describe("Optional short title"),
    }),
  },
  Progress: {
    description: "A labelled progress bar.",
    props: z.object({
      label: label.describe("What is progressing"),
      value: z.number().describe("0 to 1"),
    }),
  },
  BarChart: {
    description: "Vertical bars, one series.",
    props: z.object({
      labels: z.array(label).max(genuiLimits.points).describe("One label per bar"),
      values: z.array(z.number()).max(genuiLimits.points).describe("One number per bar"),
      title: label.optional().describe("Optional chart title"),
    }),
  },
  LineChart: {
    description: "A line over ordered points, one series.",
    props: z.object({
      labels: z.array(label).max(genuiLimits.points).describe("One label per point"),
      values: z.array(z.number()).max(genuiLimits.points).describe("One number per point"),
      title: label.optional().describe("Optional chart title"),
    }),
  },
  Button: {
    description: 'A button that sends a message to the assistant when tapped: Button("Approve", Action([@ToAssistant("Approve the plan")])).',
    props: z.object({
      label: label.describe("Button text"),
      action: actionProp,
      variant: z.enum(["primary", "secondary"]).optional().describe("primary (default) or secondary"),
    }),
  },
} as const;

export type GenuiComponentName = keyof typeof GENUI_COMPONENTS;
export type GenuiProps<K extends GenuiComponentName> = z.infer<(typeof GENUI_COMPONENTS)[K]["props"]>;

export function genuiDefinitions<C>(renderers: Record<GenuiComponentName, C>) {
  return (Object.keys(GENUI_COMPONENTS) as GenuiComponentName[]).map((name) => ({
    name,
    description: GENUI_COMPONENTS[name].description,
    props: GENUI_COMPONENTS[name].props,
    component: renderers[name],
  }));
}

export function squareRows(columns: readonly string[], rows: readonly (readonly unknown[])[]): string[][] {
  return rows.map((row) => columns.map((_, index) => (row[index] === undefined || row[index] === null ? "" : String(row[index]))));
}

export const CHART_WIDTH = 320;
export const CHART_HEIGHT = 140;
export const CHART_PAD = { top: 8, right: 8, bottom: 22, left: 8 } as const;

export function chartGeometry(values: readonly number[], width = CHART_WIDTH, height = CHART_HEIGHT) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const inner = { width: width - CHART_PAD.left - CHART_PAD.right, height: height - CHART_PAD.top - CHART_PAD.bottom };
  const slot = values.length ? inner.width / values.length : inner.width;
  const y = (value: number) => CHART_PAD.top + inner.height - ((value - min) / span) * inner.height;
  return { slot, y, zero: y(0), inner };
}

/** UTF-8 byte count without a TextEncoder dependency in React Native. Stops at the cap. */
export function genuiTextOverLimit(code: string): boolean {
  let bytes = 0;
  for (const char of code) {
    const point = char.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes > genuiLimits.text) return true;
  }
  return false;
}

const parserLibrary = createLibrary({
  root: GENUI_ROOT,
  components: Object.entries(GENUI_COMPONENTS).map(([name, definition]) =>
    defineComponent({ name, ...definition, props: definition.props as z.ZodObject, component: null }),
  ),
});
const parser = createParser(parserLibrary.toJSONSchema());

export function parseGenui(code: string): ParseResult {
  const empty = (): ParseResult => ({
    root: null,
    meta: { incomplete: false, unresolved: [], orphaned: [], statementCount: 0, errors: [] },
    stateDeclarations: {},
    queryStatements: [],
    mutationStatements: [],
  });
  if (genuiTextOverLimit(code)) return empty();
  try {
    const result = parser.parse(code);
    if (!result.root) return result;
    const evaluated = evaluateElementProps(result.root, {
      library: parserLibrary,
      store: null,
      ctx: { getState: () => undefined, resolveRef: () => undefined },
    });
    let overCap = false;
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit);
      if (!value || typeof value !== "object" || !("type" in value) || value.type !== "element") return value;
      const node = value as ElementNode;
      const definition = GENUI_COMPONENTS[node.typeName as GenuiComponentName];
      if (!definition) return null;
      let props = Object.fromEntries(Object.entries(node.props).map(([name, prop]) => [name, visit(prop)]));
      if (node.typeName === "Table" && Array.isArray(props.columns) && Array.isArray(props.rows) && props.rows.every(Array.isArray)) {
        if (props.rows.some((row) => row.length > genuiLimits.columns)) overCap = true;
        props = { ...props, rows: squareRows(props.columns, props.rows) };
      }
      const checked = definition.props.safeParse(props);
      if (!checked.success) {
        if (checked.error.issues.some((issue) => issue.code === "too_big")) overCap = true;
        return null;
      }
      return { ...node, props: checked.data };
    };
    const root = visit(evaluated) as ElementNode | null;
    return { ...result, root: overCap || root?.typeName !== GENUI_ROOT ? null : root };
  } catch {
    return empty();
  }
}

/** Buttons can emit assistant messages only. Never execute Set, OpenUrl, Query or Mutation steps. */
export function genuiActionEvents(label: string, action: unknown): ActionEvent[] {
  if (!action || typeof action !== "object") return [];
  if ("steps" in action && Array.isArray(action.steps)) {
    return action.steps.flatMap((step) =>
      step?.type === GENUI_ACTION_TYPE && typeof step.message === "string" && step.message
        ? [{ type: GENUI_ACTION_TYPE, params: {}, humanFriendlyMessage: step.message }]
        : [],
    );
  }
  if ("type" in action && action.type === GENUI_ACTION_TYPE) return [{ type: GENUI_ACTION_TYPE, params: {}, humanFriendlyMessage: label }];
  return [];
}
