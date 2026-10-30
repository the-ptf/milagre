import { useEffect, useState } from "react";
import { useBridge } from "../../lib/computer-bridge";
import type { SimlockApi, SimlockSettings as Settings } from "@milagre/shared/simulator";
import { ipcErrorMessage } from "@milagre/shared/result";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Select } from "../primitives/Select";
import { Row } from "./SettingsGroup";

const inputClass =
  "h-9 w-full rounded-control border border-line bg-surface px-3 font-mono text-12 text-ink outline-none placeholder:text-ink-3 focus-visible:border-ink-3 disabled:bg-field disabled:text-ink-2";
const LEASE_MINUTES = [15, 30, 60, 120, 240];
const SIMLOCK_URL = "https://github.com/callstackincubator/simlock";

/** Settings › Experimental: lease simulators and emulators from a Simlock worker or gateway. Kept by the host. */
export function SimlockSettings() {
  // A test bridge or an older paired host may not offer it.
  const api = useBridge().simlock as SimlockApi | undefined;
  return api ? <SimlockPool api={api} /> : null;
}

function SimlockPool({ api }: { api: SimlockApi }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [gateway, setGateway] = useState(""),
    [token, setToken] = useState("");
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [check, setCheck] = useState<{
      state: "checking" | "ok" | "failed";
      text: string;
    } | null>(null);
  useEffect(() => {
    let live = true;
    api
      .readSettings()
      .then((value) => {
        if (live) {
          setSettings(value);
          setGateway(value.savedGatewayUrl);
        }
        return value;
      })
      .catch((cause) => live && setError(ipcErrorMessage(cause)));
    const off = api.onSettings((value) => setSettings(value));
    return () => {
      live = false;
      off();
    };
  }, [api]);
  const save = async (patch: Parameters<typeof api.saveSettings>[0]) => {
    setSaving(true);
    setError("");
    try {
      const value = await api.saveSettings(patch);
      setSettings(value);
      return value;
    } catch (cause) {
      setError(ipcErrorMessage(cause));
      return null;
    } finally {
      setSaving(false);
    }
  };
  const connect = async () => {
    setCheck({ state: "checking", text: "Checking the gateway..." });
    try {
      const typed = gateway.trim();
      const who = await api.identity({
        ...(typed ? { gatewayUrl: typed } : {}),
        ...(token.trim() ? { agentToken: token.trim() } : {}),
      });
      const saved = await save({
        gatewayUrl: typed,
        ...(token.trim() ? { agentToken: token.trim() } : {}),
      });
      if (saved) setToken("");
      setCheck({
        state: "ok",
        text: `Connected to ${who.gatewayUrl} as ${who.name} (${who.role}).`,
      });
    } catch (cause) {
      setCheck({ state: "failed", text: ipcErrorMessage(cause) });
    }
  };
  if (!settings) return null;
  const detected = settings.detected;
  const tokenHint = settings.tokenSource === "settings" ? "Saved" : settings.tokenSource ? "This Mac's Simlock token" : "slk_...";
  return (
    <div data-slot="simlock-setting">
      <Row
        label="Simlock devices"
        description="Agents lease a simulator or emulator of their own from a Simlock pool, watch it here and on the phone, and return it wiped. Simlock runs on your own Macs; Milagre doesn't install it."
      >
        <SettingCheckbox label="Simlock devices" checked={settings.enabled} disabled={saving} onChange={(enabled) => void save({ enabled })} />
      </Row>
      {settings.enabled && (
        <div className="ml-4 grid gap-3 border-l border-line pb-3">
          <div className="grid gap-3 px-4">
            <label className="grid gap-1">
              <span className="text-13 font-medium text-ink">Gateway</span>
              <span className="text-12 text-ink-3">
                A Simlock gateway or worker's address. Leave it empty to use{" "}
                {detected
                  ? `this Mac's ${detected.source === "worker" ? "Simlock worker" : "agent-device setup"} at ${detected.gatewayUrl}`
                  : "a Simlock worker started on this Mac"}
                .
              </span>
              <input
                type="url"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={gateway}
                placeholder={detected?.gatewayUrl ?? "https://gateway.example.ts.net:4700"}
                onChange={(event) => setGateway(event.target.value)}
                className={inputClass}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-13 font-medium text-ink">Agent token</span>
              <span className="text-12 text-ink-3">
                From <code className="font-mono">simlock token create --role agent</code>, one per Mac running Milagre. It stays on this Mac and goes only to
                its gateway.
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                placeholder={tokenHint}
                onChange={(event) => setToken(event.target.value)}
                className={inputClass}
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={saving || check?.state === "checking"}
                onClick={() => void connect()}
                className="rounded-control border border-line px-3 py-1.5 text-12 hover:bg-hover disabled:opacity-50"
              >
                Save and check
              </button>
              {settings.tokenSource === "settings" && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save({ agentToken: "" }).then(() => setCheck(null))}
                  className="rounded-control px-3 py-1.5 text-12 text-ink-2 hover:bg-hover disabled:opacity-50"
                >
                  Forget token
                </button>
              )}
              <a href={SIMLOCK_URL} target="_blank" rel="noreferrer" className="ml-auto text-12 text-ink-2 underline-offset-2 hover:underline">
                About Simlock
              </a>
            </div>
            {check && (
              <p role={check.state === "failed" ? "alert" : "status"} className={`text-12 ${check.state === "failed" ? "text-red-ink" : "text-ink-2"}`}>
                {check.text}
              </p>
            )}
          </div>
          <Row label="Devices at once" description="Leases this Mac holds together. Simlock also caps leases per token (lease.maxPerRequester).">
            <Select
              label="Devices at once"
              width={90}
              value={String(settings.maxLeases)}
              options={[1, 2, 3, 4, 6, 8].map((count) => ({
                value: String(count),
                label: String(count),
              }))}
              onChange={(value) => void save({ maxLeases: Number(value) })}
            />
          </Row>
          <Row label="Return a device after" description="A lease ends this long after it started, even while an agent uses it.">
            <Select
              label="Return a device after"
              width={120}
              value={String(settings.maxLeaseMinutes)}
              options={[...new Set([...LEASE_MINUTES, settings.maxLeaseMinutes])]
                .sort((a, b) => a - b)
                .map((minutes) => ({
                  value: String(minutes),
                  label: minutes < 60 ? `${minutes} min` : `${minutes / 60} h`,
                }))}
              onChange={(value) => void save({ maxLeaseMinutes: Number(value) })}
            />
          </Row>
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
