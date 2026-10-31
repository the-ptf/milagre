import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { EthernetPortIcon, LinkSquare02Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import type { AgentPort } from "../../model";
import { portComputer, portUrl, unreachablePortReason } from "../../lib/ports";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { PillMorph } from "../motion/PillMorph";
import { opensInPanel } from "../../lib/link-target";

/**
 * The ports the chat's commands listen on: a "Ports n" pill that grows in place into their list (see PillMorph).
 * A row opens the port in the browser; its stop button ends the command behind it.
 */
/** `onOpen`, when set, opens this Mac's ports in the Chat's Browser panel when Settings › Browser says so; ⌘-click opens the other one. */
export function PortTrack({
  ports: listed,
  onStop,
  onOpen,
}: {
  ports?: AgentPort[];
  onStop?: (pid: number) => Promise<unknown>;
  onOpen?: (url: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  // Pids being stopped, each with a spinner until its stop call returns.
  const [stopping, setStopping] = useState<Set<number>>(new Set());
  // A server Stop ended leaves the list at once; the next list from the main process has the last word.
  const [ended, setEnded] = useState<{ list?: AgentPort[]; pids: number[] }>({ pids: [] });
  const ports = ended.list === listed && ended.pids.length ? listed?.filter((port) => !ended.pids.includes(port.pid)) : listed;
  const stop = (pids: number[]) => {
    if (!onStop) return;
    const shown = listed;
    setStopping((current) => new Set([...current, ...pids]));
    for (const pid of pids)
      void onStop(pid)
        .then((done) => done === true && setEnded((current) => ({ list: shown, pids: current.list === shown ? [...current.pids, pid] : [pid] })))
        .catch(() => {})
        .finally(() =>
          setStopping((current) => {
            const next = new Set(current);
            next.delete(pid);
            return next;
          }),
        );
  };
  const empty = !ports?.length;
  // The last server stopping closes the list; a later one starts closed.
  useEffect(() => {
    if (empty) setOpened(false);
  }, [empty]);
  return (
    <PillMorph
      shown={!!ports?.length}
      slot="port-track"
      panelSlot="port-popover"
      title="Ports"
      tooltip="Ports this chat's commands listen on"
      opened={opened}
      onOpenChange={setOpened}
      width={320}
      height={360}
      pill={{ icon: EthernetPortIcon, label: "Ports", count: ports?.length ?? 0, "aria-label": `Ports, ${ports?.length ?? 0} listening` }}
    >
      {ports?.length ? (
        <div className="flex min-h-0 flex-col p-1">
          {ports.length > 1 && (
            <div className="mb-1 shrink-0 border-b border-line pb-1">
              <button
                type="button"
                data-port-stop-all
                disabled={!onStop || ports.every((port) => stopping.has(port.pid))}
                onClick={() => stop([...new Set(ports.map((port) => port.pid))])}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] text-ink-2 hover:bg-hover focus-visible:outline-2 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <HugeiconsIcon icon={StopCircleIcon} size={14} aria-hidden />
                Stop all
              </button>
            </div>
          )}
          <ScrollArea as="ul">
            {ports.map((port) => (
              <li
                key={port.port}
                data-port-row
                data-stopping={stopping.has(port.pid) || undefined}
                className="group flex items-center gap-1 rounded-md pr-1 hover:bg-hover focus-within:bg-hover"
              >
                {(() => {
                  const computer = portComputer(port);
                  const url = portUrl(port);
                  // In the Browser panel another computer's port opens at its own localhost: the Chat's pages reach the
                  // web from that computer (#832), so a server on its loopback alone opens too.
                  const panelUrl = computer ? `http://localhost:${port.port}` : url;
                  const rowClass = "flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-[13px] text-ink no-underline focus-visible:outline-2";
                  // Outside the panel another computer's port opens at its LAN or tailnet IP; one this Mac can't reach
                  // that way is shown, not linked, unless the panel can open it.
                  if (computer && !url && !onOpen)
                    return (
                      <span data-port-remote title={unreachablePortReason(port, computer)} className={rowClass}>
                        <span className="w-14 shrink-0 font-mono tabular-nums">:{port.port}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-3">
                          {port.command} · on {computer}
                          <span className="sr-only">, process {port.pid}</span>
                        </span>
                      </span>
                    );
                  return (
                    <a
                      href={url ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={url ? `Open ${url}` : `Open in the Browser panel, through ${computer}. ${unreachablePortReason(port, computer ?? "")}`}
                      onClick={(event) => {
                        // With no address this Mac reaches, the row opens only in the panel.
                        if (!onOpen || !panelUrl || (url && !opensInPanel(event))) return;
                        event.preventDefault();
                        setOpened(false);
                        onOpen(panelUrl);
                      }}
                      {...(computer ? { "data-port-remote": true } : {})}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-[13px] text-ink no-underline focus-visible:outline-2"
                    >
                      <span className="w-14 shrink-0 font-mono tabular-nums">:{port.port}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-3">
                        {port.command}
                        {computer ? ` · on ${computer}` : null}
                        <span className="sr-only">, process {port.pid}</span>
                      </span>
                      <span className="flex shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <HugeiconsIcon icon={LinkSquare02Icon} size={14} aria-hidden />
                      </span>
                    </a>
                  );
                })()}
                <span
                  className={`flex shrink-0 transition-opacity ${stopping.has(port.pid) ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"}`}
                >
                  {stopping.has(port.pid) ? (
                    <span role="status" aria-label={`Stopping port ${port.port}`} className="flex size-6 items-center justify-center text-ink-3">
                      <SpinnerRing size={12} />
                    </span>
                  ) : (
                    <Tooltip label="Stop">
                      <button
                        type="button"
                        data-port-stop
                        aria-label={`Stop port ${port.port}`}
                        disabled={!onStop}
                        onClick={() => stop([port.pid])}
                        className="flex size-6 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-red-ink focus-visible:outline-2 disabled:opacity-40"
                      >
                        <HugeiconsIcon icon={StopCircleIcon} size={14} />
                      </button>
                    </Tooltip>
                  )}
                </span>
              </li>
            ))}
          </ScrollArea>
        </div>
      ) : null}
    </PillMorph>
  );
}
