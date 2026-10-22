export type NotificationSchedule = { days: number[]; start: string; end: string; timeZone: string };
export const NOTIFICATION_DAYS: string[];
export const NOTIFICATION_TIMES: { value: string; label: string }[];
export function workHoursSchedule(timeZone?: string): NotificationSchedule;
export function notificationTimeZones(): string[];
export function parseNotificationSchedule(value: unknown): NotificationSchedule | null;
export function notificationAllowed(schedule: NotificationSchedule | null | undefined, now?: number): boolean;
