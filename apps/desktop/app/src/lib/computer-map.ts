import { machineKindOf, mergeTwoWay, routeCount, routeName, type MapLineState, type MapMachine } from "@milagre/shared/computer-map";
import type { ComputerView, PairedDevice, PhoneStatus } from "../electron";
import { deviceName, deviceSeenLine } from "./devices";
import { seenAgo } from "./computers";

function drivenState(state: ComputerView["state"]): MapLineState {
  if (state === "online") return "active";
  if (state === "connecting" || state === "reconnecting") return "standby";
  if (state === "refused") return "degraded";
  return "offline";
}

function drivenDetail(view: ComputerView, routes: number, now: number): string {
  switch (view.state) {
    case "online":
      return `Online · ${routeCount(routes)}`;
    case "connecting":
    case "reconnecting":
      return "Connecting…";
    case "refused":
      return view.message ?? "Pair again with a new link";
    case "off":
      return "Off";
    default: {
      const ago = seenAgo(view.lastSeen, now);
      return ago ? `Offline, seen ${ago}` : "Offline";
    }
  }
}

/** A computer this Mac drives: its line shows the route in use, or the relay it falls back to while it isn't connected. */
function drivenMachine(view: ComputerView, now: number): MapMachine {
  const routes = 1 + (view.lan || view.lanRoutes.length > 0 ? 1 : 0);
  const route = view.state === "online" ? view.route : view.lanRoutes.length > 0 && !view.relayHost ? "lan" : "relay";
  return {
    id: `computer:${view.id}`,
    name: view.name,
    kind: machineKindOf(view.name),
    state: drivenState(view.state),
    route: routeName(route, { address: view.address, relayHost: view.relayHost }),
    detail: drivenDetail(view, routes, now),
    direction: "out",
  };
}

/** A phone or computer paired to this Mac, which drives it: in use while it is connected, standby otherwise. */
function pairedMachine(device: PairedDevice, now: number, relayHost: string | null = null): MapMachine {
  const name = deviceName(device);
  return {
    id: `device:${device.key}`,
    name,
    kind: machineKindOf(name, { phone: device.kind === "phone" }),
    state: device.route ? "active" : "standby",
    route: device.route ? routeName(device.route, { relayHost }) : "Not connected",
    detail: deviceSeenLine(device, now),
    direction: "in",
  };
}

/** The relay paired devices reach this Mac through: the tunnel's host behind a Cloudflare tunnel, else Milagre's relay. */
export const incomingRelayHost = (status: Pick<PhoneStatus, "remote" | "publicUrl"> | null): string | null =>
  status?.remote === "cloudflare" && status.publicUrl ? status.publicUrl : null;

export const thisMacMachines = (computers: ComputerView[], devices: PairedDevice[], now: number, relayHost: string | null = null): MapMachine[] =>
  mergeTwoWay(
    computers.map((view) => drivenMachine(view, now)),
    devices.map((device) => pairedMachine(device, now, relayHost)),
  );
