import type { SidePanel } from "../components/agents/PanelToggles";
import { firstSection } from "../components/changes/ChangesPanel";

type Changes = {
  open: boolean;
  lists: Parameters<typeof firstSection>[0];
  setMode: (mode: ReturnType<typeof firstSection>) => void;
  toggle: () => void;
  showPullRequest: () => void;
};

/** The Changes and pull request panels as the title bar's buttons and a split's Panels menu offer them. */
export function changesPanelButtons(changes: Changes, available: boolean, prShown: boolean, prNumber: number | null | undefined) {
  if (!available) return {};
  const changesPanel: SidePanel = {
    open: changes.open && !prShown,
    toggle: () => {
      if (!changes.open || prShown) changes.setMode(firstSection(changes.lists));
      if (!prShown) changes.toggle();
    },
  };
  const pullRequest = prNumber ? { number: prNumber, open: prShown, toggle: () => (prShown ? changes.toggle() : changes.showPullRequest()) } : undefined;
  return { changes: changesPanel, pullRequest };
}
