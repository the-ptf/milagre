import { useEffect, useState } from "react";
import { designScope, libraryProject, type DesignLibraryChat, type DesignSystemView } from "@milagre/shared/artifact";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";

export type Loaded<T> = { value: T | null; error: string; retry: () => void };

/** One read of the Designs page, done again when the Project's library or design system changes, or on `retry`. */
const READS = {
  system: (api: ReturnType<typeof bridgeForKey>["artifacts"], key: string) => api.designSystem(designScope(key)),
  chats: (api: ReturnType<typeof bridgeForKey>["artifacts"], key: string) => api.libraryChats(designScope(key)),
};

function useDesignsRead<T>(projectKey: string, kind: keyof typeof READS): Loaded<T> {
  const [state, setState] = useState<{ value: T | null; error: string }>({ value: null, error: "" });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    const api = bridgeForKey(projectKey).artifacts;
    const project = libraryProject(projectKey);
    return api.onLibraryChanged((payload) => {
      if (payload?.projectPath === project) setReads((count) => count + 1);
    });
  }, [projectKey]);
  useEffect(() => {
    let live = true;
    (READS[kind](bridgeForKey(projectKey).artifacts, projectKey) as Promise<T>)
      .then((value) => live && setState({ value, error: "" }))
      .catch((error: unknown) => live && setState((current) => ({ value: current.value, error: ipcErrorMessage(error) })));
    return () => {
      live = false;
    };
  }, [projectKey, kind, reads]);
  return { ...state, retry: () => setReads((count) => count + 1) };
}

export const useDesignSystem = (projectKey: string) => useDesignsRead<DesignSystemView>(projectKey, "system");
export const useDesignChats = (projectKey: string) => useDesignsRead<DesignLibraryChat[]>(projectKey, "chats");
