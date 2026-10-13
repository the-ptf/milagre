import type { SimulatorInput, SimulatorMethod, SimulatorRpcResponse } from "./simulator.ts";
import type { SimulatorDevice } from "./simulator.ts";
export const SIMULATOR_RECEIVER_SCRIPT: string;
export const SIMULATOR_CONNECTION_LABELS: {
  connecting: "Connecting";
  live: "Live";
  "view-only": "View only";
  rotating: "Rotating";
  blocked: "Input blocked";
  paused: "Paused";
  error: "Disconnected";
};
export type SimulatorConnectionState = keyof typeof SIMULATOR_CONNECTION_LABELS;
export type SimulatorConnection = { deviceId: string; state: SimulatorConnectionState };
export function buildSimulatorReceiverScript(): string;
export type SimulatorGeometry = { left: number; top: number; width: number; height: number; rawWidth: number; rawHeight: number; rotation: number };
export function simulatorGeometry(
  status: { width: number; height: number; orientation: string },
  box: { width: number; height: number },
  inset?: number,
): SimulatorGeometry | null;
export function simulatorAppearance(device?: Partial<SimulatorDevice>): { cutout: "island" | "notch" | "camera" | "none"; radius: number };
export function simulatorPoint(
  point: { x: number; y: number },
  geometry: SimulatorGeometry | null,
  clamp?: boolean,
  radius?: number,
): { x: number; y: number } | null;
export function createSimulatorInputQueue(
  send: (event: SimulatorInput) => Promise<unknown>,
  failed: (error: Error) => void,
  limit?: number,
): { push(event: SimulatorInput): void; dispose(): void };
export function createSimulatorBridge(
  call: (method: SimulatorMethod, args: Record<string, unknown>) => Promise<unknown>,
  respond: (response: SimulatorRpcResponse) => void,
): { receive(message: unknown): Promise<void>; dispose(): void };
export type SimulatorTheme = {
  scheme: "light" | "dark";
  surface: string;
  ink: string;
  ink2: string;
  line: string;
  hover: string;
  accent: string;
  green?: string;
};
export function createSimulatorReceiverHtml(config: { deviceId: string; device?: SimulatorDevice; theme?: SimulatorTheme; touchControls?: boolean }): string;
