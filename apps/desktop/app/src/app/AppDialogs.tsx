import type { ComponentProps, ReactNode } from "react";
import { AddComputerDialog } from "../components/AddComputerDialog";
import { AddProjectDialog } from "../components/AddProjectDialog";
import { Notice as NoticeCard } from "../components/Notice";
import { SettingsModal } from "../components/settings/SettingsModal";
import { WorktreeCleanup } from "../components/settings/WorktreeCleanup";
import { bridgeFor } from "../lib/computer-bridge";
import { lazyView } from "../lib/lazy-view";
import type { OpenProject } from "../model";
import type { AppDialogsState } from "./useAppDialogs";

// Not on screen at first paint, so each loads as its own chunk; App fetches them once the window is idle.
export const SettingsNav = lazyView(() => import("../components/Settings").then((module) => module.SettingsNav));
const SettingsPanel = lazyView(() => import("../components/Settings").then((module) => module.SettingsPanel));

type PanelProps = ComponentProps<typeof SettingsPanel>;

export function AppSettingsModal({
  dialogs,
  project,
  inProject,
  projectSettings,
  notice,
  onDismissNotice,
  accountScope,
  models,
  update,
  onOpenUsageChat,
}: {
  dialogs: AppDialogsState;
  project: OpenProject | null;
  /** Settings beside a Project shows that Project's sections; over a Link or the Chats home, only a Project picked in it. */
  inProject: boolean;
  projectSettings: boolean;
  notice: ReactNode;
  onDismissNotice: () => void;
  accountScope: PanelProps["accountScope"];
  models: PanelProps["models"];
  update: PanelProps["update"];
  onOpenUsageChat: PanelProps["onOpenUsageChat"];
}) {
  const { settingsSection, setSettingsSection, settingsProject, settingsComputer } = dialogs;
  if (!dialogs.settingsOpen) return null;
  // The Chats home is no Project to the user: it is never the Settings Project, and a leftover Project section falls back.
  const shownSettingsProject = settingsProject ?? (projectSettings ? (project ?? undefined) : undefined);
  const shownSettingsSection = settingsSection === "project" && !shownSettingsProject ? "general" : settingsSection;
  const section = inProject ? shownSettingsSection : settingsSection;
  const shownProject = (inProject ? shownSettingsProject : settingsProject) ?? undefined;
  return (
    <SettingsModal
      onClose={() => dialogs.setSettingsOpen(false)}
      nav={
        <SettingsNav
          showProjectSettings={inProject || !!settingsProject}
          section={section}
          project={shownProject}
          current={inProject && projectSettings ? (project ?? undefined) : undefined}
          onSelect={setSettingsSection}
          computerId={settingsComputer ?? undefined}
          onSelectComputer={dialogs.selectSettingsComputer}
          onSelectProject={(picked) => {
            dialogs.setSettingsProject(picked);
            setSettingsSection("project");
          }}
        />
      }
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {notice && inProject && (
          <NoticeCard className="mx-auto mt-2 mb-1 max-w-2xl" onDismiss={onDismissNotice}>
            {notice}
          </NoticeCard>
        )}
        <SettingsPanel
          section={section}
          project={shownProject}
          computerId={settingsComputer ?? undefined}
          accountScope={accountScope}
          models={models}
          update={update}
          onSectionChange={setSettingsSection}
          onAddComputer={dialogs.openAddComputer}
          onOpenUsageChat={onOpenUsageChat}
        />
      </div>
    </SettingsModal>
  );
}

/** Add computer, Clean up worktrees and Add Project: the same in a Link's window and a Project's. */
export function AppDialogs({
  dialogs,
  computerName,
  onLinkProjects,
  onOpened,
}: {
  dialogs: AppDialogsState;
  computerName: (id: string) => string | null;
  onLinkProjects: () => void;
  onOpened: ComponentProps<typeof AddProjectDialog>["onOpened"];
}) {
  const { storageComputer, setAddComputerOpen, setAddProjectOpen } = dialogs;
  return (
    <>
      {dialogs.addComputerOpen ? <AddComputerDialog onClose={() => setAddComputerOpen(false)} onAdded={() => setAddComputerOpen(false)} /> : null}
      {storageComputer === undefined ? null : (
        <WorktreeCleanup
          bridge={bridgeFor(storageComputer)}
          computerName={storageComputer ? computerName(storageComputer) : null}
          onClose={() => dialogs.setStorageComputer(undefined)}
        />
      )}
      {dialogs.addProjectOpen ? (
        <AddProjectDialog
          onClose={() => setAddProjectOpen(false)}
          onLinkProjects={() => {
            setAddProjectOpen(false);
            onLinkProjects();
          }}
          onOpened={(opened) => {
            setAddProjectOpen(false);
            onOpened(opened);
          }}
        />
      ) : null}
    </>
  );
}
