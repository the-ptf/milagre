import { useSyncExternalStore } from "react";
import {
  ORCHESTRATOR_DEFAULTS,
  isMemoryImporting,
  normalizeOrchestratorMemory,
  type OrchestratorMemoryNote,
  type OrchestratorSettings,
  type OrchestratorSnapshot,
  type BoardColumn,
  type OrchestratorTask,
} from "@milagre/shared/orchestrator";
import { DELETE_UNDO_MS, deleteUndoWindow, undoDelete } from "@milagre/shared/archive";
import { taskForChat } from "./orchestrator-board";
import { getSettings } from "./settings";
import { undoHistory } from "./undo-history";

const EMPTY: OrchestratorSnapshot = { settings: { ...ORCHESTRATOR_DEFAULTS }, tasks: [], memory: normalizeOrchestratorMemory(null) };

let snapshot = EMPTY;
let received = EMPTY;
let loaded = false;
let started = false;
const listeners = new Set<() => void>();
const sentHere = new Set<string>();
const deleting = new Set<string>();

function apply(next: OrchestratorSnapshot | null | undefined) {
  if (!next?.settings) return;
  received = next;
  snapshot = deleting.size ? { ...next, tasks: next.tasks.filter((task) => !deleting.has(task.id)) } : next;
  loaded = true;
  listeners.forEach((notify) => notify());
}

function start() {
  if (started) return;
  started = true;
  window.milagre.onOrchestrator?.(apply);
  void window.milagre
    .readOrchestrator?.()
    .then(apply)
    .catch(() => {});
}

function subscribe(notify: () => void) {
  start();
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function useOrchestrator(): OrchestratorSnapshot & { loaded: boolean } {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return { ...current, loaded };
}

/** The model and effort the Orchestrator started this Chat with, so its composer shows them until someone picks another. */
export function useTaskTurn(key: string | null): { model: string | null; effort: string | null } {
  const model = useSyncExternalStore(subscribe, () => taskForChat(snapshot.tasks, key)?.model ?? null);
  const effort = useSyncExternalStore(subscribe, () => taskForChat(snapshot.tasks, key)?.effort ?? null);
  return { model, effort };
}

function withTask(task: OrchestratorTask | null) {
  if (!task) return;
  const tasks = snapshot.tasks.some((entry) => entry.id === task.id)
    ? snapshot.tasks.map((entry) => (entry.id === task.id ? task : entry))
    : [...snapshot.tasks, task];
  apply({ ...snapshot, tasks });
}

export async function saveOrchestratorSettings(patch: Partial<OrchestratorSettings>) {
  apply({ ...snapshot, settings: { ...snapshot.settings, ...patch } });
  const settings = await window.milagre.saveOrchestratorSettings(patch);
  apply({ ...snapshot, settings });
  return settings;
}

export async function sendOrchestratorTask(prompt: string, images: { id: string; name: string; dataUrl: string }[] = []) {
  const task = await window.milagre.sendToOrchestrator(prompt, {
    permissionMode: getSettings().defaultPermissionMode,
    ...(images.length ? { images } : {}),
  });
  sentHere.add(task.id);
  withTask(task);
  return task;
}

export const wasSentHere = (taskId: string) => sentHere.has(taskId);

export async function pickTaskProject(taskId: string, projectPath: string) {
  withTask(await window.milagre.pickOrchestratorProject(taskId, projectPath));
}

export async function rerouteTask(taskId: string, change: { projectPath?: string; role?: string }) {
  sentHere.add(taskId);
  const current = snapshot.tasks.find((task) => task.id === taskId);
  if (current) withTask({ ...current, state: "routing", sessionId: null, error: null });
  withTask(await window.milagre.rerouteOrchestratorTask(taskId, change));
}

export async function undoTask(taskId: string) {
  apply({ ...snapshot, tasks: snapshot.tasks.filter((task) => task.id !== taskId) });
  await window.milagre.undoOrchestratorTask(taskId);
}

export async function dismissTask(taskId: string) {
  apply({ ...snapshot, tasks: snapshot.tasks.filter((task) => task.id !== taskId) });
  await window.milagre.dismissOrchestratorTask(taskId);
}

export async function moveTask(taskId: string, column: BoardColumn) {
  await window.milagre.moveOrchestratorTask(taskId, column);
}

const deleteKey = (taskId: string) => `orchestrator-task:${taskId}`;

/** Takes the task off the board at once and deletes it with its Chat once the Undo toast's time is up. */
export async function deleteTask(taskId: string) {
  deleting.add(taskId);
  apply(received);
  undoHistory.record({
    text: "Task deleted",
    kind: "deleted",
    undoneText: "Task restored",
    undo: () => undoDelete(deleteKey(taskId)),
    undoWindowMs: DELETE_UNDO_MS,
  });
  const undone = await deleteUndoWindow(deleteKey(taskId));
  if (!undone) await window.milagre.deleteOrchestratorTask(taskId).catch((error: Error) => undoHistory.notify(`Couldn't delete the task: ${error.message}`));
  deleting.delete(taskId);
  apply(received);
}

export async function showTaskInSidebar(taskId: string, shown: boolean) {
  await window.milagre.showOrchestratorTaskInSidebar(taskId, shown);
}

export async function importMemory() {
  const memory = await window.milagre.importOrchestratorMemory();
  apply({ ...snapshot, memory });
  await new Promise<void>((resolve) => {
    const check = () => {
      if (isMemoryImporting(snapshot.memory)) return;
      listeners.delete(check);
      resolve();
    };
    listeners.add(check);
    check();
  });
  return snapshot.memory;
}

export async function saveMemoryNotes(notes: OrchestratorMemoryNote[]) {
  apply({ ...snapshot, memory: { ...snapshot.memory, notes } });
  const memory = await window.milagre.saveOrchestratorMemory(notes);
  apply({ ...snapshot, memory });
}

export async function forgetMemory() {
  const memory = await window.milagre.forgetOrchestratorMemory();
  apply({ ...snapshot, memory });
}

let pendingOpen: string | null = null;
let boxFocus = 0;
const navListeners = new Set<() => void>();
const navChanged = () => navListeners.forEach((notify) => notify());
const subscribeNav = (notify: () => void) => {
  navListeners.add(notify);
  return () => navListeners.delete(notify);
};

let followed: { taskId: string; leaving: string | null } | null = null;

/** Opens the task's Chat once it has a new one, as after Re-route starts it over; `leaving` is the Chat it had. */
export function followTask(taskId: string | null, leaving: string | null = null) {
  followed = taskId ? { taskId, leaving } : null;
}

export const followedTask = () => followed;

export function requestTaskOpen(key: string | null) {
  pendingOpen = key;
  navChanged();
}

export function focusOrchestratorBox() {
  boxFocus += 1;
  navChanged();
}

export function useOrchestratorNav() {
  const open = useSyncExternalStore(subscribeNav, () => pendingOpen);
  const focus = useSyncExternalStore(subscribeNav, () => boxFocus);
  return { pendingOpen: open, boxFocus: focus };
}

export function orchestratorEnabled() {
  start();
  return snapshot.settings.enabled;
}
