export type NotificationChime = "system" | "miracle" | "faaah" | "bombastic-side-eye" | "vine-boom" | "metal-pipe" | "bruh" | "emotional-damage";
export const NOTIFICATION_CHIMES: ReadonlyArray<{ id: NotificationChime; label: string }>;
export const DEFAULT_NOTIFICATION_CHIME: NotificationChime;
export function parseNotificationChime(value: unknown): NotificationChime;
export function notificationChimeLabel(id: unknown): string;
export function notificationChimeFile(id: unknown): string | null;
export function notificationChimeSound(id: unknown): string;
export function notificationChimeChannel(id: unknown): string;
