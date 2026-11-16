import { useEffect, useState } from "react";

export function useLinear(): { ready: boolean; active: boolean } {
  const [enabled, setEnabled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const reads = Promise.all([
      Promise.resolve()
        .then(() => window.milagre.readLinearEnabled())
        .then(
          (value) => value?.enabled === true,
          () => false,
        ),
      Promise.resolve()
        .then(() => window.milagre.readLinearStatus())
        .then(
          (value) => value?.connected === true,
          () => false,
        ),
    ]);
    const apply = async () => {
      const [on, linked] = await reads;
      if (!live) return;
      setEnabled(on);
      setConnected(linked);
      setReady(true);
    };
    void apply();
    const stopStatus = window.milagre.onLinearStatusChanged?.((next) => {
      if (live) setConnected(next.connected);
    });
    const stopEnabled = window.milagre.onLinearEnabledChanged?.((next) => {
      if (live) setEnabled(next.enabled);
    });
    return () => {
      live = false;
      stopStatus?.();
      stopEnabled?.();
    };
  }, []);
  return { ready, active: enabled && connected };
}
