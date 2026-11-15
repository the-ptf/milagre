import { SettingCheckbox } from "../primitives/Checkbox";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useEffect, useState } from "react";
import { bridgeFor, bridgeForKey } from "../../lib/computer-bridge";
import { Select } from "../primitives/Select";
import { Row } from "./SettingsGroup";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE, choiceOf, mainSyncChoices, mainSyncStatusLine, overrideOf } from "@milagre/shared/main-sync";
import type { MainSyncChoice, MainSyncSettings } from "@milagre/shared/main-sync";

// The global default for source branch sync; each Project can override it. Kept by the daemon, which runs the sync.
export function MainSyncDefaultSetting() {
  const [syncMain, setSyncMain] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Started inside a promise so a bridge without the command (an older host) reads as off instead of throwing.
    Promise.resolve()
      .then(() => window.milagre.readMainSyncDefault())
      .then(
        (value) => setSyncMain(value?.syncMain === true),
        () => setSyncMain(false),
      );
  }, []);
  async function change(next: boolean) {
    setError(null);
    setSyncMain(next);
    try {
      setSyncMain((await window.milagre.saveMainSyncDefault(next)).syncMain);
    } catch (failure) {
      setSyncMain(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <div data-main-sync-default>
      <Row label={MAIN_SYNC_TITLE} description={MAIN_SYNC_HINT}>
        <SettingCheckbox label={MAIN_SYNC_TITLE} checked={syncMain === true} onChange={(next) => void change(next)} />
      </Row>
      {error && <p className="px-4 pb-3 break-words text-12 text-red-ink">{error}</p>}
    </div>
  );
}

const DETECT_REPOSITORIES_TITLE = "Detect repositories in a folder";

const DETECT_REPOSITORIES_HINT = "When a folder you add holds repositories, offer to add them as Projects with a Link that groups them.";

// Add Project's folder check (project:scan-children): kept by the daemon, so the phone's Add Project follows it too.
export function DetectRepositoriesSetting() {
  const [detect, setDetect] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // An older host without the command reads as on, the default.
    Promise.resolve()
      .then(() => bridgeFor(null).readDetectRepositories())
      .then(
        (value) => setDetect(value?.detectRepositories !== false),
        () => setDetect(true),
      );
  }, []);
  async function change(next: boolean) {
    setError(null);
    setDetect(next);
    try {
      setDetect((await bridgeFor(null).saveDetectRepositories(next)).detectRepositories);
    } catch (failure) {
      setDetect(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <div data-detect-repositories>
      <Row label={DETECT_REPOSITORIES_TITLE} description={DETECT_REPOSITORIES_HINT}>
        <SettingCheckbox label={DETECT_REPOSITORIES_TITLE} checked={detect !== false} onChange={(next) => void change(next)} />
      </Row>
      {error && <p className="px-4 pb-3 break-words text-12 text-red-ink">{error}</p>}
    </div>
  );
}

export function MainSyncSetting({ projectPath }: { projectPath: string }) {
  const [sync, setSync] = useState<MainSyncSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    // Started inside a promise, like the default above, so a bridge without the command shows an error, not a crash.
    Promise.resolve()
      .then(() => bridgeForKey(projectPath).readMainSync(projectPath))
      .then(
        (value) => live && setSync(value ?? null),
        (failure) => live && setError(ipcErrorMessage(failure)),
      );
    const stop = window.milagre.onMainSyncStatus?.((status) => {
      if (status.projectPath !== projectPath) return;
      setNow(Date.now());
      setSync((current) => (current ? { ...current, last: status.last } : current));
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [projectPath]);
  async function change(choice: MainSyncChoice) {
    setError(null);
    try {
      setSync(await bridgeForKey(projectPath).saveMainSync(projectPath, overrideOf(choice)));
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    }
  }
  const title = MAIN_SYNC_TITLE;
  return (
    <div data-main-sync>
      <Row label={title} description={sync ? mainSyncStatusLine(sync.last, now) : undefined}>
        <Select<MainSyncChoice>
          label={title}
          value={choiceOf(sync?.override ?? null)}
          onChange={(choice) => void change(choice)}
          options={mainSyncChoices(sync?.defaultValue ?? false).map((choice) => ({ value: choice.value, label: choice.title }))}
        />
      </Row>
      {error && <p className="px-4 pb-3 break-words text-12 text-red-ink">{error}</p>}
    </div>
  );
}
