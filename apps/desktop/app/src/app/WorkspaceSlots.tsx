import { Activity, useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The workspaces a window keeps mounted: the one on screen, in the host, and the hidden ones in nodes of their own
 * outside the document (as ChatComposer parks transcripts), so nothing that queries the document meets them. A hidden
 * one is an <Activity> in its hidden mode: its state and DOM stay, its effects and listeners stop. The host takes the
 * shown slot's node as a ref, in the layout phase before the portals' own layout effects.
 */
export function WorkspaceSlots({ shown, slots }: { shown: string; slots: { key: string; element: ReactNode }[] }) {
  const [nodes] = useState(() => new Map<string, HTMLDivElement>());
  const nodeFor = (key: string) => {
    let node = nodes.get(key);
    if (!node) {
      node = document.createElement("div");
      node.className = "contents";
      node.dataset.workspaceSlot = key;
      nodes.set(key, node);
    }
    return node;
  };
  const host = useCallback(
    (hostNode: HTMLDivElement | null) => {
      if (!hostNode) return;
      for (const child of Array.from(hostNode.children)) if (child !== nodes.get(shown)) child.remove();
      const node = nodeFor(shown);
      if (node.parentElement !== hostNode) hostNode.appendChild(node);
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new callback per shown slot is what makes React run it again
    [shown],
  );
  return (
    <>
      <div ref={host} className="contents" />
      {slots.map((slot) => createPortal(<Activity mode={slot.key === shown ? "visible" : "hidden"}>{slot.element}</Activity>, nodeFor(slot.key), slot.key))}
    </>
  );
}
