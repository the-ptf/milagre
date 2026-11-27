import {
  PULL_REQUEST_FILTER_CHOICES,
  PULL_REQUEST_FILTER_DEFAULTS,
  PULL_REQUEST_SORTS,
  activePullRequestFilters,
  pullRequestFilterValues,
  type PullRequestFilters,
  type PullRequestRow,
  type PullRequestSort,
} from "@milagre/shared/pull-request-list";

export type PullRequestsSettings = { filters: PullRequestFilters; sort: PullRequestSort };
type FilterChoice = { id: string; title: string; checked: boolean };
export type FilterGroup = { id: string; title: string; value: string; choices: FilterChoice[] };

export const PULL_REQUESTS_DEFAULTS: PullRequestsSettings = { filters: { ...PULL_REQUEST_FILTER_DEFAULTS }, sort: "updated" };
export const RESET_FILTERS = "reset";

type FixedKey = keyof typeof PULL_REQUEST_FILTER_CHOICES;
type OpenKey = "author" | "label" | "project";

const FIXED: { key: FixedKey; title: string }[] = [
  { key: "state", title: "State" },
  { key: "involvement", title: "Involvement" },
];
const LATER: { key: FixedKey; title: string }[] = [
  { key: "draft", title: "Draft" },
  { key: "review", title: "Review" },
  { key: "checks", title: "Checks" },
  { key: "chat", title: "Chat" },
];

function fixedGroup(settings: PullRequestsSettings, key: FixedKey, title: string): FilterGroup {
  const current = settings.filters[key];
  const choices = (PULL_REQUEST_FILTER_CHOICES[key] as { id: string; label: string }[]).map((choice) => ({
    id: `${key}:${choice.id}`,
    title: choice.label,
    checked: choice.id === current,
  }));
  return { id: key, title, value: choices.find((choice) => choice.checked)?.title ?? "", choices };
}

function openGroup(settings: PullRequestsSettings, key: OpenKey, title: string, values: { id: string; title: string }[]): FilterGroup {
  const current = settings.filters[key];
  const choices = [
    { id: `any:${key}`, title: "Any", checked: current === null },
    ...values.map((value) => ({ id: `${key}:${value.id}`, title: value.title, checked: value.id === current })),
  ];
  return { id: key, title, value: choices.find((choice) => choice.checked)?.title ?? current ?? "Any", choices };
}

/** The Filters menu: one submenu per filter and Sort, each choice checked when it is the one in use. */
export function pullRequestFilterGroups(settings: PullRequestsSettings, rows: readonly PullRequestRow[]): FilterGroup[] {
  const values = pullRequestFilterValues(rows);
  const sort = PULL_REQUEST_SORTS.map((choice) => ({ id: `sort:${choice.id}`, title: choice.label, checked: choice.id === settings.sort }));
  return [
    ...FIXED.map(({ key, title }) => fixedGroup(settings, key, title)),
    openGroup(
      settings,
      "author",
      "Author",
      values.authors.map((login) => ({ id: login, title: login })),
    ),
    openGroup(
      settings,
      "label",
      "Labels",
      values.labels.map((name) => ({ id: name, title: name })),
    ),
    ...LATER.map(({ key, title }) => fixedGroup(settings, key, title)),
    openGroup(
      settings,
      "project",
      "Project",
      values.projects.map((project) => ({ id: project.path, title: project.name })),
    ),
    { id: "sort", title: "Sort", value: sort.find((choice) => choice.checked)?.title ?? "", choices: sort },
  ];
}

/** The settings after picking a menu item's `id`. */
export function applyFilterChoice(settings: PullRequestsSettings, id: string): PullRequestsSettings {
  if (id === RESET_FILTERS) return { ...settings, filters: { ...PULL_REQUEST_FILTER_DEFAULTS, state: settings.filters.state } };
  const at = id.indexOf(":");
  if (at < 0) return settings;
  const kind = id.slice(0, at);
  const value = id.slice(at + 1);
  if (kind === "sort") return PULL_REQUEST_SORTS.some((choice) => choice.id === value) ? { ...settings, sort: value as PullRequestSort } : settings;
  if (kind === "any") return value in settings.filters ? { ...settings, filters: { ...settings.filters, [value]: null } } : settings;
  if (!(kind in settings.filters)) return settings;
  if (kind in PULL_REQUEST_FILTER_CHOICES && !PULL_REQUEST_FILTER_CHOICES[kind as FixedKey].some((choice) => choice.id === value)) return settings;
  return { ...settings, filters: { ...settings.filters, [kind]: value } };
}

/** The count the Filters button shows: filters away from their defaults, State left out. */
export const activeFilterCount = (settings: PullRequestsSettings) => activePullRequestFilters(settings.filters);

export { reviewForMePrompt as reviewPrompt } from "@milagre/shared/pr-review";

/** Whether `prompt` names `url` itself, not a longer URL it begins (`…/pull/12` in `…/pull/123`). */
export function mentionsUrl(prompt: string, url: string) {
  if (!url) return false;
  for (let at = prompt.indexOf(url); at >= 0; at = prompt.indexOf(url, at + 1)) {
    const next = prompt[at + url.length] ?? "";
    if (!/[\w/#?-]/.test(next)) return true;
  }
  return false;
}

/** The PR urls an open Orchestrator task is reviewing: not done and not failed. */
export function reviewingUrls(urls: readonly string[], items: readonly { task: { prompt: string }; column: string; kind: string }[]): ReadonlySet<string> {
  const open = items.filter((item) => item.column !== "done" && item.kind !== "failed");
  return new Set(urls.filter((url) => open.some((item) => mentionsUrl(item.task.prompt, url))));
}
