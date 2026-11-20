import { useEffect, useState } from "react";
import { designScope, libraryProject, type DesignLibrary, type DesignLibraryPage } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import { bridgeForKey } from "../../lib/computer-bridge";

const LIBRARY_PAGE = "library:";
export type LibraryDockPage = `library:${string}`;
export const libraryDockPage = (pageId: string): LibraryDockPage => `${LIBRARY_PAGE}${pageId}`;
export const libraryPageId = (page: string | null | undefined): string | null => (page?.startsWith(LIBRARY_PAGE) ? page.slice(LIBRARY_PAGE.length) : null);

const kept = new Map<string, DesignLibrary>();

/**
 * The design library of the Chat's Project (or of the Project `chatId` names, for its Design library page), read again
 * whenever an agent in any of its Chats, or this window, changes it. Null until the first read, and on a host from
 * before the library.
 */
export function useDesignLibrary(chatId: string | null): DesignLibrary | null {
  const [state, setState] = useState<{ chatId: string | null; library: DesignLibrary | null }>(() => ({
    chatId,
    library: (chatId && kept.get(chatId)) || null,
  }));
  const [reads, setReads] = useState(0);
  useEffect(() => {
    const api = chatId && window.milagre ? bridgeForKey(chatId).artifacts : undefined;
    if (!chatId || !api?.onLibraryChanged) return;
    const project = libraryProject(chatId);
    return api.onLibraryChanged((payload) => {
      if (payload?.projectPath === project) setReads((count) => count + 1);
    });
  }, [chatId]);
  useEffect(() => {
    const api = chatId && window.milagre ? bridgeForKey(chatId).artifacts : undefined;
    if (!chatId || !api?.library) return;
    let live = true;
    api
      .library(designScope(chatId))
      .then((library) => {
        if (!live || !Array.isArray(library?.pages)) return;
        kept.set(chatId, library);
        setState({ chatId, library });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatId, reads]);
  return state.chatId === chatId ? state.library : (chatId && kept.get(chatId)) || null;
}

export const libraryRefs = (page: DesignLibraryPage | undefined): ArtifactRef[] =>
  (page?.designs ?? []).map((design) => ({
    id: design.id,
    version: design.version,
    title: design.title,
    format: "design",
    ...(design.group ? { group: design.group } : {}),
  }));
