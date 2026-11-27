import { useMemo, type ReactNode } from "react";
import { GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { useShortcutLabel } from "../../lib/keybindings";
import { IconButton } from "../primitives/Button";
import Tooltip from "../primitives/Tooltip";

/** The sidebar footer's Pull requests button: pressed while the page is open. */
export function PullRequestsButton({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const shortcut = useShortcutLabel("pull-requests.open");
  return (
    <Tooltip label="Pull requests" shortcut={shortcut}>
      <IconButton size={32} label="Pull requests" icon={GitPullRequestIcon} aria-pressed={active} data-sidebar-pull-requests onClick={onOpen} />
    </Tooltip>
  );
}

/** The footer's left-group buttons after Add Project and Filters: the usage button when shown, then Pull requests. Kept stable for the memoized sidebar. */
export function useFooterButtons(usageButton: ReactNode, pullRequestsActive: boolean, onOpenPullRequests: () => void): ReactNode {
  return useMemo(
    () => (
      <>
        {usageButton}
        <PullRequestsButton active={pullRequestsActive} onOpen={onOpenPullRequests} />
      </>
    ),
    [usageButton, pullRequestsActive, onOpenPullRequests],
  );
}
