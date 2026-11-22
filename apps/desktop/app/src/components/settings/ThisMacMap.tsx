import { useEffect, useMemo, useState } from "react";
import { machineKindOf } from "@milagre/shared/computer-map";
import type { PairedDevice, PhoneStatus } from "../../electron";
import { useComputers } from "../../lib/computers";
import { incomingRelayHost, thisMacMachines } from "../../lib/computer-map";
import { preferenceStorage } from "../../lib/preference-storage";
import { thisComputer } from "../../lib/shortcut-hints";
import { ComputerMap } from "./ComputerMap";

export type ComputersView = "map" | "list";
const VIEW_KEY = "milagre.computers-view";

export function useComputersView(): [ComputersView, (view: ComputersView) => void] {
  const [view, setView] = useState<ComputersView>(() => (preferenceStorage.getItem(VIEW_KEY) === "list" ? "list" : "map"));
  return [
    view,
    (next) => {
      preferenceStorage.setItem(VIEW_KEY, next);
      setView(next);
    },
  ];
}

/** Paired devices and how they reach this Mac, read again on every pairing change and every 15 seconds. Never marks a device as seen. */
function usePairedDeviceRoutes() {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      window.milagre.listDevices().then(
        (list) => live && setDevices(list),
        () => {},
      );
    };
    read();
    window.milagre.getPhoneStatus().then(
      (phone) => live && setStatus(phone),
      () => {},
    );
    const off = window.milagre.onPhoneStatus((phone) => {
      setStatus(phone);
      read();
    });
    const timer = window.setInterval(read, 15_000);
    return () => {
      live = false;
      off();
      window.clearInterval(timer);
    };
  }, []);
  return { devices, relayHost: incomingRelayHost(status) };
}

/** Settings › This Mac › Map: the phones and computers that drive this Mac, this Mac, and the computers it drives. */
export function ThisMacMap() {
  const { thisMac, computers } = useComputers();
  const { devices, relayHost } = usePairedDeviceRoutes();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const machines = useMemo(() => thisMacMachines(computers, devices, now, relayHost), [computers, devices, now, relayHost]);
  const label = thisComputer.charAt(0).toUpperCase() + thisComputer.slice(1);
  return (
    <ComputerMap
      hubName={thisMac}
      hubKind={machineKindOf(thisMac)}
      hubLabel={label}
      machines={machines}
      empty="No phones or other computers yet. Pair one in Phone & sharing, or add a computer below."
    />
  );
}
