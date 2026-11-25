export interface SidebarSettings {
  /** How many recent Projects the host lists in the sidebar. */
  projects: number;
}

export const SIDEBAR_PROJECT_OPTIONS: readonly number[];
export const SIDEBAR_DEFAULTS: Readonly<SidebarSettings>;
export function normalizeSidebarSettings(value: unknown): SidebarSettings;
