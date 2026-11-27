import { useEffect, useRef, useState } from "react";
import type { SettingsSection } from "../components/Settings";
import type { GitChatContext } from "../lib/git-dialog";
import type { RecentProject } from "../lib/project-list";
import { useEvent } from "../lib/stable";
import { onDraftChatRequest } from "../lib/draft-chat-request";
import { OPEN_STORAGE } from "../lib/storage-open";
import type { ModelProvider } from "../model";

type GitDialogTarget = {
  sessionId: number;
  worktreeId: number;
  cwd: string;
  base?: string;
  provider?: ModelProvider;
  chat: GitChatContext;
};

function useRecentProjects(paletteOpen: boolean) {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    window.milagre
      .listRecentProjects()
      .then((projects) => {
        if (!cancelled) setRecentProjects(projects);
      })
      .catch(() => {
        if (!cancelled) setRecentProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen]);
  return recentProjects;
}

function useStorageComputer() {
  const [storageComputer, setStorageComputer] = useState<string | null | undefined>(undefined);
  const onOpenStorage = useEvent((event: Event) => setStorageComputer((event as CustomEvent<string | null>).detail ?? null));
  useEffect(() => {
    window.addEventListener(OPEN_STORAGE, onOpenStorage);
    return () => window.removeEventListener(OPEN_STORAGE, onOpenStorage);
  }, [onOpenStorage]);
  return [storageComputer, setStorageComputer] as const;
}

/**
 * The window's dialogs and the Settings modal. `place` names the Link, Project and Chat on screen: opening another one
 * leaves Settings.
 */
export function useAppDialogs(place: string) {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<false | "commands" | "messages">(false);
  const recentProjects = useRecentProjects(commandPaletteOpen !== false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => onDraftChatRequest(() => setSettingsOpen(false)), []);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const shownPlace = useRef(place);
  useEffect(() => {
    const before = shownPlace.current;
    shownPlace.current = place;
    if (before !== place && !before.startsWith("||")) setSettingsOpen(false);
  }, [place]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsProject, setSettingsProject] = useState<{ path: string; name: string } | null>(null);
  const [settingsComputer, setSettingsComputer] = useState<string | null>(null);
  const [addComputerOpen, setAddComputerOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [gitDialog, setGitDialog] = useState<GitDialogTarget | null>(null);
  const [storageComputer, setStorageComputer] = useStorageComputer();
  const openSettingsAt = (section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };
  const openSettings = useEvent(() => setSettingsOpen(true));
  const openAccounts = useEvent(() => openSettingsAt("accounts"));
  const openComputerSettings = useEvent((id: string | null) => {
    if (id === null) setSettingsSection("this-mac");
    else {
      setSettingsComputer(id);
      setSettingsSection("computer");
    }
    setSettingsOpen(true);
  });
  const selectSettingsComputer = (id: string) => {
    setSettingsComputer(id);
    setSettingsSection("computer");
  };
  const openCommandPalette = useEvent((mode?: unknown) => setCommandPaletteOpen(mode === "messages" ? "messages" : "commands"));
  const openAddComputer = useEvent(() => setAddComputerOpen(true));
  return {
    commandPaletteOpen,
    setCommandPaletteOpen,
    openCommandPalette,
    recentProjects,
    settingsOpen,
    setSettingsOpen,
    settingsOpenRef,
    settingsSection,
    setSettingsSection,
    openSettingsAt,
    openSettings,
    openAccounts,
    settingsProject,
    setSettingsProject,
    settingsComputer,
    setSettingsComputer,
    openComputerSettings,
    selectSettingsComputer,
    addComputerOpen,
    setAddComputerOpen,
    openAddComputer,
    addProjectOpen,
    setAddProjectOpen,
    gitDialog,
    setGitDialog,
    storageComputer,
    setStorageComputer,
  };
}

export type AppDialogsState = ReturnType<typeof useAppDialogs>;
