// The sound a notification plays, chosen in Settings > Notifications on desktop and on the phone. Each device keeps its
// own choice. "system" is the platform's own notification sound; every other chime is a short clip Milagre ships:
// desktop plays it from the app, the phone has it bundled so a push names it (iOS) or uses its channel (Android).

/** In the menu's order. */
export const NOTIFICATION_CHIMES = [
  { id: "system", label: "System default" },
  { id: "miracle", label: "Miracle" },
  { id: "faaah", label: "FAAAH" },
  { id: "bombastic-side-eye", label: "Bombastic side eye" },
  { id: "vine-boom", label: "Vine boom" },
  { id: "metal-pipe", label: "Metal pipe" },
  { id: "bruh", label: "Bruh" },
  { id: "emotional-damage", label: "Emotional damage" },
];

export const DEFAULT_NOTIFICATION_CHIME = "system";

const IDS = new Set(NOTIFICATION_CHIMES.map((chime) => chime.id));

/** A saved or received chime id, or the default when it is missing or unknown (a chime a newer device added). */
export function parseNotificationChime(value) {
  return typeof value === "string" && IDS.has(value) ? value : DEFAULT_NOTIFICATION_CHIME;
}

export function notificationChimeLabel(id) {
  return NOTIFICATION_CHIMES.find((chime) => chime.id === parseNotificationChime(id))?.label ?? "System default";
}

/** The bundled file's name, `chime_<id>`, without extension. Android raw resources allow only [a-z0-9_]. null for "system". */
export function notificationChimeFile(id) {
  const chime = parseNotificationChime(id);
  return chime === "system" ? null : `chime_${chime.replaceAll("-", "_")}`;
}

/** What a push sends as `sound`: the bundled wav for a chime, or the default sound. */
export function notificationChimeSound(id) {
  const file = notificationChimeFile(id);
  return file ? `${file}.wav` : "default";
}

/** The Android channel that plays a chime: a channel's sound is fixed once created, so each chime has its own. */
export function notificationChimeChannel(id) {
  const file = notificationChimeFile(id);
  return file ? `chats-${file.slice("chime_".length)}` : "chats";
}
