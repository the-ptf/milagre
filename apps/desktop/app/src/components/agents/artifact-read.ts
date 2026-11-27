import { useEffect, useMemo, useState } from "react";
import { createDesignFontReader, designScope, libraryProject, restoreDesignFonts, type Artifact } from "@milagre/shared/artifact";
import { useDesignsEnabled } from "../../lib/designs-enabled";
import { bridgeForKey, isRemoteKey, onComputerConnection } from "../../lib/computer-bridge";
import { designPreviews } from "./design-preview-cache";

const versionsRead = new Map<string, Promise<Artifact>>();
const versionsKept = new Map<string, Artifact>();
const fontReaders = new WeakMap<object, ReturnType<typeof createDesignFontReader<Artifact>>>();
const KEEP = 48;
export function readArtifact(chatId: string, id: string, version: number | null): Promise<Artifact> {
  const api = bridgeForKey(chatId).artifacts;
  const request = { ...designScope(chatId), id, ...(version === null ? {} : { version }) };
  const readDesign = () => {
    let reader = fontReaders.get(api);
    if (!reader) {
      reader = createDesignFontReader((args) => api.get(args));
      fontReaders.set(api, reader);
      if (isRemoteKey(chatId)) onComputerConnection(chatId, reader.reconnect, () => fontReaders.delete(api));
    }
    return reader(request);
  };
  if (version === null) return readDesign();
  const key = `${chatId}\n${id}\n${version}`;
  let read = versionsRead.get(key);
  if (!read) {
    read = readDesign();
    versionsRead.set(key, read);
    read.then(
      (artifact) => {
        versionsKept.set(key, artifact);
        for (const old of versionsKept.keys()) {
          if (versionsKept.size <= KEEP) break;
          versionsKept.delete(old);
          designPreviews.delete(old);
          versionsRead.delete(old);
        }
      },
      () => versionsRead.delete(key),
    );
  }
  return read;
}
export const isVersionKept = (key: string) => versionsKept.has(key);

/** The Project's design system changed: its screens' kept versions are drawn again from the host. */
function forgetProjectDesigns(project: string) {
  for (const key of new Set([...versionsRead.keys(), ...versionsKept.keys()])) {
    if (libraryProject(key.slice(0, key.indexOf("\n"))) !== project) continue;
    versionsRead.delete(key);
    versionsKept.delete(key);
    designPreviews.delete(key);
  }
}

/** A count that moves each time the design system of the Project `chatId` belongs to changes. */
export function useDesignKitRevision(chatId: string | null): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const api = chatId && window.milagre ? bridgeForKey(chatId).artifacts : undefined;
    if (!chatId || !api?.onLibraryChanged) return;
    const project = libraryProject(chatId);
    return api.onLibraryChanged((payload) => {
      if (payload?.projectPath !== project || !payload.kit) return;
      forgetProjectDesigns(project);
      setRevision((count) => count + 1);
    });
  }, [chatId]);
  return revision;
}
const keptArtifact = (chatId: string | null, id: string, version: number | null) =>
  (chatId && version !== null && versionsKept.get(`${chatId}\n${id}\n${version}`)) || null;

export function useArtifact(chatId: string | null, id: string, version: number | null, revision?: number) {
  const { enabled } = useDesignsEnabled(chatId);
  const kitRevision = useDesignKitRevision(chatId);
  const [state, setState] = useState<{
    artifact: Artifact | null;
    error: string | null;
  }>(() => ({ artifact: keptArtifact(chatId, id, version), error: null }));
  useEffect(() => {
    if (!chatId) return;
    let live = true;
    readArtifact(chatId, id, version)
      .then((artifact) => live && setState({ artifact, error: null }))
      .catch(
        (error: unknown) =>
          live &&
          setState({
            artifact: null,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      live = false;
    };
  }, [chatId, id, version, enabled, revision, kitRevision]);
  return chatId && (enabled || state.artifact?.format === "html") ? state : { artifact: null, error: null };
}

/** Kept designs leave their fonts out: a frame that draws one puts them back for as long as it shows. */
export const useFramedHtml = (artifact: Artifact) => useMemo(() => restoreDesignFonts(artifact).html, [artifact]);
