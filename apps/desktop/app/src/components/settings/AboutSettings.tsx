import { PRIVACY_URL, SUPPORT_URL } from "@milagre/shared/site-links";
import { showUpdateNotice } from "../UpdateNotice";
import { SettingCheckbox } from "../primitives/Checkbox";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useEffect, useState } from "react";
import type { MilagreBridge, ReleaseChannel, UpdateState } from "../../electron";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE } from "@milagre/shared/auto-update";
import { updateDescription } from "@milagre/shared/app-update";

/**
 * Auto update, kept by the host it reaches: this Mac's (Settings › About, then the update state carries it too) or a
 * paired computer's (its Computer page). Hidden until the host answers; an older one never does.
 */
export function AutoUpdateRow({ bridge }: { bridge: Pick<MilagreBridge, "readAutoUpdate" | "saveAutoUpdate" | "onAutoUpdate"> }) {
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    bridge.readAutoUpdate().then(
      (value) => live && setAutoUpdate(value?.autoUpdate === true),
      () => live && setAutoUpdate(null),
    );
    // Another device can change it meanwhile.
    const off = bridge.onAutoUpdate((value) => setAutoUpdate(value?.autoUpdate === true));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  if (autoUpdate === null) return null;
  const change = async (next: boolean) => {
    setError("");
    setAutoUpdate(next);
    try {
      setAutoUpdate((await bridge.saveAutoUpdate(next)).autoUpdate);
    } catch (cause) {
      setAutoUpdate(!next);
      setError(ipcErrorMessage(cause));
    }
  };
  return (
    <Row label={AUTO_UPDATE_TITLE} description={error || AUTO_UPDATE_HINT}>
      <SettingCheckbox label={AUTO_UPDATE_TITLE} checked={autoUpdate} onChange={(next) => void change(next)} />
    </Row>
  );
}

export function AboutSettings({ update }: { update: UpdateState | null }) {
  const [version, setVersion] = useState<string | null>(null);
  const [channel, setChannel] = useState<ReleaseChannel | null>(null);
  useEffect(() => {
    void window.milagre.getAppVersion().then(setVersion);
    void window.milagre.getReleaseChannel().then(setChannel);
  }, []);
  const electron = navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1];
  const chrome = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1];
  return (
    <Group title="Milagre">
      <Row label="Version">
        <span className="tabular-nums">{version ?? "…"}</span>
      </Row>
      <Row
        label="Release channel"
        description={
          channel === "beta"
            ? "Beta gets a build most days main changes. Switch back to Stable any time; you keep the version you have until the next stable release."
            : "Stable gets releases after they have run on Beta."
        }
      >
        <Select<ReleaseChannel>
          label="Release channel"
          value={channel ?? "stable"}
          onChange={(next) => {
            setChannel(next);
            void window.milagre.setReleaseChannel(next);
          }}
          options={[
            { value: "stable", label: "Stable" },
            { value: "beta", label: "Beta" },
          ]}
        />
      </Row>
      <Row label="Updates" description={updateDescription(update)}>
        <button
          type="button"
          disabled={update?.status === "checking" || update?.status === "downloading" || update?.status === "unavailable" || update?.status === "installing"}
          onClick={() => void (update?.status === "downloaded" ? showUpdateNotice() : window.milagre.checkForUpdates())}
          className="rounded-control border border-line bg-surface px-3 py-1.5 text-12 font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-50"
        >
          {update?.status === "installing" ? "Restarting…" : update?.status === "downloaded" ? "Install & restart" : "Check for updates"}
        </button>
      </Row>
      <AutoUpdateRow bridge={window.milagre} />
      {electron && (
        <Row label="Runtime">
          <span className="tabular-nums">
            Electron {electron} · Chromium {chrome}
          </span>
        </Row>
      )}
      <Row label="License">MIT</Row>
      {[
        { label: "Privacy policy", url: PRIVACY_URL },
        { label: "Support", url: SUPPORT_URL },
      ].map(({ label, url }) => (
        <Row key={url} label={label}>
          <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            {url.replace("https://", "")}
          </a>
        </Row>
      ))}
    </Group>
  );
}
