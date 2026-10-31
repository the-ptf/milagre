import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { AlertCircleIcon, ArrowLeft01Icon, ArrowRight01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { useBridge } from "../../lib/computer-bridge";
import { permissionMissing } from "@milagre/shared/computer-use";
import type { ComputerUseApi, ComputerUsePermission, ComputerUseSettings as Settings, ComputerUseStatus } from "@milagre/shared/computer-use";
import { ipcErrorMessage } from "@milagre/shared/result";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Group, Row } from "./SettingsGroup";

const AGENT_DESKTOP_URL = "https://github.com/vercel-labs/agent-desktop";
// While a permission is missing, re-read it: the user grants it in System Settings, outside Milagre.
const RECHECK_MS = 3000;

const Icon = ({ icon, size = 16 }: { icon: IconSvgElement; size?: number }) => (
  <HugeiconsIcon icon={icon} size={size} strokeWidth={1.75} color="currentColor" />
);

/** The host's computer use status, kept fresh while a permission is missing. Null on a bridge without computer use. */
function useComputerUse() {
  // A test bridge or an older paired host may not offer it.
  const api = useBridge().computerUse as ComputerUseApi | undefined;
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(
    () =>
      api
        ?.status()
        .then(setStatus)
        .catch((cause) => setError(ipcErrorMessage(cause))),
    [api],
  );
  useEffect(() => {
    if (!api) return;
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
  const save = async (patch: Partial<Settings>) => {
    if (!api) return;
    setError("");
    try {
      await api.saveSettings(patch);
      await refresh();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  };
  const grant = () => {
    setError("");
    api?.guide().catch((cause) => setError(ipcErrorMessage(cause)));
  };
  return api ? { status, error, save, grant } : null;
}

/** Settings › Experimental: the row that opens the Computer use page. */
export function ComputerUseRow({ onOpen }: { onOpen: () => void }) {
  const computerUse = useComputerUse();
  if (!computerUse?.status) return null;
  return (
    <button
      type="button"
      data-computer-use-row
      onClick={onOpen}
      className="flex min-h-12 w-full items-center justify-between gap-6 px-4 py-2 text-left transition-colors hover:bg-hover"
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="text-13 font-medium text-ink">Computer use</span>
        <span className="text-12 text-ink-3">Agents see and operate apps on this computer, asking before each new app.</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-13 text-ink-2">
        {computerUse.status.enabled ? "On" : "Off"}
        <span className="text-ink-3">
          <Icon icon={ArrowRight01Icon} />
        </span>
      </span>
    </button>
  );
}

/** Settings › Experimental › Computer use: agents operate desktop apps through agent-desktop. Kept by the host. */
export function ComputerUseSettings({ onBack }: { onBack: () => void }) {
  const computerUse = useComputerUse();
  const status = computerUse?.status;
  const on = !!status?.enabled && !!status.supported;
  return (
    <div data-slot="computer-use-setting">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Back to Experimental"
          onClick={onBack}
          className="flex size-7 shrink-0 items-center justify-center rounded-control bg-field text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          <Icon icon={ArrowLeft01Icon} />
        </button>
        <h1 className="flex min-w-0 items-center gap-2 text-22 font-semibold tracking-[-0.01em] text-ink">
          <span className="text-ink-3">Experimental</span>
          <span className="text-ink-3">
            <Icon icon={ArrowRight01Icon} />
          </span>
          <span>Computer use</span>
        </h1>
      </div>
      {status && (
        <>
          <Group footer={status.supported ? undefined : "Not available on this computer."}>
            <Row
              label="Computer use"
              description="Agents can see and operate apps on this computer. They ask before each new app, and never move your pointer or take focus."
            >
              <SettingCheckbox
                label="Computer use"
                checked={status.enabled}
                disabled={!status.supported}
                onChange={(enabled) => void computerUse.save({ enabled })}
              />
            </Row>
            {on && (
              <Row
                label="Show the agent's cursor"
                description="Draw Milagre's cursor and the current step on the screen while an agent acts. Your own pointer never moves. Not drawing yet on macOS 27 with agent-desktop 1.0.2."
              >
                <SettingCheckbox label="Show the agent's cursor" checked={status.cursor} onChange={(cursor) => void computerUse.save({ cursor })} />
              </Row>
            )}
          </Group>
          {on && status.permissions && (
            <Group title="Permissions" footer="macOS grants these to Milagre, the app that runs agent-desktop. Grant opens System Settings at the missing one.">
              <Permission label="Accessibility, to read and operate apps" state={status.permissions.accessibility} onGrant={computerUse.grant} />
              <Permission label="Screen Recording, for the live screen in Chats" state={status.permissions.screenRecording} onGrant={computerUse.grant} />
            </Group>
          )}
          {on && (
            <Group title="Never used by agents" footer={`Uses agent-desktop ${status.version} by Vercel Labs. Apps you allow stay allowed only in that Chat.`}>
              <p className="px-4 py-3 text-13 text-ink-2">{status.blockedApps.join(", ")}</p>
            </Group>
          )}
          {on && (
            <a
              href={AGENT_DESKTOP_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block px-1 text-12 text-ink-2 underline-offset-2 hover:underline"
            >
              About agent-desktop
            </a>
          )}
        </>
      )}
      {computerUse?.error && (
        <p role="alert" className="mt-3 px-1 text-12 text-red-ink">
          {computerUse.error}
        </p>
      )}
    </div>
  );
}

function Permission({ label, state, onGrant }: { label: string; state: ComputerUsePermission; onGrant: () => void }) {
  const missing = permissionMissing(state);
  return (
    <div data-slot="computer-use-permission" data-state={state} className="flex min-h-12 items-center gap-2.5 px-4 py-2">
      <span className={missing ? "text-orange-ink" : "text-green-ink"}>
        <Icon icon={missing ? AlertCircleIcon : CheckmarkCircle02Icon} />
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
