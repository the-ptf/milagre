import type { MenuSection } from "./primitives/menu";
import type { DesignsTab } from "./panel-tabs";

export type ArtifactPageEntry = { id: string; title: string };
export type ArtifactPageChoice = { kind: "canvas" } | { kind: "page"; tab: string } | { kind: "library"; page: string };
type Remembered = { last: "canvas" | "page"; design?: string; page?: { id: string; tab: string } };

const remembered = new Map<string, Remembered>();
const keyOf = (hostId: string, chatId: string) => `${hostId}|${chatId}`;

export function rememberCanvas(hostId: string, chatId: string, design: string) {
  remembered.set(keyOf(hostId, chatId), { ...remembered.get(keyOf(hostId, chatId)), last: "canvas", design });
}

export function rememberPage(hostId: string, chatId: string, id: string, tab: string) {
  remembered.set(keyOf(hostId, chatId), { ...remembered.get(keyOf(hostId, chatId)), last: "page", page: { id, tab } });
}

/** The page of the Artifact the user last viewed in this Chat, and the design and tab they last had open in each. */
export function lastArtifactPage(hostId: string, chatId: string): Remembered | undefined {
  return remembered.get(keyOf(hostId, chatId));
}

export function rememberedTab(hostId: string | undefined, chatId: string | undefined, pageId: string | undefined): string | undefined {
  if (!hostId || !chatId || !pageId) return undefined;
  const page = remembered.get(keyOf(hostId, chatId))?.page;
  return page?.id === pageId ? page.tab : undefined;
}

/**
 * The page menu of the Artifact's header: Canvas when the Chat has designs, then the HTML page as its tabs (or its title
 * when it has none), then the pages of the Project library. `current` is checked.
 */
/** The page menu entry that opens the Project's Design library page. */
export const OPEN_DESIGN_LIBRARY = "open-library";

export function artifactPageSections({
  canvas,
  page,
  library = [],
  current,
  openLibrary = false,
}: {
  canvas: boolean;
  page: { title: string; tabs: ArtifactPageEntry[] } | null;
  library?: { id: string; name: string }[];
  current: ArtifactPageChoice;
  /** The library section ends with Open Design library, the Project's whole library page. */
  openLibrary?: boolean;
}): MenuSection[] {
  const sections: MenuSection[] = [];
  if (canvas) sections.push({ items: [{ id: "canvas", title: "Canvas", systemImage: "square.grid.2x2", checked: current.kind === "canvas" }] });
  if (page) {
    const tabs = page.tabs.length ? page.tabs : [{ id: "", title: page.title }];
    sections.push({
      ...(page.tabs.length > 1 ? { title: page.title } : {}),
      items: tabs.map((tab) => ({ id: `page:${tab.id}`, title: tab.title, checked: current.kind === "page" && current.tab === tab.id })),
    });
  }
  if (library.length)
    sections.push({
      title: "Project library",
      items: [
        ...library.map((item) => ({
          id: `library:${item.id}`,
          title: item.name,
          systemImage: "books.vertical",
          checked: current.kind === "library" && current.page === item.id,
        })),
        ...(openLibrary ? [{ id: OPEN_DESIGN_LIBRARY, title: "Open Design library", systemImage: "arrow.up.forward.square" }] : []),
      ],
    });
  return sections;
}

/** The Versions section of a design's actions, newest first, `version` checked. None for a design with one version. */
export function versionSections(latest: number, version: number): MenuSection[] {
  if (latest <= 1) return [];
  const items = Array.from({ length: latest }, (_, index) => latest - index).map((number) => ({
    id: `version:${number}`,
    title: `Version ${number}${number === latest ? " (latest)" : ""}`,
    checked: number === version,
  }));
  return [{ title: "Versions", items }];
}

export const pageEntries = (sections: MenuSection[]) => sections.reduce((count, section) => count + section.items.length, 0);

export function readPageChoice(id: string): ArtifactPageChoice | null {
  if (id === "canvas") return { kind: "canvas" };
  if (id.startsWith("library:")) return { kind: "library", page: id.slice("library:".length) };
  return id.startsWith("page:") ? { kind: "page", tab: id.slice("page:".length) } : null;
}

/** The route params that show `target` on the phone's Artifact sheet in place of what it shows. */
export function artifactRouteParams(target: DesignsTab): Record<string, string | undefined> {
  return {
    hostId: target.hostId,
    chatId: target.chatId,
    id: target.id,
    kind: target.html ? "html" : undefined,
    library: target.library,
    version: target.version,
    chosen: target.chosen,
    tab: target.tab,
    comment: target.comment,
    requestId: target.requestId,
  };
}
