import type { EffortLevel, PermissionMode } from "../model";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export type ComposerPreferences = {
  modelId?: string;
  effort?: EffortLevel;
  ultracode?: boolean;
  fastMode?: boolean;
  permissionMode?: PermissionMode;
};

const KEY = "milagre.composer-preferences";

export function readComposerPreferences(storage: Storage): Record<string, ComposerPreferences> {
  try {
    return JSON.parse(storage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function saveComposerPreferences(storage: Storage, chatKey: string, patch: Partial<ComposerPreferences>) {
  const saved = readComposerPreferences(storage);
  const previous = saved[chatKey] ?? {};
  try {
    storage.setItem(
      KEY,
      JSON.stringify({
        ...saved,
        [chatKey]: { ...previous, ...patch },
      }),
    );
  } catch {}
}
