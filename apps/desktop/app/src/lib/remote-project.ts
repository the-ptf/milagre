import type { CoordinatorState, OpenProject } from "../model";
import type { MilagreBridge, ProjectRead, StateStamp } from "../electron";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey, isRemoteKey } from "./computer-bridge.ts";
import { confirmHeldState, numberedState } from "./state-events.ts";

type Opened = OpenProject & StateStamp;

export function requestProject(projectPath: string): Promise<Opened> {
  return isRemoteKey(projectPath) ? readRemoteProject(bridgeForKey(projectPath), projectPath) : bridgeForKey(projectPath).switchProject(projectPath);
}

// A host before #1155 reads only its ten recent Projects; canvas:open-project, there since October, opens any it registered.
function openOnOlderHost(bridge: MilagreBridge, projectPath: string) {
  return (error: unknown): Promise<Opened> => {
    if (!String((error as Error | undefined)?.message).includes("Open this project in Milagre first")) throw error;
    return bridge.openCanvasProject(projectPath);
  };
}

export async function readRemoteProject(bridge: MilagreBridge, projectPath: string): Promise<Opened> {
  const older = openOnOlderHost(bridge, projectPath);
  const held = numberedState(projectPath);
  if (!held || !("worktrees" in held)) return bridge.readProject(projectPath, { state: true }).catch(older);
  const reply: ProjectRead | Opened = await bridge.readProject(projectPath, { state: false }).catch(older);
  if (reply.state?.sessions) return reply as Opened;
  confirmHeldState(projectPath, reply);
  const { version: _version, epoch: _epoch, ...header } = reply;
  return { ...header, state: (numberedState(projectPath) as CoordinatorState | undefined) ?? held } as Opened;
}

export function namedOpenFailure(projectPath: string | undefined, error: unknown, computerName: (computerId: string) => string): string {
  const message = ipcErrorMessage(error);
  return projectPath && isRemoteKey(projectPath) ? `${computerName(computerOfKey(projectPath))}: ${message}` : message;
}
