/** A page in a browser that this Chat's agent started (`agent`) or that the user attached (`attached`). */
export type BrowserTarget = { id: string; title: string; url: string; browser: string; source: "agent" | "attached" | "panel" };
/** A browser on this computer that no Chat's agent started. Attaching it is an explicit user action. */
export type BrowserCandidate = { id: string; browser: string; pages: number; title: string };
export type BrowserList = { supported: boolean; targets: BrowserTarget[]; others: BrowserCandidate[]; error?: string };
export type BrowserOpen = { viewerId: string; target: BrowserTarget };
export type BrowserStatus = {
  generation: number;
  controlling: boolean;
  ready: boolean;
  title: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Absent on older hosts. Only send viewport input when explicitly supported. */
  supportsViewport?: boolean;
};
/** `data` is a base64 JPEG on the wire; the mobile wrapper swaps it for a local `uri` before the receiver sees it. */
export type BrowserFrame = { sequence: number; data: string; uri?: string; viewport: { width: number; height: number }; generation: number };
export type BrowserInput =
  | {
      kind: "mouse";
      phase: "down" | "move" | "up";
      x: number;
      y: number;
      button?: "left" | "middle" | "right" | "none";
      clickCount?: number;
      modifiers?: number;
    }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | {
      kind: "key";
      phase: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers?: number;
      commands?: ("selectAll" | "copy" | "cut" | "paste" | "undo" | "redo")[];
    }
  | { kind: "text"; text: string }
  | { kind: "navigate"; action: "back" | "forward" | "reload" }
  /** The viewer's size in CSS pixels: the page lays out at it, whatever size its own window is. */
  | { kind: "viewport"; width: number; height: number };
export interface BrowserApi {
  list(request: { chatId: string }): Promise<BrowserList>;
  attach(request: { chatId: string; browserId: string }): Promise<BrowserList>;
  detach(request: { chatId: string; browserId: string }): Promise<BrowserList>;
  open(request: { chatId: string; targetId: string }): Promise<BrowserOpen>;
  frame(request: { viewerId: string; after: number }): Promise<BrowserFrame | null>;
  status(request: { viewerId: string }): Promise<BrowserStatus>;
  control(request: { viewerId: string; takeOver: boolean }): Promise<BrowserStatus>;
  input(request: { viewerId: string; sequence: number; generation: number; event: BrowserInput }): Promise<{ accepted: boolean }>;
  close(request: { viewerId: string }): Promise<null>;
}
export type BrowserMethod = Exclude<keyof BrowserApi, "list" | "attach" | "detach">;
export type BrowserRpcResponse = { channel: "milagre-browser"; id: number; result?: unknown; error?: string };
