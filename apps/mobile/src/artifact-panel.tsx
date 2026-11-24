import { ArtifactSheet } from "./artifact";
import { DesignsSheet } from "./designs-sheet";
import { LibrarySheet } from "./library-sheet";
import type { DesignsTab } from "./panel-tabs";

/** The Artifact in the iPad's panel tab: the Chat's canvas, its HTML page, or a page of the Project library. */
export function ArtifactPanel({ target, onClose, onPage }: { target: DesignsTab; onClose: () => void; onPage: (target: DesignsTab) => void }) {
  const { hostId, chatId, id } = target;
  if (target.library)
    return (
      <LibrarySheet
        key={`${hostId}:${chatId}:library:${target.library}`}
        hostId={hostId}
        chatId={chatId}
        page={target.library}
        id={id}
        onClose={onClose}
        onPage={onPage}
      />
    );
  if (target.html)
    return (
      <ArtifactSheet
        key={`${hostId}:${chatId}:${id}`}
        hostId={hostId}
        chatId={chatId}
        id={id}
        tab={target.tab}
        comment={target.comment}
        requestId={target.requestId}
        onClose={onClose}
        onPage={onPage}
      />
    );
  return (
    <DesignsSheet
      key={`${hostId}:${chatId}:${id}:${target.version}`}
      hostId={hostId}
      chatId={chatId}
      id={id}
      version={target.version}
      chosen={target.chosen}
      comment={target.comment}
      requestId={target.requestId}
      onClose={onClose}
      onPage={onPage}
    />
  );
}
