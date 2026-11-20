import { Delete02Icon } from "@hugeicons/core-free-icons";
import Tooltip from "../primitives/Tooltip";
import { Button, IconButton } from "../primitives/Button";
import { bridgeForKey } from "../../lib/computer-bridge";
import { DESIGN_DELETED, type DesignDeleted } from "./design-events";
import { designScope } from "./design-library";

export type Deleting = "confirm" | "busy" | null;

/**
 * A design frame's delete action, confirmed in place. On a Project library page it removes the design from the library
 * for every Chat instead.
 */
export function DesignDeleteButton({
  chatId,
  id,
  title,
  library,
  deleting,
  onDeleting,
  onError,
}: {
  chatId: string;
  id: string;
  title: string;
  library: boolean;
  deleting: Deleting;
  onDeleting: (state: Deleting) => void;
  onError: (message: string) => void;
}) {
  const remove = async () => {
    onDeleting("busy");
    onError("");
    try {
      await bridgeForKey(chatId).artifacts.delete({ ...designScope(chatId), id });
      window.dispatchEvent(new CustomEvent<DesignDeleted>(DESIGN_DELETED, { detail: { chatId, id } }));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
      onDeleting(null);
    }
  };
  if (!deleting)
    return (
      <Tooltip label={library ? "Remove from the Project library" : "Delete design"} asChild>
        <IconButton
          data-slot="artifact-delete"
          variant="danger-ghost"
          label={library ? `Remove ${title} from the Project library` : `Delete ${title}`}
          icon={Delete02Icon}
          size={24}
          onClick={() => onDeleting("confirm")}
        />
      </Tooltip>
    );
  const busy = deleting === "busy";
  return (
    <span className="flex items-center gap-1">
      <Button
        variant="danger"
        size={24}
        data-slot="artifact-delete-confirm"
        aria-label={library ? `Remove ${title} from the Project library for every Chat` : `Delete ${title} and every version`}
        disabled={busy}
        onClick={() => void remove()}
      >
        {busy ? (library ? "Removing…" : "Deleting…") : library ? "Remove" : "Delete"}
      </Button>
      <Button variant="ghost" size={24} disabled={busy} onClick={() => onDeleting(null)}>
        Cancel
      </Button>
    </span>
  );
}
