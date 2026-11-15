import { useCallback, useRef } from "react";
import { type Session } from "./session";
import { dropBefore, moveProject } from "./project-order-store";
import { type ProjectHeaderEntry } from "./navigation-row";

import type { HostView } from "./all-computers-store";

/** The Project headers on screen, and the drop that reorders the open computer's Projects. */
export function useProjectReorder({ views, currentHostId, session }: { views: HostView[]; currentHostId?: string; session: Session }) {
  // Every Project header on screen, with a way to measure where it is now. The drop measures them as it lands, so a
  // list scrolled since they laid out still finds the right place.
  const headers = useRef(new Map<string, ProjectHeaderEntry>());
  const registerHeader = useCallback((key: string, entry: ProjectHeaderEntry | null) => {
    if (entry) headers.current.set(key, entry);
    else headers.current.delete(key);
  }, []);
  // A Project header released with the finger at window-Y `y`: it goes before the header the finger is over (after it
  // on that header's lower half, last below them all). Only the open computer's Projects reorder; the order is this
  // phone's, which the session saves per computer.
  const reorderProjects = useCallback(
    async (hostId: string, path: string, y: number) => {
      const view = views.find((item) => item.hostId === hostId);
      if (!view || hostId !== currentHostId) return;
      const placed = await Promise.all(
        [...headers.current.values()]
          .filter((entry) => entry.hostId === hostId && entry.path !== path)
          .map(async (entry) => ({ path: entry.path, ...(await entry.measure()) })),
      );
      const beforePath = dropBefore(placed, y);
      const order = view.projects.map((project) => project.path);
      const next = moveProject(order, path, beforePath);
      if (next.every((item, index) => item === order[index])) return;
      session.reorderProjects(next);
    },
    [views, currentHostId, session],
  );
  return { registerHeader, reorderProjects };
}
