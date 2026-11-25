/** How many recent Projects the sidebar can list, in the order Settings offers them. */
export const SIDEBAR_PROJECT_OPTIONS = Object.freeze([5, 10, 15, 20, 30, 50]);

export const SIDEBAR_DEFAULTS = Object.freeze({ projects: 10 });

export function normalizeSidebarSettings(value) {
  const projects = value && typeof value === "object" ? value.projects : undefined;
  return { projects: SIDEBAR_PROJECT_OPTIONS.includes(projects) ? projects : SIDEBAR_DEFAULTS.projects };
}
