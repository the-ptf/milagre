import { useEffect, useRef, useState } from "react";
import { shortcutCommand } from "../../lib/keybindings";

export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_WIDTH_KEY = "milagre.sidebarWidth";

const clampSidebarWidth = (width: number) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));

function readSidebarWidth() {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_MIN_WIDTH;
}

const AUTO_COLLAPSE_QUERY = "(max-width: 1024px)";

export function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(() => window.matchMedia(AUTO_COLLAPSE_QUERY).matches);
  const autoCollapsed = useRef(collapsed);
  const [expandedWidth, setExpandedWidth] = useState(readSidebarWidth);
  const collapse = () => {
    setCollapsed(true);
  };

  const toggle = () => {
    autoCollapsed.current = false;
    if (collapsed) setCollapsed(false);
    else collapse();
  };

  useEffect(() => {
    const query = window.matchMedia(AUTO_COLLAPSE_QUERY);
    const follow = () => {
      if (query.matches) {
        setCollapsed((current) => {
          if (!current) autoCollapsed.current = true;
          return true;
        });
      } else if (autoCollapsed.current) {
        autoCollapsed.current = false;
        setCollapsed(false);
      }
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  useEffect(() => {
    function handleToggle(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      if (shortcutCommand(event) !== "sidebar.toggle") return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", handleToggle);
    return () => window.removeEventListener("keydown", handleToggle);
  }, [collapsed]);

  const saveWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    setExpandedWidth(next);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  };
  return { collapsed, toggle, expandedWidth, setExpandedWidth, saveWidth };
}
