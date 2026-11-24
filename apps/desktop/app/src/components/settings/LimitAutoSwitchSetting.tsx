import { SettingCheckbox } from "../primitives/Checkbox";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useEffect, useState } from "react";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { bridgeFor } from "../../lib/computer-bridge";
import { Group, Row } from "./SettingsGroup";

// Accounts > Switch accounts at usage limits: owned by the computer's host, so a Chat can switch while no window is open.
export function LimitAutoSwitchSetting({ computerId = LOCAL_COMPUTER }: { computerId?: string }) {
  const bridge = bridgeFor(computerId);
  // null until read.
  const [autoSwitch, setAutoSwitch] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeAtReset, setResumeAtReset] = useState<boolean | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [savingResume, setSavingResume] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => bridge.readLimitResumeAtReset())
      .then(
        (value) => {
          if (live && typeof value?.resumeAtReset === "boolean") setResumeAtReset(value.resumeAtReset);
          return null;
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [bridge]);
  async function changeResume(next: boolean) {
    if (savingResume) return;
    setSavingResume(true);
    setResumeError(null);
    try {
      setResumeAtReset((await bridge.saveLimitResumeAtReset(next)).resumeAtReset);
    } catch (failure) {
      setResumeError(ipcErrorMessage(failure));
    } finally {
      setSavingResume(false);
    }
  }
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => bridge.readLimitAutoSwitch())
      .then(
        (value) => live && setAutoSwitch(value?.autoSwitch === true),
        () => live && setAutoSwitch(false),
      );
    return () => {
      live = false;
    };
  }, [bridge]);
  async function change(next: boolean) {
    setError(null);
    setAutoSwitch(next);
    try {
      setAutoSwitch((await bridge.saveLimitAutoSwitch(next)).autoSwitch);
    } catch (failure) {
      setAutoSwitch(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  if (autoSwitch === null) return null;
  return (
    <Group title="Usage limits">
      <Row
        label="Switch accounts at usage limits"
        description={
          "When a Chat hits its plan's usage limit, move its Project to the next signed-in account and continue." + (error ? ` Could not save: ${error}` : "")
        }
      >
        <SettingCheckbox label="Switch accounts at usage limits" checked={autoSwitch} onChange={(next) => void change(next)} />
      </Row>
      {resumeAtReset !== null && (
        <Row
          label="Continue when the limit resets"
          description={
            "When a Chat hits its plan's usage limit and no other account can take over, continue it at the reset time, up to a day later." +
            (resumeError ? ` Could not save: ${resumeError}` : "")
          }
        >
          <SettingCheckbox
            label="Continue when the limit resets"
            checked={resumeAtReset}
            disabled={savingResume}
            onChange={(next) => void changeResume(next)}
          />
        </Row>
      )}
    </Group>
  );
}
