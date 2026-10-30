// A Milagre desktop app's update as its updater reports it (apps/desktop/electron/app-updates.cjs), and the copy every
// place that shows one uses: the Mac's Settings › About, a paired desktop's Computer page and the phone's Settings ›
// General. The phone and paired desktops read it through the Mac's host (app-update:state, check and install).

export type AppUpdateState = {
  status: "idle" | "checking" | "up-to-date" | "downloading" | "downloaded" | "installing" | "error" | "unavailable";
  version: string | null;
  progress: number;
  error?: string;
  /** Auto update is on: a downloaded update installs by itself once nothing runs (Settings › About). */
  auto?: boolean;
};

/**
 * app-update:state: the update of the desktop app open on that Mac and the version it runs, or null when no desktop app is
 * open there (the host runs on its own).
 */
export type HostUpdate = (AppUpdateState & { current: string }) | null;

export function updateDescription(update: AppUpdateState | null): string {
  switch (update?.status) {
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return "Milagre is up to date.";
    case "downloading":
      return `Downloading ${update.version ? `Milagre ${update.version}` : "update"}… ${Math.round(update.progress)}%`;
    case "downloaded":
      return `${update.version ? `Milagre ${update.version}` : "The update"} is ready to install.${update.auto ? " Auto update installs it once nothing is running." : ""}`;
    case "installing":
      return "Saving your work and restarting Milagre.";
    case "error":
      return update.error ?? "Couldn't check for updates. Try again.";
    case "unavailable":
      return "Update checks are available in the installed app.";
    default:
      return "Check for the latest Milagre release.";
  }
}

/** The updater is at work (or can't check at all): Check for updates waits. */
export const updateBusy = (update: AppUpdateState | null) =>
  update?.status === "checking" || update?.status === "downloading" || update?.status === "installing" || update?.status === "unavailable";

/** "Update available: v0.233.0" while a newer release downloads or waits to install; null otherwise. */
export const updateAvailable = (update: AppUpdateState | null) =>
  (update?.status === "downloading" || update?.status === "downloaded") && update.version ? `Update available: v${update.version}` : null;

/** The question before installing on another computer, which restarts Milagre there. */
export function installQuestion(computer: string, version: string | null) {
  return {
    title: `Restart Milagre on ${computer} to install ${version ? `v${version}` : "the update"}?`,
    message: "Running Chats are saved and resume after the restart.",
    action: "Install & restart",
  };
}

/** Shown in place of the update while that Mac's host runs with no desktop app open. */
export const noDesktopUpdate = (computer: string) => `Open Milagre on ${computer} to check for updates.`;
