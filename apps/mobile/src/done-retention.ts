import { useEffect, useState } from "react";
import { DONE_DEFAULTS, normalizeDoneSettings, type DoneSettings } from "@milagre/shared/done";

type Caller = { call<T>(method: string, args?: unknown[]): Promise<T> };

/** One computer's Done settings: how long a Chat stays in the Done list before that Mac archives it. */
export const readDoneSettings = (client: Caller) => client.call<DoneSettings>("done:settings:read", []).then(normalizeDoneSettings);
export const saveDoneSettings = (client: Caller, patch: Partial<DoneSettings>) =>
  client.call<DoneSettings>("done:settings:save", [patch]).then(normalizeDoneSettings);

/** A computer's retention from `useDoneRetention`'s answer, the default until it has one. */
export const retentionOf = (hours: Record<string, number>, hostId: string) => hours[hostId] ?? DONE_DEFAULTS.retentionHours;

/**
 * Each listed computer's retention, by host id, read while the list is on screen: a Done row counts down to its own
 * Mac's sweep. A Mac that can't say (older, or not answering) counts with the default.
 */
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
