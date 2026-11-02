/** The line above a chat's queued messages: when they go. */
export function queueStatus(options: { count: number; held: boolean; running: boolean }): string;
export type MessageDelivery = "queue" | "now";
export const DEFAULT_MESSAGE_DELIVERY: MessageDelivery;
type DeliveryOption = { value: MessageDelivery; label: string; description: string };
export function deliveryOptions(canSteer: boolean): [DeliveryOption, DeliveryOption];
