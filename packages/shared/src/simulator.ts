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
  controlling: boolean;
  ready: boolean;
  /** Xcode Device Hub shadows touches until the simulator's input restarts. */
  inputBlocked?: boolean;
};
export type SimulatorInput =
  | { kind: "touch"; phase: "begin" | "move" | "end"; points: { x: number; y: number }[] }
  | { kind: "button"; button: "home" | "back" }
  | { kind: "rotate"; orientation: SimulatorOrientation }
  | { kind: "key"; phase: "down" | "up"; usage: number; key?: string; shifted?: boolean };
export type SimulatorList = {
  devices: SimulatorDevice[];
  chatId?: string;
  attached?: SimulatorDevice[];
  available?: SimulatorDevice[];
  supported: boolean;
  error?: string;
};
export type SimulatorOpen = { viewerId: string; device: SimulatorDevice; iceServers: { urls: string | string[]; username?: string; credential?: string }[] };
export interface SimulatorApi {
  list(request: { chatId: string }): Promise<SimulatorList>;
  attach(request: { chatId: string; deviceId: string }): Promise<SimulatorList>;
  detach(request: { chatId: string; deviceId: string }): Promise<SimulatorList>;
  open(request: { deviceId: string; chatId: string }): Promise<SimulatorOpen>;
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
