/** Experimental computer use: agents operate desktop apps through agent-desktop (Settings › Experimental). */
export type ComputerUsePermission = "granted" | "denied" | "not_required" | "unknown";

export interface ComputerUseSettings {
  enabled: boolean;
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
}

/** A granted permission needs nothing; anything else offers the Grant button. */
export const permissionMissing = (state: ComputerUsePermission | undefined) => state !== "granted" && state !== "not_required";
