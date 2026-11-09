import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { useCallback, useState } from "react";
import { Layout2ColumnIcon, LayoutTopIcon, RefreshIcon, TextWrapIcon } from "@hugeicons/core-free-icons";
import Tooltip from "../primitives/Tooltip";
import { Icon } from "../primitives/Icon";
import { IconButton } from "../primitives/Button";
import type { DiffLayout } from "./DiffFile";
import type { Changes } from "./useChanges";
import { useRefreshSpin } from "./useRefreshSpin";

const LAYOUT_KEY = "milagre:diff-layout";
const WRAP_KEY = "milagre:diff-wrap";

/** Unified/Split and Wrap, remembered across launches. */
export function useDiffPreferences() {
  const [layout, setLayoutState] = useState<DiffLayout>(() => (localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified"));
  const [wrap, setWrapState] = useState(() => localStorage.getItem(WRAP_KEY) === "on");
  const setLayout = useCallback((next: DiffLayout) => {
    localStorage.setItem(LAYOUT_KEY, next);
    setLayoutState(next);
  }, []);
  const setWrap = useCallback((next: boolean) => {
    localStorage.setItem(WRAP_KEY, next ? "on" : "off");
    setWrapState(next);
  }, []);
  return { layout, setLayout, wrap, setWrap };
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
  ...rest
}: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <Tooltip label={label} side="bottom" align="end">
      <IconButton label={label} size={28} aria-pressed={active} disabled={disabled} onClick={onClick} {...rest}>
        {children}
      </IconButton>
    </Tooltip>
  );
}

export function DiffToolbar({ changes, prefs }: { changes: Changes; prefs: ReturnType<typeof useDiffPreferences> }) {
  const icon = (glyph: typeof RefreshIcon) => <Icon icon={glyph} size={16} />;
  const spin = useRefreshSpin(() => changes.refresh());
  return (
    <div data-diff-toolbar className="flex items-center gap-0.5 no-drag">
      <ToolButton label="Unified" active={prefs.layout === "unified"} onClick={() => prefs.setLayout("unified")} data-diff-layout="unified">
        {icon(LayoutTopIcon)}
      </ToolButton>
      <ToolButton label="Split" active={prefs.layout === "split"} onClick={() => prefs.setLayout("split")} data-diff-layout="split">
        {icon(Layout2ColumnIcon)}
      </ToolButton>
      <ToolButton
        label={prefs.layout === "split" ? "Split view always wraps" : "Wrap lines"}
        active={prefs.layout === "split" || prefs.wrap}
        disabled={prefs.layout === "split"}
        onClick={() => prefs.setWrap(!prefs.wrap)}
        data-diff-wrap=""
      >
        {icon(TextWrapIcon)}
      </ToolButton>
      <ToolButton label="Refresh" onClick={spin.refresh} data-diff-refresh-all="" data-busy={spin.busy ? "" : undefined}>
        <span
          className={spin.spinning ? "refresh-spin animate-spin" : ""}
          onAnimationIteration={spin.onAnimationIteration}
          onAnimationEnd={spin.onAnimationEnd}
        >
          {icon(RefreshIcon)}
        </span>
      </ToolButton>
    </div>
  );
}

/**
 * Whether the diff occupies the main column: while it shows and while it slides out, so the chat only comes back
 * once the diff has left instead of sharing the column with it.
 */
export function useDiffPresence(showing: boolean) {
  const [leaving, setLeaving] = useState(false);
  const [wasShowing, setWasShowing] = useState(showing);
  if (wasShowing !== showing) {
    setWasShowing(showing);
    setLeaving(!showing);
  }
  return { occupied: showing || leaving, onExitComplete: () => setLeaving(false) };
}
