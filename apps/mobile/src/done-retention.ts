import { useEffect, useState } from "react";
import { DONE_DEFAULTS, normalizeDoneSettings, type DoneSettings } from "@milagre/shared/done";

type Caller = { call<T>(method: string, args?: unknown[]): Promise<T> };

export const readDoneSettings = (client: Caller) => client.call<DoneSettings>("done:settings:read", []).then(normalizeDoneSettings);
export const saveDoneSettings = (client: Caller, patch: Partial<DoneSettings>) =>
  client.call<DoneSettings>("done:settings:save", [patch]).then(normalizeDoneSettings);

export const retentionOf = (hours: Record<string, number>, hostId: string) => hours[hostId] ?? DONE_DEFAULTS.retentionHours;

export function useDoneRetention(hostIds: string[], clientOf: (hostId: string) => Caller | null, visible: boolean) {
  const [hours, setHours] = useState<Record<string, number>>({});
  const key = hostIds.join("\n");
  useEffect(() => {
    if (!visible || !key) return;
    let live = true;
    for (const hostId of key.split("\n")) {
      const client = clientOf(hostId);
      if (!client) continue;
      void readDoneSettings(client)
        .then(({ retentionHours }) => live && setHours((current) => (current[hostId] === retentionHours ? current : { ...current, [hostId]: retentionHours })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clientOf reads the latest connections; the computers listed and being on screen decide when to read.
  }, [key, visible]);
  return hours;
}
