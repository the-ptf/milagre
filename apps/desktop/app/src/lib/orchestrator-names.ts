import { useEffect, useSyncExternalStore } from "react";
import { effortCopy } from "@milagre/shared/model-copy";
import type { AutopilotMode, MemoryGroup, OrchestratorTask } from "@milagre/shared/orchestrator";
import { MODEL_CATALOG, type EffortLevel, type ModelOption } from "../model";

type OrchestratorProject = { path: string; name: string };

let projects: OrchestratorProject[] = [];
let accounts = new Map<string, string>();
let accountLabels: string[] = [];
let version = 0;
let projectsRead = false;
let accountsRead = false;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function readOrchestratorProjects() {
  void window.milagre
    .readOrchestratorProjects()
    .then((list) => {
      projects = list
        .filter((project) => project.included)
        .map((project) => ({ path: project.path, name: project.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      changed();
      return projects;
    })
    .catch(() => {});
}

function readAccounts() {
  void window.milagre
    .listAccounts()
    .then((snapshot) => {
      accounts = new Map(snapshot.providers.flatMap((entry) => entry.accounts.map((account) => [account.id, account.label] as const)));
      accountLabels = [...new Set(accounts.values())];
      changed();
      return accounts;
    })
    .catch(() => {});
}

const projectName = (path: string | null) => (path ? (projects.find((project) => project.path === path)?.name ?? path.split("/").pop() ?? path) : "");
const accountLabel = (id: string | null) => (id ? (accounts.get(id) ?? "Its own account") : "The Project's account");

export function useOrchestratorNames() {
  const seen = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (!projectsRead) {
      projectsRead = true;
      readOrchestratorProjects();
    }
    if (accountsRead) return;
    accountsRead = true;
    readAccounts();
    window.milagre.onAccountsChanged?.(readAccounts);
  }, []);
  return { version: seen, projects, accountLabels, projectName, accountLabel };
}

export function modelName(id: string | null, models: readonly ModelOption[] = MODEL_CATALOG): string {
  if (!id) return "No model";
  return models.find((model) => model.id === id)?.name ?? id;
}

export function routeLabel(task: Pick<OrchestratorTask, "model" | "effort">, models?: readonly ModelOption[]): string {
  const name = modelName(task.model, models);
  return task.effort ? `${name} · ${effortCopy(task.effort as EffortLevel).name}` : name;
}

export const GROUP_TITLES: Record<MemoryGroup, string> = { work: "How you work", projects: "Your Projects", tools: "Your tools", other: "Other" };
export const AUTOPILOT_TITLES: Record<AutopilotMode, string> = { answer: "Answer for me", ask: "Ask me first", off: "Off" };
