/** Experimental computer use: agents operate desktop apps through agent-desktop (Settings › Experimental). */
export type ComputerUsePermission = "granted" | "denied" | "not_required" | "unknown";

export interface ComputerUseSettings {
  enabled: boolean;
  /** Draw Milagre's agent cursor and the current step on the screen while an agent acts. */
  cursor: boolean;
}

/** A Chat's live screen: the window its agent last used. `seq` 0 means no frame yet. */
export interface ComputerUseFrame {
  seq: number;
  /** True while the agent works in the app and frames keep coming. */
  live: boolean;
  app?: string;
  title?: string | null;
  at?: number;
  mime?: string;
  /** Base64 image data. */
  image?: string;
  width?: number | null;
  height?: number | null;
  /** "screen-recording": the computer has not granted Screen Recording to Milagre. */
  error?: "screen-recording";
}

export interface ComputerUseStatus extends ComputerUseSettings {
  /** False on a platform agent-desktop doesn't ship for, or when its binary is missing. */
  supported: boolean;
  version: string;
  platform: string;
  /** Apps agents never operate. */
  blockedApps: string[];
  /** Null when unsupported. On macOS both belong to Milagre, the app that launches agent-desktop. */
  permissions: { accessibility: ComputerUsePermission; screenRecording: ComputerUsePermission } | null;
}

export interface ComputerUseApi {
  readSettings(): Promise<ComputerUseSettings>;
  saveSettings(patch: Partial<ComputerUseSettings>): Promise<ComputerUseSettings>;
  onSettings(callback: (value: ComputerUseSettings) => void): () => void;
  status(): Promise<ComputerUseStatus>;
  /** Opens System Settings at the missing permission with agent-desktop's on-screen guide; returns at once. */
  guide(): Promise<{ guide: "started" | "already_running" | "not_needed" }>;
  /** The Chat's frame after `after`, waiting up to 15 s while its agent works. */
  frame(request: { chatId: string; after?: number }): Promise<ComputerUseFrame>;
}

/** A granted permission needs nothing; anything else offers the Grant button. */
export const permissionMissing = (state: ComputerUsePermission | undefined) => state !== "granted" && state !== "not_required";
