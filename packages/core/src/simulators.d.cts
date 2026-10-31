export type SimulatorOrientation = "portrait" | "portrait-upside-down" | "landscape-left" | "landscape-right";
export interface SimulatorDevice {
  id: string;
  name: string;
  platform: "ios" | "android";
  version: string;
}
export interface SimulatorIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
export interface SimulatorStatus {
  width: number;
  height: number;
  orientation: SimulatorOrientation;
  generation: number;
  displayGeneration?: number;
  controlling: boolean;
  ready: boolean;
  /** Reported by the host helper, not inferred from the simulator name. */
  supportsHingeAngle?: boolean;
  hingeAngle?: number;
  hingePose?: "closed" | "open" | "book" | "laptop" | "tent";
  /** Runtime input-mode hint, not a touch-delivery failure. */
  deviceHubInputActive?: boolean;
  /** @deprecated Compatibility alias for the same unverified input-mode hint. */
  inputBlocked?: boolean;
}
export type SimulatorInput =
  | { kind: "touch"; phase: "begin" | "move" | "end"; points: { x: number; y: number }[] }
  | { kind: "button"; button: "home" }
  | { kind: "rotate"; orientation: SimulatorOrientation }
  | { kind: "pose"; pose: "closed" | "open" | "book" | "laptop" | "tent" }
  | { kind: "hinge"; angle: number }
  | { kind: "key"; phase: "down" | "up"; usage: number; key?: string; shifted?: boolean };
export interface SimulatorChannel {
  frame?(
    after: number,
    signal: AbortSignal,
  ): Promise<{ sequence: number; data: string; mimeType: "image/jpeg" | "image/png" | "video/avcc"; reset?: boolean } | null>;
  status(): Omit<SimulatorStatus, "generation" | "controlling"> & { error?: string };
  send(event: SimulatorInput): void | Promise<void>;
  close(): Promise<void>;
}
export interface SimulatorAdapter {
  iceServers?: SimulatorIceServer[];
  list(): Promise<SimulatorDevice[]>;
  connect(deviceId: string): Promise<SimulatorChannel>;
  offer(deviceId: string, sessionId: string, sdp: string): Promise<{ type: "answer"; sdp: string }>;
  closeViewer(deviceId: string, sessionId: string): Promise<void>;
  repairInput(deviceId: string): Promise<void>;
  stop(): Promise<void>;
}
export interface SimulatorOptions {
  /** Trusted host configuration only; never populate from RPC arguments. */
  helperPath?: string;
  adapter?: SimulatorAdapter;
  iceServers?: SimulatorIceServer[];
  supported?: boolean;
  viewerTtlMs?: number;
  maxViewers?: number;
  now?: () => number;
}
export interface Simulators {
  list(): Promise<{ devices: SimulatorDevice[]; supported: boolean; error?: string }>;
  open(
    request: { deviceId: string },
    owner: string,
  ): Promise<{ viewerId: string; device: SimulatorDevice; iceServers: SimulatorIceServer[]; transport?: "frames" }>;
  frame(
    request: { viewerId: string; after: number },
    owner: string,
  ): Promise<{ sequence: number; data: string; mimeType: "image/jpeg" | "image/png" | "video/avcc"; reset?: boolean; status: SimulatorStatus } | null>;
  offer(request: { viewerId: string; sdp: string }, owner: string): Promise<{ type: "answer"; sdp: string }>;
  status(request: { viewerId: string }, owner: string): Promise<SimulatorStatus>;
  control(request: { viewerId: string; takeOver: boolean }, owner: string): Promise<SimulatorStatus>;
  input(request: { viewerId: string; sequence: number; generation: number; event: SimulatorInput }, owner: string): Promise<{ accepted: boolean }>;
  repair(request: { viewerId: string }, owner: string): Promise<null>;
  closeViewer(request: { viewerId: string }, owner: string): Promise<null>;
  disconnect(owner: string): Promise<void>;
  close(): Promise<void>;
}
export function createSimulators(options?: SimulatorOptions): Simulators;
