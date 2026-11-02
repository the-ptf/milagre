/** The line above a chat's queued messages: when they go. */
export function queueStatus(options: { count: number; held: boolean; running: boolean }): string;
export type MessageDelivery = "queue" | "now";
export type FollowUps = "now" | "queue";
type FollowUpOption = { value: FollowUps; label: string; description: string };
export const FOLLOW_UP_OPTIONS: readonly [FollowUpOption, FollowUpOption];
export function followUpDelivery(followUps: FollowUps | undefined): MessageDelivery | undefined;
