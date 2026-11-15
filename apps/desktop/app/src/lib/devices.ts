import { ago } from "@milagre/shared/main-sync";
import type { PairedDevice } from "../electron";

/** What a device is called: its own name, or what it is when it sent none. */
export function deviceName(device: Pick<PairedDevice, "kind" | "name">): string {
  return device.name ?? (device.kind === "computer" ? "Computer" : "Phone");
}

/** The line under a device's name in Settings › Phone & sharing. */
export function deviceSeenLine(device: Pick<PairedDevice, "route" | "lastSeen">, now: number): string {
  if (device.route === "lan") return "Connected now, same network";
  if (device.route === "relay") return "Connected now, relay";
  if (device.lastSeen === null) return "Not seen yet";
  return `Last seen ${ago(device.lastSeen, now)}`;
}

/** Keys of the phones that paired since the owner last looked at Settings › Phone & sharing. */
export function newDeviceKeys(devices: Pick<PairedDevice, "key" | "isNew">[]): string[] {
  return devices.filter((device) => device.isNew === true).map((device) => device.key);
}

/** Shown in place of that line while Remove waits for a second click. */
export const removeDeviceQuestion = (device: Pick<PairedDevice, "kind" | "name">) => `Remove ${deviceName(device)}? It can pair again from Pair a device.`;

const order = (a: PairedDevice, b: PairedDevice) => Number(b.route !== null) - Number(a.route !== null) || (b.lastSeen ?? -1) - (a.lastSeen ?? -1);

/** The two lists, each with what is connected first and then the most recently seen. */
export function devicesByKind(devices: PairedDevice[]): { computers: PairedDevice[]; phones: PairedDevice[] } {
  return {
    computers: devices.filter((device) => device.kind === "computer").sort(order),
    phones: devices.filter((device) => device.kind === "phone").sort(order),
  };
}
