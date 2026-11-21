import { useEffect, useState } from "react";
import { useBridge } from "../../lib/computer-bridge";
import { baguetteStatusLine, type BaguetteApi, type BaguetteStatus } from "@milagre/shared/simulator";
import { Row } from "./SettingsGroup";

const BAGUETTE_URL = "https://github.com/tddworks/baguette";
const BAGUETTE_DESCRIPTION =
  "Chats list the paired iPhones on this computer's cable next to its simulators, to watch and touch. Through Baguette, which Milagre doesn't install.";

export function BaguetteSettings() {
  const api = useBridge().baguette as BaguetteApi | undefined;
  const [status, setStatus] = useState<BaguetteStatus | null>(null);
  useEffect(() => {
    let live = true;
    if (typeof api?.status === "function")
      Promise.resolve()
        .then(() => api.status())
        .then((value) => live && setStatus(value))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  if (!status) return null;
  return (
    <div data-slot="baguette-setting">
      <Row label="iPhones on a cable" description={BAGUETTE_DESCRIPTION}>
        <a href={BAGUETTE_URL} target="_blank" rel="noreferrer" className="text-12 text-ink-2 underline-offset-2 hover:underline">
          About Baguette
        </a>
      </Row>
      <p role="status" className={`px-4 pb-3 text-12 ${status.supported ? "text-ink-2" : "text-ink-3"}`}>
        {baguetteStatusLine(status)}
        {status.path && <span className="ml-1 font-mono text-ink-3">{status.path}</span>}
      </p>
    </div>
  );
}
