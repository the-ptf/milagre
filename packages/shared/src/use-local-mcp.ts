import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalMcpApi, LocalMcpConfiguration, LocalMcpCredential, LocalMcpStatus } from "./local-mcp";

/** Both settings screens share request ordering and one-time credential lifetime. */
export function useLocalMcp(api: LocalMcpApi | undefined) {
  const [status, setStatus] = useState<LocalMcpStatus | null>(null);
  const [credential, setCredential] = useState<LocalMcpCredential | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const acting = useRef(false);
  const refresh = useCallback(async () => {
    if (!api) {
      setError("Update Milagre on the computer to configure local connections.");
      return;
    }
    const id = generation.current;
    const request = ++statusRequest.current;
    try {
      const next = await api.status();
      if (generation.current === id && statusRequest.current === request) {
        setError("");
        setStatus(next);
        setCheckedAt(Date.now());
      }
    } catch {
      if (generation.current === id && statusRequest.current === request)
        setError("Could not load local connections. Check the computer connection and retry.");
    }
  }, [api]);
  useEffect(() => {
    generation.current++;
    setCredential(null);
    setStatus(null);
    setError("");
    setBusy(false);
    acting.current = false;
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const act = async (
    action: () => Promise<LocalMcpCredential | unknown>,
    failure = "Could not save the connection. Check its scope and computer connection, then retry. If creation lost its reply, revoke the listed connection and create another.",
  ) => {
    if (acting.current || !api) return false;
    acting.current = true;
    statusRequest.current++;
    const id = generation.current;
    setBusy(true);
    setError("");
    setCredential(null);
    try {
      const result = await action();
      if (generation.current !== id) return false;
      if (result && typeof result === "object" && "token" in result) setCredential(result as LocalMcpCredential);
      await refresh();
      return true;
    } catch {
      // A failed reply can follow a successful revoke or install. Show the host's current state.
      if (generation.current === id) await refresh();
      if (generation.current === id) setError(failure);
      return false;
    } finally {
      if (generation.current === id) {
        acting.current = false;
        setBusy(false);
      }
    }
  };
  return {
    status,
    credential,
    error,
    busy,
    checkedAt,
    refresh,
    dismiss: () => setCredential(null),
    create: (config: LocalMcpConfiguration) => act(() => api!.create(config)),
    update: (id: string, config: LocalMcpConfiguration) => act(() => api!.update(id, config)),
    rotate: (id: string) => act(() => api!.rotate(id)),
    revoke: (id: string) => act(() => api!.revoke(id)),
    enableClient: (id: string, input: LocalMcpConfiguration) =>
      act(() => api!.enableClient(id, input), "Could not set up this client. Check its access choices and configuration file, then retry."),
    disableClient: (id: string) => act(() => api!.disableClient(id), "Could not confirm access was revoked. Check the computer connection and retry."),
  };
}
