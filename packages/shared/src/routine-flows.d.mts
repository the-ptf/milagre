import type { FlowField, FlowIfStep, FlowRun, FlowStep, FlowStepKind, FlowStepRun, ModelProvider, RoutineEvent, RoutineRun, RoutineTrigger } from "./model.ts";

export const FLOW_LIMITS: Readonly<{
  steps: number;
  depth: number;
  name: number;
  prompt: number;
  text: number;
  fields: number;
  choices: number;
  askHours: number;
  waitMinutes: number;
  timeoutHours: number;
  retries: number;
}>;

export interface FlowStepType {
  kind: FlowStepKind;
  /** The menu's name, "Open pull request". */
  name: string;
  /** A tile's name, "Open PR". */
  short: string;
  description: string;
  /** A Lucide icon name. */
  icon: string;
}
export const FLOW_STEP_TYPES: ReadonlyArray<FlowStepType>;

/** A field a step can read, as `{{ref}}` in its texts or an If's field. */
export interface FlowReadable {
  ref: string;
  label: string;
  type: FlowField["type"];
  choices?: string[];
  /** The step that gives it, "Trigger" for the trigger's. */
  stepName: string;
}

export interface FlatStep {
  step: FlowStep;
  depth: number;
  parentId: string | null;
  branch: "yes" | "otherwise" | null;
  index: number;
}

export type TriggerKind = RoutineTrigger["kind"] | "pull-request";

export function triggerFields(triggerKind: TriggerKind | undefined): FlowReadable[];
export function stepType(kind: FlowStepKind): FlowStepType | null;
export function newStepId(steps: FlowStep[], name: string): string;
export function newStep<K extends FlowStepKind>(kind: K, steps?: FlowStep[]): Extract<FlowStep, { kind: K }>;
export function flattenSteps(steps: FlowStep[]): FlatStep[];
export function findStep(steps: FlowStep[], id: string): FlowStep | null;
export function insertStep(
  steps: FlowStep[],
  where: { parentId?: string | null; branch?: "yes" | "otherwise" | null; index?: number },
  step: FlowStep,
): FlowStep[];
export function removeStep(steps: FlowStep[], id: string): FlowStep[];
export function replaceStep(steps: FlowStep[], id: string, next: FlowStep): FlowStep[];
export function moveStep(steps: FlowStep[], id: string, by: -1 | 1): FlowStep[];
export function fieldsBefore(steps: FlowStep[], id: string | null | undefined, triggerKind: TriggerKind | undefined): FlowReadable[];
export function placeholders(value: string): string[];
export function stepReads(step: FlowStep | null | undefined): string[];
export function usedBy(steps: FlowStep[], ref: string): number;
export function checkFlowSteps(value: unknown, triggerKind: TriggerKind | undefined): FlowStep[];
export function checkDraftSteps(value: unknown): FlowStep[];
export function flowProblems(steps: FlowStep[], triggerKind: TriggerKind | undefined): Array<{ stepId: string | null; message: string }>;
export function triggerValues(event: RoutineEvent | undefined, at?: number): Record<string, unknown>;
export function readRef(values: Record<string, unknown>, ref: string): unknown;
export function fillTemplate(value: string, values: Record<string, unknown>): string;
export function testCondition(step: FlowIfStep, values: Record<string, unknown>): boolean;
export function checkOutput(
  fields: FlowField[],
  value: unknown,
): { ok: true; output: Record<string, string | number | boolean> } | { ok: false; error: string };
export function outputInstructions(fields: FlowField[]): string;
export function outputSummary(output: Record<string, unknown> | undefined): string;
export function conditionText(step: FlowIfStep): string;
export function stepSubtitle(step: FlowStep, options?: { modelName?: (provider: ModelProvider | undefined, model: string) => string }): string;
export function durationText(minutes: number): string;
export function stepTitle(step: FlowStep): string;
export function flowChanges(published: FlowStep[] | undefined, draft: FlowStep[] | undefined): string[];

export type FlowRunRow =
  | { kind: "step"; step: FlowStep; depth: number; status: FlowStepRun["status"] | "not-taken"; run: FlowStepRun | null }
  | { kind: "path"; path: "yes" | "otherwise"; parentId: string; depth: number; taken: boolean; decided: boolean; empty: boolean };
export function runRows(flow: FlowRun | undefined): FlowRunRow[];
export function currentStep(flow: FlowRun | undefined): FlowStep | null;
export function failedStep(flow: FlowRun | undefined): FlowStep | null;
export function flowRunText(run: RoutineRun | undefined): string;
export function needsAnswer(run: RoutineRun | undefined): boolean;
