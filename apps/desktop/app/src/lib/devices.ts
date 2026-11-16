import { ago } from "@milagre/shared/main-sync";
import type { PairedDevice } from "../electron";

export function deviceName(device: Pick<PairedDevice, "kind" | "name">): string {
  return device.name ?? (device.kind === "computer" ? "Computer" : "Phone");
}

export function deviceSeenLine(device: Pick<PairedDevice, "route" | "lastSeen">, now: number): string {
  if (device.route === "lan") return "Connected now, same network";
  if (device.route === "relay") return "Connected now, relay";
  if (device.lastSeen === null) return "Not seen yet";
  return `Last seen ${ago(device.lastSeen, now)}`;
}

export function newDeviceKeys(devices: Pick<PairedDevice, "key" | "isNew">[]): string[] {
  return devices.filter((device) => device.isNew === true).map((device) => device.key);
}

export const removeDeviceQuestion = (device: Pick<PairedDevice, "kind" | "name">) => `Remove ${deviceName(device)}? It can pair again from Pair a device.`;

const order = (a: PairedDevice, b: PairedDevice) => Number(b.route !== null) - Number(a.route !== null) || (b.lastSeen ?? -1) - (a.lastSeen ?? -1);

export function devicesByKind(devices: PairedDevice[]): { computers: PairedDevice[]; phones: PairedDevice[] } {
  return {
    computers: devices.filter((device) => device.kind === "computer").sort(order),
    phones: devices.filter((device) => device.kind === "phone").sort(order),
  };
}
