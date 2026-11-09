// Auto update's copy, the same on the Mac's Settings › About, a paired desktop's Computer page and the phone's Mac
// settings. The switch lives on the host (core app-auto-update.cjs); the desktop updater acts on it.

export const AUTO_UPDATE_TITLE = "Auto update";
export const AUTO_UPDATE_HINT =
  "Installs a downloaded update by itself once no Chat or Routine is running and nobody has used the Mac for 5 minutes. For a Mac nobody watches, like a server.";
/** The update notice's line while an update waits with Auto update on. */
export const AUTO_UPDATE_WAITING = "Auto update is on: Milagre restarts by itself once no Chat or Routine is running and the Mac sits unused.";
