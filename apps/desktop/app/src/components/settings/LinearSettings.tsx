import { SettingCheckbox } from "../primitives/Checkbox";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  LINEAR_ADD_WORKSPACE,
  LINEAR_ADD_WORKSPACE_HINT,
  LINEAR_CONNECTING,
  LINEAR_CONNECTING_WINDOW,
  LINEAR_HINT,
  LINEAR_MOVE_TO_STARTED_HINT,
  LINEAR_MOVE_TO_STARTED_TITLE,
  LINEAR_SIGN_IN_REPLACED,
  LINEAR_USE_BROWSER,
  LINEAR_TITLE,
  linearReadOnlyHint,
  linearStatusLine,
  linearWorkspaces,
  type LinearStatus,
} from "@milagre/shared/linear";
import { useEffect, useRef, useState } from "react";
import { Row } from "./SettingsGroup";
import { SECONDARY_BUTTON } from "./settings-parts";

// Settings › Integrations › Linear: the daemon keeps the switch (phones share it) and the Mac's connections, one per workspace.
export function LinearSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // null until read; a Mac that predates the switch sends none and has it on.
  const [moveToStarted, setMoveToStarted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<LinearStatus | null>(null);
  // "window": Add workspace's own sign-in window; "browser": the first Connect, or the fallback from the window.
  const [connecting, setConnecting] = useState<false | "window" | "browser">(false);
  const [error, setError] = useState<string | null>(null);
  // Connect again replaces a waiting sign-in; only the latest attempt may update the row.
  const attempt = useRef(0);
  const known = useRef(0); // workspaces connected, to tell a finished sign-in from another workspace's disconnect
  known.current = linearWorkspaces(status).length;
  useEffect(() => {
    let live = true;
    // Started inside a promise so a bridge without the command (an older host) reads as off instead of throwing.
    Promise.resolve()
      .then(() => window.milagre.readLinearEnabled())
      .then(
        (value) => {
          if (!live) return;
          setEnabled(value?.enabled === true);
          setMoveToStarted(value?.moveToStarted !== false);
        },
        () => live && setEnabled(false),
      );
    Promise.resolve()
      .then(() => window.milagre.readLinearStatus())
      .then(
        (value) => live && setStatus(value),
        () => live && setStatus({ connected: false }),
      );
    const stop = window.milagre.onLinearStatusChanged?.((next) => {
      if (!live) return;
      const grew = linearWorkspaces(next).length > known.current;
      setStatus(next);
      if (grew) {
        // The sign-in finished: a connect still waiting is over, and a late failure of it must not show.
        attempt.current++;
        setConnecting(false);
        setError(null);
      }
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  async function changeEnabled(next: boolean) {
    setError(null);
    setEnabled(next);
    try {
      setEnabled((await window.milagre.saveLinearEnabled(next)).enabled);
    } catch (failure) {
      setEnabled(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  async function changeMoveToStarted(next: boolean) {
    setError(null);
    setMoveToStarted(next);
    try {
      setMoveToStarted((await window.milagre.saveLinearMoveToStarted(next)).moveToStarted);
    } catch (failure) {
      setMoveToStarted(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  async function connect(inWindow: boolean) {
    const id = ++attempt.current;
    setError(null);
    setConnecting(inWindow ? "window" : "browser");
    try {
      const next = await window.milagre.connectLinear(inWindow ? { window: true } : undefined);
      if (id === attempt.current) setStatus(next);
    } catch (failure) {
      // Closing the sign-in window ends it; the row going back to Add says enough.
      const message = ipcErrorMessage(failure);
      if (id === attempt.current && !message.includes(LINEAR_SIGN_IN_REPLACED)) setError(message);
    } finally {
      if (id === attempt.current) setConnecting(false);
    }
  }
  async function disconnect(workspace: string) {
    setError(null);
    try {
      setStatus(await window.milagre.disconnectLinear(workspace));
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <div data-linear-settings data-linear-connected={status?.connected ? "true" : "false"} className="divide-y divide-line">
      <Row label={LINEAR_TITLE} description={LINEAR_HINT}>
        <SettingCheckbox label={LINEAR_TITLE} checked={enabled === true} onChange={(next) => void changeEnabled(next)} />
      </Row>
      {enabled &&
        linearWorkspaces(status).map((workspace) => (
          <Row
            key={workspace.id}
            label={workspace.organization.name}
            description={`Signed in as ${workspace.viewer.name}` + (moveToStarted && workspace.canWrite === false ? `. ${linearReadOnlyHint("mac")}` : "")}
          >
            <button type="button" data-linear-workspace={workspace.id} className={SECONDARY_BUTTON} onClick={() => void disconnect(workspace.id)}>
              Disconnect
            </button>
          </Row>
        ))}
      {enabled && status?.connected && moveToStarted !== null && (
        <Row label={LINEAR_MOVE_TO_STARTED_TITLE} description={LINEAR_MOVE_TO_STARTED_HINT}>
          <SettingCheckbox label={LINEAR_MOVE_TO_STARTED_TITLE} checked={moveToStarted} onChange={(next) => void changeMoveToStarted(next)} />
        </Row>
      )}
      {enabled && status && (
        <Row
          label={status.connected ? LINEAR_ADD_WORKSPACE : linearStatusLine(status, "mac")}
          description={
            connecting === "window" ? LINEAR_CONNECTING_WINDOW : connecting ? LINEAR_CONNECTING : status.connected ? LINEAR_ADD_WORKSPACE_HINT : undefined
          }
        >
          <div className="flex shrink-0 items-center gap-2">
            {connecting === "window" && (
              <button type="button" data-linear-use-browser className={SECONDARY_BUTTON} onClick={() => void connect(false)}>
                {LINEAR_USE_BROWSER}
              </button>
            )}
            {/* Connecting the first workspace keeps the browser's Linear login; another one signs in afresh. Start again
                keeps whichever way the waiting sign-in went. */}
            <button
              type="button"
              data-linear-connect
              className={SECONDARY_BUTTON}
              onClick={() => void connect(connecting ? connecting === "window" : status.connected)}
            >
              {connecting ? "Start again" : status.connected ? "Add" : "Connect"}
            </button>
          </div>
        </Row>
      )}
      {error && <p className="px-4 pb-3 break-words text-12 text-red-ink">{error}</p>}
    </div>
  );
}
