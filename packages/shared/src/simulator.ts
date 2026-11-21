import { LOCAL_COMPUTER, computerOfKey } from "./chat-scopes.mjs";

export type SimulatorDevice = {
  id: string;
  name: string;
  platform: "ios" | "android";
  version: string;
  /** CoreSimulator's model identifier, independent of the device's editable name. */
  deviceType?: string;
};
export type SimulatorOrientation = "portrait" | "portrait-upside-down" | "landscape-left" | "landscape-right";
export type SimulatorStatus = {
  width: number;
  height: number;
  orientation: SimulatorOrientation;
  generation: number;
  displayGeneration?: number;
  controlling: boolean;
  ready: boolean;
  supportsHingeAngle?: boolean;
  hingeAngle?: number;
  hingePose?: "closed" | "open" | "book" | "laptop" | "tent";
  /** Runtime input-mode hint; it does not establish whether touches reach the app. */
  deviceHubInputActive?: boolean;
  /** @deprecated Compatibility alias for the same unverified input-mode hint. */
  inputBlocked?: boolean;
};
export type SimulatorInput =
  | { kind: "touch"; phase: "begin" | "move" | "end"; points: { x: number; y: number }[] }
  | { kind: "button"; button: "home" | "back" }
  | { kind: "rotate"; orientation: SimulatorOrientation }
  | { kind: "pose"; pose: "closed" | "open" | "book" | "laptop" | "tent" }
  | { kind: "hinge"; angle: number }
  | { kind: "key"; phase: "down" | "up"; usage: number; key?: string; shifted?: boolean };
export type SimulatorList = {
  devices: SimulatorDevice[];
  chatId?: string;
  attached?: SimulatorDevice[];
  available?: SimulatorDevice[];
  supported: boolean;
  error?: string;
};
/** `video/avcc` is base64 of serve-sim envelopes; `reset` means the batch restarts from a keyframe. */
export type SimulatorFrame = { sequence: number; data: string; mimeType: "image/jpeg" | "image/png" | "video/avcc"; reset?: boolean; status: SimulatorStatus };
export type SimulatorOpen = {
  viewerId: string;
  device: SimulatorDevice;
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  transport?: "frames";
  /** Frame formats this host serves on request. Absent on older hosts and Simlock leases, which choose for the viewer. */
  formats?: SimulatorFrameFormat[];
};
/** `image` is JPEG or PNG frames; `video/avcc` is H.264 for viewers that decode it with WebCodecs. */
export type SimulatorFrameFormat = "video/avcc" | "image";
/** The encoder is shared per device: it runs at `full` while any H.264 viewer asks for it, else `reduced`. */
export type SimulatorFrameQuality = "full" | "reduced";
/** A viewer on the computer that runs the device asks for `full`; across a Link or the relay it asks for `reduced`, as the phone does. */
export function simulatorQualityFor(chatKey: string): SimulatorFrameQuality {
  return computerOfKey(chatKey) === LOCAL_COMPUTER ? "full" : "reduced";
}
export interface SimulatorApi {
  list(request: { chatId: string }): Promise<SimulatorList>;
  attach(request: { chatId: string; deviceId: string }): Promise<SimulatorList>;
  detach(request: { chatId: string; deviceId: string }): Promise<SimulatorList>;
  open(request: { deviceId: string; chatId: string }): Promise<SimulatorOpen>;
  /** Send `format` and `quality` only to hosts that listed `formats` when the viewer opened. */
  frame(request: { viewerId: string; after: number; format?: SimulatorFrameFormat; quality?: SimulatorFrameQuality }): Promise<SimulatorFrame | null>;
  offer(request: { viewerId: string; sdp: string }): Promise<{ type: "answer"; sdp: string }>;
  status(request: { viewerId: string }): Promise<SimulatorStatus>;
  control(request: { viewerId: string; takeOver: boolean }): Promise<SimulatorStatus>;
  input(request: { viewerId: string; sequence: number; generation: number; event: SimulatorInput }): Promise<{ accepted: boolean }>;
  /** Restarts the simulator's input, closing its running apps. Every viewer of the device reopens. */
  repair(request: { viewerId: string }): Promise<null>;
  close(request: { viewerId: string }): Promise<null>;
}
export type SimulatorMethod = Exclude<keyof SimulatorApi, "list" | "attach" | "detach">;
export type SimulatorRpcResponse = { channel: "milagre-simulator"; id: number; result?: unknown; error?: string };

/** Experimental: the Simlock pool this host leases devices from. The agent token never leaves the host. */
export type SimlockSettings = {
  enabled: boolean;
  /** The gateway in use: the saved one, else the one this Mac's agent-device or Simlock worker points at. */
  gatewayUrl: string;
  savedGatewayUrl: string;
  hasToken: boolean;
  tokenSource: "settings" | "env" | "worker" | null;
  detected: { gatewayUrl: string; source: "env" | "worker" } | null;
  maxLeases: number;
  maxLeaseMinutes: number;
};
export type SimlockSettingsPatch = Partial<Pick<SimlockSettings, "enabled" | "gatewayUrl" | "maxLeases" | "maxLeaseMinutes">> & { agentToken?: string };
export type SimlockModel = { platform: "ios" | "android"; model: string; version: string; kind: string };
export type SimlockLease = {
  deviceId: string;
  leaseId: string;
  platform: "ios" | "android";
  name: string;
  version: string;
  chatId: string | null;
  startedAt: number;
  endsAt: number;
};
export interface SimlockApi {
  readSettings(): Promise<SimlockSettings>;
  saveSettings(patch: SimlockSettingsPatch): Promise<SimlockSettings>;
  onSettings(callback: (value: SimlockSettings) => void): () => void;
  /** Who the gateway says the token is; a typed URL or token is checked without saving it. */
  identity(request: { gatewayUrl?: string; agentToken?: string }): Promise<{ name: string; role: string; gatewayUrl: string }>;
  models(): Promise<{ models: SimlockModel[]; leases: SimlockLease[] }>;
  /** Leases a device for the Chat and attaches it there. */
  lease(request: { chatId: string; platform: "ios" | "android"; model?: string }): Promise<SimlockLease>;
  /** Returns the device to the pool, wiped, and detaches it from its Chat. */
  release(request: { deviceId: string }): Promise<{ released: string }>;
}
/** Simlock leases are listed with ids under this prefix. */
export const SIMLOCK_DEVICE_PREFIX = "simlock:";
