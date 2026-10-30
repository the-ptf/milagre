import { useEffect, useState } from "react";
import { installQuestion, noDesktopUpdate, updateAvailable, updateBusy, updateDescription, type HostUpdate } from "@milagre/shared/app-update";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { MilagreBridge } from "../../electron";
import { Row } from "./SettingsGroup";

const BUTTON =
  "rounded-control border border-line bg-surface px-3 py-1.5 text-12 font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-50";
// How often the row reads the update again while it moves (checking, downloading, restarting).
const FOLLOW_MS = 2000;

/**
 * A paired computer's desktop app update, on its Computer page, as the phone shows it in Settings › General: Check for
 * updates, and Install & restart after a question, since it restarts Milagre on that computer. Hidden while the
 * computer is too old to answer; this Mac's own update is Settings › About.
 */
export function HostUpdateRow({ bridge, name }: { bridge: Pick<MilagreBridge, "readHostUpdate" | "checkHostUpdate" | "installHostUpdate">; name: string }) {
  // undefined until the computer answers (an older one never does); null while no desktop app is open there.
  const [update, setUpdate] = useState<HostUpdate | undefined>(undefined);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  // Restarting there drops the computer's connection for a moment; the row keeps saying so until it answers again.
  const [restarting, setRestarting] = useState(false);
  const following = restarting || updateBusy(update ?? null);
  useEffect(() => {
    let live = true;
    const show = (value: HostUpdate) => {
      if (!live) return;
      setUpdate(value);
      if (value?.status !== "installing") setRestarting(false);
    };
    const lost = () => {
      if (live && !restarting) setUpdate(undefined);
    };
    const read = () => bridge.readHostUpdate().then(show, lost);
    void read();
    if (!following) return () => void (live = false);
    const timer = setInterval(() => void read(), FOLLOW_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bridge, following, restarting]);
  if (update === undefined && !restarting) return null;
  const run = async (action: () => Promise<HostUpdate>) => {
    setError("");
    try {
      setUpdate(await action());
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  };
  const install = async () => {
    setConfirming(false);
    setRestarting(true);
    await run(bridge.installHostUpdate);
  };
  const question = installQuestion(name, update?.version ?? null);
  const label = (update && updateAvailable(update)) || "Updates";
  const description = confirming
    ? `${question.title} ${question.message}`
    : error ||
      (restarting && !update
        ? `Restarting Milagre on ${name}.`
        : update === null
          ? noDesktopUpdate(name)
          : `${update ? `${name} runs Milagre ${update.current}. ` : ""}${updateDescription(update ?? null)}`);
  return (
    <div data-computer-update={update?.status ?? (restarting ? "installing" : "closed")}>
      <Row label={label} description={description}>
        {update === null ? null : confirming ? (
          <span className="flex gap-2">
            <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" data-computer-update-confirm className={BUTTON} onClick={() => void install()}>
              {question.action}
            </button>
          </span>
        ) : update?.status === "downloaded" && !restarting ? (
          <button type="button" data-computer-update-install className={BUTTON} onClick={() => setConfirming(true)}>
            Install & restart
          </button>
        ) : (
          <button type="button" data-computer-update-check className={BUTTON} disabled={following} onClick={() => void run(bridge.checkHostUpdate)}>
            {restarting || update?.status === "installing" ? "Restarting…" : "Check for updates"}
          </button>
        )}
      </Row>
    </div>
  );
}
