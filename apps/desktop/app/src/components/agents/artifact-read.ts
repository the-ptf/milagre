import { useEffect, useState } from "react";
import { createDesignFontReader, restoreDesignFonts, type Artifact } from "@milagre/shared/artifact";
import { useDesignsEnabled } from "../../lib/designs-enabled";
import { bridgeForKey, isRemoteKey, onComputerConnection } from "../../lib/computer-bridge";
import { designPreviews } from "./design-preview-cache";

const versionsRead = new Map<string, Promise<Artifact>>();
const versionsKept = new Map<string, Artifact>();
const fontReaders = new WeakMap<object, ReturnType<typeof createDesignFontReader<Artifact>>>();
const KEEP = 48;
export function readArtifact(chatId: string, id: string, version: number | null): Promise<Artifact> {
  const api = bridgeForKey(chatId).artifacts;
  const request = { chatId, id, ...(version === null ? {} : { version }) };
  const readDesign = () => {
    if (!isRemoteKey(chatId)) return api.get(request);
    let reader = fontReaders.get(api);
    if (!reader) {
      reader = createDesignFontReader((args) => api.get(args));
      fontReaders.set(api, reader);
      onComputerConnection(chatId, reader.reconnect, () => fontReaders.delete(api));
    }
    return reader(request).then(restoreDesignFonts);
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
const keptArtifact = (chatId: string | null, id: string, version: number | null) =>
  (chatId && version !== null && versionsKept.get(`${chatId}\n${id}\n${version}`)) || null;

export function useArtifact(chatId: string | null, id: string, version: number | null, revision?: number) {
  const { enabled } = useDesignsEnabled(chatId);
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
  }, [chatId, id, version, enabled, revision]);
  return chatId && (enabled || state.artifact?.format === "html") ? state : { artifact: null, error: null };
}
