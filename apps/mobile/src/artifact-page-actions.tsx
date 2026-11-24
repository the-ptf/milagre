import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type { DesignLibrary, HtmlArtifact } from "@milagre/shared/artifact";
import { openArtifactShare, showArtifactPage } from "./artifact-page-menu";
import { addToLibrary, isLibraryAdd, libraryAddSections } from "./design-library";
import type { DesignsTab } from "./panel-tabs";
import { CircleButton, PullDown, type MenuSection } from "./ui";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };

/**
 * The HTML page's ⋯ actions: resolved comments, Share, and Add to Project library (the tab shown), which then opens the
 * library page it went on. A page that shows files can't go to the library yet, so it doesn't offer it. A plain
 * function, not a component: the menu is drawn in the sheet's own tree.
 */
export function artifactPageActions({
  source,
  hostId,
  chatId,
  page,
  tab,
  sharing,
  library,
  showResolved,
  onShowResolved,
  onPage,
}: {
  source: Caller | null;
  hostId?: string;
  chatId?: string;
  page: HtmlArtifact | null;
  tab?: string;
  sharing: boolean;
  library: DesignLibrary | null;
  showResolved: boolean;
  onShowResolved: (shown: boolean) => void;
  onPage?: (target: DesignsTab) => void;
}) {
  const menu: MenuSection[] = [
    { items: [{ id: "resolved", title: "Show resolved comments", checked: showResolved }] },
    ...(sharing
      ? [
          {
            items: [
              { id: "share", title: "Share", systemImage: "square.and.arrow.up" },
              { id: "share-page", title: "Share this page" },
            ],
          },
        ]
      : []),
    ...(page && source && !page.assets?.length ? libraryAddSections(library) : []),
  ];
  const add = (action: string) => {
    if (!source || !chatId || !hostId || !library || !page) return;
    void addToLibrary(source, action, library.pages, { chatId, designId: page.id, ...(page.tabs && tab ? { tab } : {}) }).then(
      (entry) => entry && showArtifactPage({ hostId, chatId, id: entry.id, library: entry.page }, onPage),
    );
  };
  return (
    <PullDown
      label="Page actions"
      sections={menu}
      onSelect={(action) => {
        if (action === "resolved") onShowResolved(!showResolved);
        else if (action === "share") openArtifactShare(hostId, chatId, "workspace");
        else if (action === "share-page") openArtifactShare(hostId, chatId, "artifacts");
        else if (isLibraryAdd(action)) add(action);
      }}
    >
      <CircleButton asTrigger label="Page actions" icon={MoreHorizontalIcon} />
    </PullDown>
  );
}
