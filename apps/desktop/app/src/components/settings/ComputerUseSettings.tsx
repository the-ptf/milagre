import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { useBridge } from "../../lib/computer-bridge";
import { permissionMissing } from "@milagre/shared/computer-use";
import type { ComputerUseApi, ComputerUsePermission, ComputerUseStatus } from "@milagre/shared/computer-use";
import { ipcErrorMessage } from "@milagre/shared/result";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Row } from "./SettingsGroup";

const AGENT_DESKTOP_URL = "https://github.com/vercel-labs/agent-desktop";
// While a permission is missing, re-read it: the user grants it in System Settings, outside Milagre.
const RECHECK_MS = 3000;

/** Settings › Experimental: agents operate desktop apps on this computer through agent-desktop. Kept by the host. */
export function ComputerUseSettings() {
  // A test bridge or an older paired host may not offer it.
  const api = useBridge().computerUse as ComputerUseApi | undefined;
  return api ? <ComputerUse api={api} /> : null;
}

function ComputerUse({ api }: { api: ComputerUseApi }) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(
    () =>
      api
        .status()
        .then(setStatus)
        .catch((cause) => setError(ipcErrorMessage(cause))),
    [api],
  );
  useEffect(() => {
    void refresh();
    const off = api.onSettings((value) => setStatus((current) => (current ? { ...current, ...value } : current)));
    window.addEventListener("focus", refresh);
    return () => {
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [api, refresh]);
  const missing = !!status?.enabled && !!status.permissions && Object.values(status.permissions).some(permissionMissing);
  useEffect(() => {
    if (!missing) return;
    const timer = setInterval(refresh, RECHECK_MS);
    return () => clearInterval(timer);
  }, [missing, refresh]);
  const save = async (enabled: boolean) => {
    setSaving(true);
    setError("");
    try {
      await api.saveSettings({ enabled });
      await refresh();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const grant = () => {
    setError("");
    api.guide().catch((cause) => setError(ipcErrorMessage(cause)));
  };
  if (!status) return null;
  return (
    <div data-slot="computer-use-setting">
      <Row
        label="Computer use"
        description="Agents can see and operate apps on this computer. They ask before each new app, and never move your pointer or take focus."
      >
        <SettingCheckbox label="Computer use" checked={status.enabled} disabled={saving || !status.supported} onChange={(enabled) => void save(enabled)} />
      </Row>
      {!status.supported && <p className="px-4 pb-3 text-12 text-ink-3">Not available on this computer.</p>}
      {status.enabled && status.supported && (
        <div className="ml-4 grid border-l border-line pb-3">
          {status.permissions && (
            <>
              <Permission label="Accessibility, to read and operate apps" state={status.permissions.accessibility} onGrant={grant} />
              <Permission label="Screen Recording, for the live screen in Chats" state={status.permissions.screenRecording} onGrant={grant} />
            </>
          )}
          <div className="grid gap-0.5 px-4 py-2">
            <span className="text-13 text-ink">Never used by agents</span>
            <span className="text-12 text-ink-3">{status.blockedApps.join(", ")}</span>
          </div>
          <p className="px-4 pt-1 text-12 text-ink-3">
            Uses{" "}
            <a href={AGENT_DESKTOP_URL} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              agent-desktop {status.version}
            </a>{" "}
            by Vercel Labs. Apps you allow stay allowed only in that Chat.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-12 text-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

function Permission({ label, state, onGrant }: { label: string; state: ComputerUsePermission; onGrant: () => void }) {
  const missing = permissionMissing(state);
  return (
    <div data-slot="computer-use-permission" data-state={state} className="flex min-h-11 items-center gap-2.5 px-4 py-1.5">
      <span className={missing ? "text-orange-ink" : "text-green-ink"}>
        <HugeiconsIcon icon={missing ? AlertCircleIcon : CheckmarkCircle02Icon} size={16} strokeWidth={1.75} color="currentColor" />
      </span>
      <span className="min-w-0 flex-1 text-13 text-ink">{label}</span>
      {missing ? (
        <button type="button" onClick={onGrant} className="rounded-control bg-field px-3 py-1 text-12 font-medium text-ink hover:bg-hover">
          Grant
        </button>
      ) : (
        <span className="text-12 text-ink-3">Granted</span>
      )}
    </div>
  );
}
