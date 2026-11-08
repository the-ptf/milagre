/**
 * Which pages the Settings sheet's Stack holds, beside the sidebar or without it. On a wide iPad sheet the sidebar is
 * the list, so the Stack starts at a page (the list's own route would show the list twice); narrower, the Stack starts at
 * the list again, so Back from a page returns to it. Each returns null when the Stack already holds the right pages.
 */
export type SettingsStackRoute = { key?: string; name: string; params?: object };

/** The page a wide sheet opens on when nothing else was asked for. */
export const FIRST_SETTINGS_PAGE = "appearance";
const LIST = "settings";

export function wideSettingsRoutes(routes: readonly SettingsStackRoute[]): SettingsStackRoute[] | null {
  if (routes[0]?.name !== LIST) return null;
  const rest = routes.slice(1);
  return rest.length ? rest : [{ name: FIRST_SETTINGS_PAGE }];
}

export function narrowSettingsRoutes(routes: readonly SettingsStackRoute[]): SettingsStackRoute[] | null {
  if (!routes.length || routes[0]?.name === LIST) return null;
  return [{ name: LIST }, ...routes];
}

/** The sidebar row that stands for what the Stack shows: its first page, and for a Project, which one. */
export function selectedSettingsRow(routes: readonly SettingsStackRoute[]): string | undefined {
  const first = routes[0];
  if (!first || first.name === LIST) return undefined;
  if (first.name === "project-settings") return `project:${(first.params as { path?: string } | undefined)?.path ?? ""}`;
  return first.name;
}
