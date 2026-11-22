import { LOCAL_COMPUTER, computerOfKey } from "./chat-scopes.mjs";

export type SimulatorDevice = {
  id: string;
  name: string;
  platform: "ios" | "android";
  version: string;
  /** CoreSimulator's model identifier, independent of the device's editable name. */
  deviceType?: string | null;
  /** CoreSimulator's product family for the device type; null when the host could not read it. Older hosts send neither. */
  productFamily?: SimulatorFamily | null;
  /** CoreSimulator's runtime identifier, such as `com.apple.CoreSimulator.SimRuntime.iOS-26-4`. */
  runtimeIdentifier?: string | null;
  /** The runtime's version, such as `26.4`. */
  runtimeVersion?: string | null;
  /** An Android emulator's API level. */
  apiLevel?: number | null;
  /** The controls it takes, as its status reports them, so a viewer that can't connect still hides the rest. */
  capabilities?: SimulatorCapability[];
};
/** A control a device takes from the viewer. Older hosts send none, which means every control its platform offers. */
export type SimulatorCapability = "touch" | "home" | "back" | "rotate" | "keyboard" | "copy" | "repair" | "hinge";
export type SimulatorFamily = "iPhone" | "iPad" | "Watch" | "TV" | "Vision";
export type SimulatorKind = SimulatorFamily | "Android";
/** What a device is. Metadata decides; the editable name is read only when an older host sent none. */
export function simulatorKind(device: Pick<SimulatorDevice, "platform" | "name" | "productFamily" | "deviceType">): SimulatorKind {
  if (device.platform === "android") return "Android";
  if (device.productFamily) return device.productFamily;
  const model = (device.deviceType ?? device.name).replaceAll(/[-_]/g, " ");
  if (/iPad/i.test(model)) return "iPad";
  if (/Watch/i.test(model)) return "Watch";
  if (/Apple\s*TV/i.test(model)) return "TV";
  if (/Vision/i.test(model)) return "Vision";
  return "iPhone";
}
/** "iOS 26.4" or "Android 15", from the runtime when the host sent it; an iPhone on a cable says so first. */
export function simulatorRuntimeLabel(device: Pick<SimulatorDevice, "platform" | "version" | "runtimeVersion"> & { id?: string }): string {
  const version = device.runtimeVersion || device.version;
  const os = `${device.platform === "android" ? "Android" : "iOS"} ${version}`.trim();
  if (!device.id?.startsWith(BAGUETTE_DEVICE_PREFIX)) return os;
  return version ? `On a cable · ${os}` : "On a cable";
}
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
  /** The host takes key, typed text and paste events; older hosts omit it. */
  keyboard?: boolean;
  /** The host reads the device clipboard back with a copy event. */
  copy?: boolean;
  capabilities?: SimulatorCapability[];
};
export type SimulatorInput =
  | { kind: "touch"; phase: "begin" | "move" | "end"; points: { x: number; y: number }[] }
  | { kind: "button"; button: "home" | "back" }
  | { kind: "rotate"; orientation: SimulatorOrientation }
  | { kind: "pose"; pose: "closed" | "open" | "book" | "laptop" | "tent" }
  | { kind: "hinge"; angle: number }
  | { kind: "key"; phase: "down" | "up"; usage: number; key?: string; shifted?: boolean }
  | { kind: "text" | "paste"; text: string }
  | { kind: "copy"; press?: boolean };
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
  list(request: { chatId: string; attachedOnly?: boolean }): Promise<SimulatorList>;
  attach(request: { chatId: string; deviceId: string }): Promise<SimulatorList>;
  detach(request: { chatId: string; deviceId: string }): Promise<SimulatorList>;
  open(request: { deviceId: string; chatId: string }): Promise<SimulatorOpen>;
  /** Send `format` and `quality` only to hosts that listed `formats` when the viewer opened. */
  frame(request: { viewerId: string; after: number; format?: SimulatorFrameFormat; quality?: SimulatorFrameQuality }): Promise<SimulatorFrame | null>;
  offer(request: { viewerId: string; sdp: string }): Promise<{ type: "answer"; sdp: string }>;
  status(request: { viewerId: string }): Promise<SimulatorStatus>;
  control(request: { viewerId: string; takeOver: boolean }): Promise<SimulatorStatus>;
  input(request: { viewerId: string; sequence: number; generation: number; event: SimulatorInput }): Promise<{ accepted: boolean; text?: string }>;
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

/** iPhones on a cable, reached through the optional Baguette CLI, are listed with ids under this prefix. */
export const BAGUETTE_DEVICE_PREFIX = "baguette:";
export const isCabledIPhone = (device: Pick<SimulatorDevice, "id">) => device.id.startsWith(BAGUETTE_DEVICE_PREFIX);
/** Whether this computer found Baguette, which lists and streams its iPhones on a cable. Milagre doesn't install it. */
export type BaguetteStatus = {
  found: boolean;
  path?: string;
  version?: string;
  /** Found at `minVersion` or later. */
  supported: boolean;
  minVersion: string;
  /** A `baguette serve` this host started is running on loopback now. */
  serving?: boolean;
};
export interface BaguetteApi {
  status(): Promise<BaguetteStatus>;
}
/** Settings' one line on Baguette, with the command that installs or updates it. */
export function baguetteStatusLine(status: BaguetteStatus) {
  if (!status.found) return "Baguette isn't installed. Install it with brew install baguette, then reopen Settings.";
  if (!status.supported)
    return `Baguette ${status.version ?? "of an unknown version"} is too old. Update it to ${status.minVersion} or later with brew upgrade baguette.`;
  return `Baguette ${status.version} is installed${status.serving ? " and streaming now" : ""}.`;
}
