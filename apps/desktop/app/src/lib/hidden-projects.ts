import { useEffect, useState } from "react";
import { RECENT_PROJECTS_CHANGED } from "./project-list";

const NONE: ReadonlySet<string> = new Set();

/** The Projects hidden from the sidebar (Settings or the sidebar's project menu), read again each time one is hidden or shown. */
export function useHiddenProjects(): ReadonlySet<string> {
  const [hidden, setHidden] = useState(NONE);
  useEffect(() => {
    let live = true;
    const read = () =>
      void window.milagre
        ?.listRecentProjects?.()
        .then((list) => {
          if (!live || !Array.isArray(list)) return;
          const paths = list.filter((project) => project.hidden).map((project) => project.path);
          setHidden((previous) => (paths.length === previous.size && paths.every((path) => previous.has(path)) ? previous : new Set(paths)));
        })
        .catch(() => {});
    read();
    window.addEventListener(RECENT_PROJECTS_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(RECENT_PROJECTS_CHANGED, read);
    };
  }, []);
  return hidden;
}
