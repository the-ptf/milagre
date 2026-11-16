import type { ComponentProps } from "react";
import { ChangesPanel, firstSection } from "../components/changes/ChangesPanel";
import { ChangesPanelSlot } from "../components/changes/ChangesPanelSlot";
import { PullRequestPanelBody, type PullRequestPanelActions } from "../components/changes/PullRequestPanel";
import type { useChanges } from "../components/changes/useChanges";
import type { useLocalChanges, usePullRequest } from "../components/changes/usePullRequest";

type PullRequestProps = NonNullable<ComponentProps<typeof ChangesPanel>["pullRequest"]>;

/** The Project's Changes panel, with the open Chat's PR as its last section. */
export function ProjectChangesPanel({
  changes,
  prReview,
  localChanges,
  commentCounts,
  prNumber,
  prChoices,
  onPickPr,
  source,
  actions,
}: {
  changes: ReturnType<typeof useChanges>;
  prReview: ReturnType<typeof usePullRequest>;
  localChanges: ReturnType<typeof useLocalChanges>;
  commentCounts: ComponentProps<typeof ChangesPanel>["commentCounts"];
  prNumber: number | undefined;
  prChoices: PullRequestProps["choices"];
  onPickPr: PullRequestProps["onPick"];
  source: ComponentProps<typeof PullRequestPanelBody>["source"];
  actions: PullRequestPanelActions;
}) {
  return (
    <ChangesPanelSlot open={changes.open}>
      <ChangesPanel
        lists={changes.lists}
        comparison={changes.comparison}
        mode={changes.mode}
        onModeChange={changes.setMode}
        onRefresh={() => {
          if (changes.mode !== "pr") return changes.refresh();
          localChanges.refresh();
          return Promise.all([changes.refresh(), prReview.refresh()]);
        }}
        onSelectFile={changes.selectFile}
        activePath={changes.activePath}
        commentCounts={commentCounts}
        pullRequest={
          prNumber
            ? {
                number: prNumber,
                choices: prChoices,
                onPick: onPickPr,
                loading: prReview.state.status === "loading" || prReview.busy !== null,
                body: (
                  <PullRequestPanelBody
                    review={prReview}
                    source={source}
                    actions={actions}
                    activePath={changes.activePath}
                    local={{ count: localChanges.count, onOpen: () => changes.setMode(firstSection(changes.lists)) }}
                  />
                ),
              }
            : undefined
        }
      />
    </ChangesPanelSlot>
  );
}
