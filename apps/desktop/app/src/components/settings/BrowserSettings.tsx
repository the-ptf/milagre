import { ipcErrorMessage } from "@milagre/shared/result";
import { SIGN_INS_TITLE, SIGN_OUT, SIGNED_OUT, SIGNING_OUT, signOutHint } from "@milagre/shared/browser-sign-ins";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { useEffect, useState } from "react";
import { useComputers } from "../../lib/computers";
import { updateSettings, useSettings } from "../../lib/settings";
import type { OpenLinksIn } from "../../lib/settings";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { SECONDARY_BUTTON } from "./settings-parts";

export function BrowserSettings() {
  const settings = useSettings();
  const { thisMac, computers } = useComputers();
  return (
    <>
      <LinksSettings openLinksIn={settings.openLinksIn} />
      {window.milagreBrowserPanel?.clearSignIns && (
        <Group title={SIGN_INS_TITLE}>
          <SignOutRow computerId={LOCAL_COMPUTER} name={thisMac} hint={signOutHint(null)} />
          {computers.map((computer) => (
            <SignOutRow key={computer.id} computerId={computer.id} name={computer.name} hint={signOutHint(computer.name)} />
          ))}
        </Group>
      )}
    </>
  );
}

/** Signs one session of the Browser panel out: this Mac's Chats' or one computer's (browser-remote-sessions.cjs). */
function SignOutRow({ computerId, name, hint }: { computerId: string; name: string; hint: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    if (state !== "done") return;
    const timer = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  async function signOut() {
    setState("busy");
    setError("");
    try {
      await window.milagreBrowserPanel?.clearSignIns?.(computerId);
      setState("done");
    } catch (failure) {
      setState("idle");
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <Row label={name} description={error || hint}>
      <button type="button" data-browser-sign-out={computerId} className={SECONDARY_BUTTON} disabled={state === "busy"} onClick={() => void signOut()}>
        {state === "busy" ? SIGNING_OUT : state === "done" ? SIGNED_OUT : SIGN_OUT}
      </button>
    </Row>
  );
}

const MOD_KEY = /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl";

function LinksSettings({ openLinksIn }: { openLinksIn: OpenLinksIn }) {
  return (
    <Group
      title="Links"
      footer={`Hold ${MOD_KEY} when you click a link to open it in the other place: your default browser instead of the Browser panel, or the other way round.`}
    >
      <Row label="Open links in" description="Where web links open when you click them: links in the agent's replies and the servers the Chat runs.">
        <Select<OpenLinksIn>
          label="Open links in"
          value={openLinksIn}
          onChange={(openLinksIn) => updateSettings({ openLinksIn })}
          options={[
            { value: "milagre", label: "Milagre's Browser panel" },
            { value: "external", label: "Your default browser" },
          ]}
        />
      </Row>
    </Group>
  );
}
