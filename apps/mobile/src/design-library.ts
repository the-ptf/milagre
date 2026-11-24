import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { designScope, type DesignLibrary, type DesignLibraryEntry, type DesignLibraryPage } from "@milagre/shared/artifact";
import type { MenuSection } from "./primitives/menu";
import { promptText } from "./text-prompt";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
type MenuItem = MenuSection["items"][number];

const listeners = new WeakMap<object, Set<() => void>>();

/** The computer said its Project library changed: every open sheet reading it from `client` reads it again. */
export function designLibraryChanged(client: object) {
  for (const listener of listeners.get(client) ?? []) listener();
}

function onDesignLibraryChanged(client: object, listener: () => void): () => void {
  let set = listeners.get(client);
  if (!set) listeners.set(client, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

/**
 * The design library of the Chat's Project (or of the Project `chatId` names, for its Design library page), read again
 * when the computer says it changed or `revision` moves. Null until it answers, and on a computer from before the library.
 */
export function useDesignLibrary(source: Caller | null, chatId: string | undefined, revision?: unknown): DesignLibrary | null {
  const [state, setState] = useState<{ source: Caller | null; chatId?: string; library: DesignLibrary | null }>({ source: null, library: null });
  const [reads, setReads] = useState(0);
  useEffect(() => (source ? onDesignLibraryChanged(source, () => setReads((count) => count + 1)) : undefined), [source]);
  useEffect(() => {
    if (!source || !chatId) return;
    let live = true;
    source
      .call<DesignLibrary>("design-library:list", [designScope(chatId)])
      .then((library) => {
        if (live && Array.isArray(library?.pages)) setState({ source, chatId, library });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source, chatId, revision, reads]);
  return source && state.source === source && state.chatId === chatId ? state.library : null;
}

const ADD = "library-add:";

/** The design or page action that adds it to the library: a submenu of the library's pages, then a new one. */
function libraryAddItem(pages: DesignLibraryPage[]): MenuItem {
  return {
    id: "library",
    title: "Add to Project library",
    systemImage: "books.vertical",
    submenu: [...pages.map((page) => ({ id: `${ADD}${page.id}`, title: page.name })), { id: ADD, title: "New page…", systemImage: "plus" }],
  };
}

/** The actions section with Add to Project library; none until the library answers (or on a computer without one). */
export const libraryAddSections = (library: DesignLibrary | null): MenuSection[] => (library ? [{ items: [libraryAddItem(library.pages)] }] : []);

export const isLibraryAdd = (action: string) => action.startsWith(ADD);

/**
 * Adds a design of the Chat (or its HTML page, one `tab`) to the library page `action` names, asking for a name when it
 * is a new page. Resolves with the library's copy, or null when cancelled or refused (the refusal shows in an alert).
 */
export async function addToLibrary(
  source: Caller,
  action: string,
  pages: DesignLibraryPage[],
  request: { chatId: string; designId: string; tab?: string },
): Promise<DesignLibraryEntry | null> {
  const id = action.slice(ADD.length);
  const page = id
    ? pages.find((item) => item.id === id)?.name
    : (
        await promptText("New library page", {
          message: "Every Chat in this Project can open the designs on it, such as iPhone, Watch or Kit.",
          action: "Add",
        })
      )?.trim();
  if (!page) return null;
  try {
    return await source.call<DesignLibraryEntry>("design-library:add", [{ ...request, page }]);
  } catch (error) {
    Alert.alert("Could not add it to the Project library", error instanceof Error ? error.message : String(error));
    return null;
  }
}

const MOVE = "move:";
const failed = (title: string) => (error: unknown) => Alert.alert(title, error instanceof Error ? error.message : String(error));

/**
 * A library design's Rename and Move to page actions: a submenu of the library's pages, its own checked, then a new one.
 * None until the library and the design are known.
 */
export function libraryEditSections(library: DesignLibrary | null, design: DesignLibraryEntry | undefined): MenuSection[] {
  if (!library || !design) return [];
  const { pages } = library;
  return [
    {
      items: [
        { id: "rename", title: "Rename", systemImage: "pencil" },
        {
          id: "move",
          title: "Move to page",
          systemImage: "folder",
          submenu: [
            ...pages.map((page) => ({ id: `${MOVE}${page.id}`, title: page.name, checked: page.id === design.page })),
            { id: MOVE, title: "New page…", systemImage: "plus" },
          ],
        },
      ],
    },
  ];
}

/**
 * Renames the library design, or moves it to the page `action` names, asking for the name first, through the library
 * of the Chat or Project `scopeKey` names. Resolves false for any other action, true once the computer has made the
 * change or nothing was asked for.
 */
export async function editLibraryDesign(source: Caller, scopeKey: string, pages: DesignLibraryPage[], design: DesignLibraryEntry, action: string) {
  const scope = designScope(scopeKey);
  if (action === "rename") {
    const title = (await promptText("Rename design", { value: design.title }))?.trim();
    if (title && title !== design.title)
      await source.call("design-library:update", [{ ...scope, id: design.id, title }]).catch(failed("Could not rename the design"));
    return true;
  }
  if (!action.startsWith(MOVE)) return false;
  const id = action.slice(MOVE.length);
  const page = id
    ? pages.find((item) => item.id === id)?.name
    : (await promptText("New library page", { message: "Such as iPhone, Watch or Kit.", action: "Move" }))?.trim();
  if (page && id !== design.page) await source.call("design-library:update", [{ ...scope, id: design.id, page }]).catch(failed("Could not move the design"));
  return true;
}

/** Renames the library page `page` after asking for its new name. */
export async function renameLibraryPage(source: Caller, scopeKey: string, page: DesignLibraryPage) {
  const name = (await promptText("Rename page", { value: page.name }))?.trim();
  if (name && name !== page.name)
    await source.call("design-library:rename-page", [{ ...designScope(scopeKey), page: page.id, name }]).catch(failed("Could not rename the page"));
}
