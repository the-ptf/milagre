import { outbox, useOutbox } from "../../lib/outbox";
import { McpSettings } from "../McpSettings";
import { SettingCheckbox } from "../primitives/Checkbox";
import { LocalMcpSettings } from "../LocalMcpSettings";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useEffect, useState } from "react";
import { routeLine, seenAgo, useComputers, useHiddenComputers } from "../../lib/computers";
import { bridgeFor } from "../../lib/computer-bridge";
import { RemoteConnectors } from "./ConnectorsSettings";
import { setComputerHidden } from "../../lib/hidden-projects";
import { Group, Row } from "./SettingsGroup";
import { ComputerResourceList } from "./ComputerResources";
import { HostUpdateRow } from "./HostUpdateRow";
import { thisComputer } from "../../lib/shortcut-hints";
import { SECONDARY_BUTTON, DANGER_BUTTON } from "./settings-parts";
import { AutoUpdateRow } from "./AboutSettings";
import { resourceComputer } from "./DevicesSettings";

/** The pill beside a route: the one carrying the connection now, one that would, or one there is none of. */
function RoutePill({ state }: { state: "In use" | "Ready" | "Not available" }) {
  return (
    <span
      data-connection-state
      className="rounded-full px-2 py-0.5 text-11"
      style={state === "In use" ? { background: "var(--green-tint)", color: "var(--green-ink)" } : { background: "var(--hover)", color: "var(--ink-3)" }}
    >
      {state}
    </span>
  );
}

/**
 * A paired computer's settings (design computer-settings v1): its name on this Mac, how it is reached, what lives there,
 * and Remove. The gear in the computers popover opens it.
 */
export function ComputerSettings({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  const { computers } = useComputers();
  const hiddenComputers = useHiddenComputers();
  const computer = computers.find((item) => item.id === id);
  const [name, setName] = useState(computer?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // "seen 2h ago" keeps counting while the section stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [about, setAbout] = useState<{
    version: string | null;
    projects: string[];
  } | null>(null);
  useEffect(() => setName(computer?.name ?? ""), [computer?.name]);
  useEffect(() => {
    setConfirming(false);
    setError(null);
    setAbout(null);
  }, [id]);
  // What lives there: asked while it is online, kept while it is away.
  useEffect(() => {
    if (computer?.state !== "online") return;
    let live = true;
    void Promise.all([
      window.milagre.computers.invoke<{ version?: unknown }>(id, "daemon:status").catch(() => null),
      window.milagre.computers.invoke(id, "project:recent").catch(() => []),
    ]).then(([status, recent]) => {
      if (!live) return;
      const projects = (Array.isArray(recent) ? recent : []).filter((project) => !project?.hidden).map((project) => String(project.name));
      setAbout({
        version: typeof status?.version === "string" ? status.version : null,
        projects,
      });
    });
    return () => {
      live = false;
    };
  }, [id, computer?.state]);
  const waiting = useOutbox().items.filter((item) => item.computerId === id && item.status !== "sent");
  if (!computer) return <p className="mt-6 text-13 text-ink-3">This computer was removed.</p>;

  const paired = computer.addedAt ? `paired ${new Date(computer.addedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : null;
  const status = [computer.state === "online" ? "Connected" : routeLine(computer, now), about?.version ? `Milagre ${about.version}` : null, paired]
    .filter(Boolean)
    .join(" · ");
  const lanState = computer.state === "online" && computer.route === "lan" ? "In use" : computer.lanRoutes.length > 0 ? "Ready" : "Not available";
  const relayState = computer.state === "online" && computer.route === "relay" ? "In use" : "Ready";
  const rename = async () => {
    const next = name.trim();
    if (!next || next === computer.name) {
      setName(computer.name);
      return;
    }
    try {
      await window.milagre.computers.rename(computer.id, next);
      setError(null);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
      setName(computer.name);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await window.milagre.computers.remove(computer.id);
      // Nothing can deliver them now; the confirmation said they go.
      await Promise.allSettled(waiting.map((item) => outbox.remove(item.id)));
      // A computer paired again comes back shown.
      setComputerHidden(computer.id, false);
      onRemoved();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-computer-settings>
      <p data-computer-status className="mt-1 text-13 text-ink-3">
        {status}
      </p>
      <Group title="General">
        <Row label="Name" description={`Shown on its chats in the sidebar. Only on ${thisComputer}.`}>
          <input
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-[30px] w-[220px] rounded-control bg-field px-2.5 text-13 text-ink outline-none ring-1 ring-line-strong focus-visible:ring-accent"
          />
        </Row>
        <div data-computer-show-in-sidebar>
          <Row label="Show in sidebar" description={`${computer.name}'s Projects in the sidebar on ${thisComputer}. It stays connected while hidden.`}>
            <SettingCheckbox label="Show in sidebar" checked={!hiddenComputers.has(computer.id)} onChange={(show) => setComputerHidden(computer.id, !show)} />
          </Row>
        </div>
      </Group>
      <Group title="Connection">
        <div data-connection="lan">
          <Row
            label="Same network"
            description={computer.lanRoutes[0] ? `${computer.lanRoutes[0]}, end-to-end encrypted` : "Not reached on a shared network yet"}
          >
            <RoutePill state={lanState} />
          </Row>
        </div>
        <div data-connection="relay">
          <Row label="Relay" description={`${computer.relayHost}, used away from that network`}>
            <RoutePill state={relayState} />
          </Row>
        </div>
      </Group>
      <Group title={`On ${computer.name}`}>
        <div data-computer-projects>
          {computer.state === "online" ? (
            <Row
              label={about ? `${about.projects.length} ${about.projects.length === 1 ? "Project" : "Projects"}` : "Reading…"}
              description={
                about ? `${about.projects.length ? `${about.projects.join(", ")}. ` : ""}Accounts and simulators stay on ${computer.name}.` : undefined
              }
            >
              {null}
            </Row>
          ) : (
            <Row
              label={`${computer.name} is offline`}
              description={seenAgo(computer.lastSeen, now) ? `Last seen ${seenAgo(computer.lastSeen, now)}.` : undefined}
            >
              {null}
            </Row>
          )}
        </div>
        <ComputerResourceList computers={[resourceComputer(computer, now)]} initiallyOpen={computer.id} />
        {computer.state === "online" && <HostUpdateRow key={`update-${id}`} bridge={bridgeFor(id)} name={computer.name} />}
        {computer.state === "online" && (
          <div data-computer-auto-update>
            <AutoUpdateRow key={id} bridge={bridgeFor(id)} />
          </div>
        )}
      </Group>
      {computer.state === "online" && (
        <section data-computer-connectors className="mt-6 space-y-2">
          <h2 className="px-1 text-12 font-medium text-ink-3">Connectors</h2>
          <RemoteConnectors key={`connectors-${id}`} bridge={bridgeFor(id)} name={computer.name} />
        </section>
      )}
      {computer.state === "online" && (
        <section data-computer-mcp className="mt-6">
          <h2 className="px-1 text-12 font-medium text-ink-3">MCP servers</h2>
          <McpSettings key={id} bridge={bridgeFor(id)} remote />
          <LocalMcpSettings key={`local-${id}`} bridge={bridgeFor(id)} />
        </section>
      )}
      {error && (
        <p role="alert" className="mt-3 text-13 text-red-ink">
          {error}
        </p>
      )}
      <Group title="Remove">
        <Row
          label={`Remove ${computer.name}`}
          description={`Its Chats leave this sidebar and ${thisComputer} forgets its keys. Nothing changes on ${computer.name}; pair again with a new link.${
            waiting.length ? ` ${waiting.length === 1 ? "1 message" : `${waiting.length} messages`} waiting on ${thisComputer} for it will be discarded.` : ""
          }`}
        >
          {confirming ? (
            <span className="flex gap-2">
              <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" data-computer-remove-confirm className={DANGER_BUTTON} disabled={busy} onClick={() => void remove()}>
                Remove {computer.name}
              </button>
            </span>
          ) : (
            <button type="button" data-computer-remove className={DANGER_BUTTON} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </Row>
      </Group>
    </div>
  );
}
