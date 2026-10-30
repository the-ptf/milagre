import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "../../lib/ease";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowLeft01Icon, Cancel01Icon, SmartphoneIcon } from "@hugeicons/core-free-icons";
import { SIMLOCK_DEVICE_PREFIX, type SimlockModel, type SimulatorApi, type SimulatorDevice, type SimulatorList } from "@milagre/shared/simulator";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  createSimulatorBridge,
  createSimulatorReceiverHtml,
  SIMULATOR_CONNECTION_LABELS,
  type SimulatorConnection,
  type SimulatorConnectionState,
} from "@milagre/shared/simulator-receiver";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { PillSlot, StatusPill } from "../primitives/StatusPill";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { viewerTheme } from "./viewerTheme";
import { dockLayer, useCloseWhenDesignsExpand, useDockArea, useSidePanelRoom } from "./dock-area";
import { useSidePanel } from "./PanelToggles";
import { ResizableDockSlide } from "./DockSlide";
import { usePanelWidth } from "./panel-width";
import { onAnyAgentEvent, useBridge } from "../../lib/computer-bridge";
import { isTurnEnd } from "@milagre/shared/agent-runs";
import { thisComputer } from "../../lib/shortcut-hints";

/** The host owns persistent associations; discovery never attaches a device. */
export function SimulatorTrack({ chatId }: { chatId: string }) {
  // Read once: the polling effect depends on it, and a bridge that hands out a new object per read would restart it every render.
  const bridge = useBridge();
  const [api] = useState(() => bridge?.simulators);
  const [simlock] = useState(() => bridge?.simlock);
  // Experimental: models the Simlock pool can lease, read when the attach list opens; null when it is off.
  const [pool, setPool] = useState<{ models: SimlockModel[]; error?: string } | null>(null);
  const [leasing, setLeasing] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const revision = useRef(0);
  const [list, setList] = useState<SimulatorList>({ devices: [], supported: true });
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<SimulatorDevice | null>(null);
  const [connection, setConnection] = useState<SimulatorConnection | null>(null);
  const connectionState = connection?.deviceId === selected?.id && connection ? connection.state : "connecting";
  // A device's viewer always docks beside the chat; the device list is a popover over its pill.
  const docked = !!selected;
  const [loading, setLoading] = useState(true);
  const [attaching, setAttaching] = useState(false),
    [busy, setBusy] = useState(false);
  const close = useCallback(() => {
    setOpened(false);
    setSelected(null);
    setAttaching(false);
  }, []);
  // Docked, the viewer is a side panel: pressing the chat or focusing the iframe must not dismiss it.
  const dock = useDockArea();
  const reduced = useReducedMotion();
  useCloseWhenDesignsExpand(close);
  // Docked, its width plus the 12px gap to the chat. The chat panes reserve it through --simulator-dock.
  const resize = usePanelWidth("simulator");
  useSidePanelRoom("simulator", opened && docked, resize.width + 12, close);
  const bounds = useAnchoredPopover({
    opened: opened && !docked,
    setOpened: (value) => {
      if (!value) close();
    },
    trigger,
    panel,
    width: 390,
    height: 650,
  });
  // The list read, for the poll below; a no-op while unmounted.
  const refreshList = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!api) return;
    let disposed = false,
      busy = false;
    const refresh = async () => {
      if (document.hidden || busy) return;
      busy = true;
      const started = revision.current;
      try {
        const result = await api.list({ chatId });
        if (result.chatId !== chatId) throw new Error(`Update Milagre on ${thisComputer} to attach simulators to Chats.`);
        if (!disposed && started === revision.current) {
          setList(result);
          if (!result.attached?.length) close();
          setSelected((current) => (current && result.devices.find((d) => d.id === current.id)) || null);
        }
      } catch (error) {
        if (!disposed && started === revision.current)
          setList((current) => ({ ...current, error: error instanceof Error ? error.message : "Could not list simulators." }));
      } finally {
        busy = false;
        if (!disposed) setLoading(false);
      }
    };
    // The receiver pauses its own video while hidden and reconnects when shown, so the panel stays open.
    const visibility = () => {
      if (!document.hidden) void refresh();
    };
    refreshList.current = refresh;
    void refresh();
    document.addEventListener("visibilitychange", visibility);
    // With nothing attached nothing is polled (the pill shows nothing then): a simulator joins the Chat when its agent
    // attaches one with its tool, so that step finishing, and each turn's end, read the list again; so does coming back
    // to the window, after one was attached from the phone or another window.
    const focused = () => void refresh();
    window.addEventListener("focus", focused);
    const simulatorSteps = new Set<string>();
    const offAgent = onAnyAgentEvent(({ chatId: from, event }) => {
      if (from !== chatId) return;
      if (event.type === "step-started" && /simulator/i.test(event.step.title ?? "")) simulatorSteps.add(event.step.id);
      else if ((event.type === "step-completed" && simulatorSteps.delete(event.id)) || isTurnEnd(event)) void refresh();
    });
    return () => {
      disposed = true;
      refreshList.current = async () => {};
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focused);
      offAgent();
    };
  }, [api, close, chatId]);
  const mutate = async (method: "attach" | "detach", device: SimulatorDevice) => {
    if (!api || busy) return;
    setBusy(true);
    revision.current++;
    try {
      const result = await api[method]({ chatId, deviceId: device.id });
      setList(result);
      setAttaching(false);
      setSelected(method === "attach" ? device : null);
      if (!result.attached?.length) close();
    } catch (error) {
      setList((current) => ({ ...current, error: error instanceof Error ? error.message : "Could not update attachment." }));
    } finally {
      revision.current++;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!attaching || !simlock) return;
    let live = true;
    void (async () => {
      try {
        if (!(await simlock.readSettings()).enabled) return live && setPool(null);
        const { models } = await simlock.models();
        if (live) setPool({ models });
      } catch (error) {
        if (live) setPool({ models: [], error: ipcErrorMessage(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [attaching, simlock]);
  const lease = async (model: SimlockModel) => {
    if (!simlock || busy) return;
    setBusy(true);
    setLeasing(`${model.platform}:${model.model}`);
    revision.current++;
    try {
      const leased = await simlock.lease({ chatId, platform: model.platform, model: model.model });
      setAttaching(false);
      await refreshList.current();
      setSelected({ id: leased.deviceId, name: `${leased.name} (Simlock)`, platform: leased.platform, version: leased.version });
    } catch (error) {
      setPool((current) => ({ models: current?.models ?? [], error: ipcErrorMessage(error) }));
    } finally {
      revision.current++;
      setLeasing(null);
      setBusy(false);
    }
  };
  const release = async (device: SimulatorDevice) => {
    if (!simlock || busy) return;
    setBusy(true);
    revision.current++;
    try {
      await simlock.release({ deviceId: device.id });
    } catch {
      // An ended lease only needs its attachment removed.
    } finally {
      revision.current++;
      setBusy(false);
    }
    await mutate("detach", device);
  };
  const attachedCount = list.attached?.length ?? 0;
  // While a device is attached, or the panel is open to attach one, the list is polled: devices come and go on their own.
  const polling = Boolean(api && (attachedCount > 0 || opened));
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void refreshList.current(), 5000);
    return () => clearInterval(timer);
  }, [polling]);
  const sole = list.devices.length === 1 ? list.devices[0] : null;
  const open = useCallback(() => {
    if (opened) {
      close();
      return;
    }
    setSelected(sole ?? null);
    setOpened(true);
  }, [opened, close, sole]);
  // The window's top-right corner offers the simulator too, while this Chat has one attached.
  useSidePanel("simulator", api && list.supported && attachedCount ? { open: opened, toggle: open } : null);
  if (!api || !list.supported || !attachedCount) return <AnimatePresence initial={false} />;
  const panelContent = (
    <>
      {!selected && (
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          {attaching ? (
            <Tooltip label="Back to devices">
              <button
                type="button"
                aria-label="Back to devices"
                onClick={() => {
                  setSelected(null);
                  setAttaching(false);
                }}
                className="rounded p-1 text-ink-2 hover:bg-hover"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
              </button>
            </Tooltip>
          ) : (
            <HugeiconsIcon icon={SmartphoneIcon} size={16} aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px]">{attaching ? "Attach simulator" : selected ? "Simulator" : "Simulators"}</div>
            {!selected && <div className="text-[11px] text-ink-3">{attaching ? `Other devices on ${thisComputer}` : "This Chat"}</div>}
          </div>
          <Tooltip label="Close simulator">
            <button type="button" aria-label="Close simulator" onClick={close} className="rounded p-1 text-ink-2 hover:bg-hover">
              <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden />
            </button>
          </Tooltip>
        </header>
      )}
      {selected ? (
        <>
          <header className="flex shrink-0 items-center justify-between gap-3 px-[18px] pb-1 pt-4">
            <div className="min-w-0 flex-1">
              <button
                type="button"
                aria-label={`${selected.name}, choose simulator`}
                onClick={() => setSelected(null)}
                className="-ml-1 flex max-w-full items-center gap-1 rounded px-1 text-[13px] font-medium hover:bg-hover"
              >
                <span className="truncate">{selected.name}</span>
                <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="shrink-0 text-ink-3" aria-hidden />
              </button>
              <div className="mt-1 text-[11px] text-ink-3">
                {selected.platform === "android" ? "Android" : "iOS"} {selected.version}
                {selected.id.startsWith(SIMLOCK_DEVICE_PREFIX) && " · Leased from Simlock"}
              </div>
            </div>
            <div data-slot="simulator-connection" data-state={connectionState} className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-2">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${connectionState === "live" ? "bg-green" : connectionState === "error" ? "bg-red" : "bg-ink-3"}`}
              />
              {SIMULATOR_CONNECTION_LABELS[connectionState]}
            </div>
            <Tooltip label="Close simulator">
              <button type="button" aria-label="Close simulator" onClick={close} className="rounded p-2 text-ink-2 hover:bg-hover">
                <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden />
              </button>
            </Tooltip>
          </header>
          <SimulatorFrame key={selected.id} api={api} device={selected} chatId={chatId} onClose={close} onConnection={setConnection} />
        </>
      ) : (
        <ScrollArea className="p-1">
          {loading && (
            <p role="status" className="p-3 text-[13px] text-ink-2">
              Finding running simulators...
            </p>
          )}
          {list.error && (
            <p role="alert" className="p-3 text-[13px] text-red-ink">
              {list.error}
            </p>
          )}
          {!loading && !list.error && !(attaching ? list.available : list.attached)?.length && (
            <p className="p-3 text-[13px] text-ink-2">
              {attaching ? `No other devices are running on ${thisComputer}.` : "No simulators attached to this Chat."}
            </p>
          )}
          {(attaching ? (list.available ?? []) : (list.attached ?? [])).map((device) => {
            const running = attaching || list.devices.some((d) => d.id === device.id);
            return (
              <div key={device.id} className="flex items-center">
                <button
                  type="button"
                  disabled={busy || !running}
                  data-simulator-device={device.id}
                  onClick={() => (attaching ? void mutate("attach", device) : setSelected(device))}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-hover disabled:opacity-50"
                >
                  <HugeiconsIcon icon={SmartphoneIcon} size={16} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{device.name}</span>
                  <span className="text-[11px] text-ink-3">
                    {running ? `${device.platform === "android" ? "Android" : "iOS"} ${device.version}` : "Stopped"}
                  </span>
                </button>
                {!attaching &&
                  (device.id.startsWith(SIMLOCK_DEVICE_PREFIX) ? (
                    <Tooltip label="Return to the Simlock pool">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Return ${device.name} to the Simlock pool`}
                        onClick={() => void release(device)}
                        className="rounded-control p-2 text-ink-3 hover:bg-hover"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
                      </button>
                    </Tooltip>
                  ) : (
                    <Tooltip label="Detach from Chat">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Detach ${device.name} from Chat`}
                        onClick={() => void mutate("detach", device)}
                        className="rounded p-2 text-ink-3 hover:bg-hover"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
                      </button>
                    </Tooltip>
                  ))}
              </div>
            );
          })}
          {!attaching && (
            <button type="button" onClick={() => setAttaching(true)} className="w-full rounded-md px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-hover">
              Attach simulator
            </button>
          )}
          {attaching && pool && (
            <section aria-label="Lease from Simlock" data-slot="simlock-models" className="mt-1 border-t border-line pt-1">
              <div className="px-3 pb-1 pt-2 text-11 text-ink-3">Lease from Simlock: a fresh device of its own, returned wiped</div>
              {pool.error && (
                <p role="alert" className="px-3 py-2 text-13 text-red-ink">
                  {pool.error}
                </p>
              )}
              {leasing && (
                <p role="status" className="px-3 py-2 text-13 text-ink-2">
                  Leasing... Simlock boots the device and may queue behind other agents.
                </p>
              )}
              {pool.models.map((model) => (
                <button
                  key={`${model.platform}:${model.model}`}
                  type="button"
                  disabled={busy}
                  data-simlock-model={model.model}
                  onClick={() => void lease(model)}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left hover:bg-hover disabled:opacity-50"
                >
                  <HugeiconsIcon icon={SmartphoneIcon} size={16} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-13">{model.model}</span>
                  <span className="text-11 text-ink-3">
                    {model.platform === "android" ? "Android" : "iOS"} {model.version}
                  </span>
                </button>
              ))}
            </section>
          )}
        </ScrollArea>
      )}
    </>
  );
  return (
    <AnimatePresence initial={false}>
      <PillSlot key="simulator-track" slot="simulator-track">
        <Tooltip label="Simulators attached to this Chat" align="end">
          <StatusPill
            ref={trigger}
            aria-haspopup="dialog"
            aria-expanded={opened}
            aria-controls={opened ? panelId : undefined}
            aria-label={`Simulators, ${attachedCount} attached to this Chat`}
            onClick={open}
            icon={SmartphoneIcon}
            label="Simulators"
            count={attachedCount}
          />
        </Tooltip>
        {createPortal(
          <AnimatePresence>
            {opened &&
              (docked ? (
                <ResizableDockSlide
                  key="simulator-dock"
                  // Docked, it opens like the git changes panel, lines up with the sidebar's card, and sits left of the
                  // changes panel; the chat makes room through --simulator-dock. A drag on its edge doesn't render the
                  // viewer again.
                  panel="simulator"
                  label="Resize simulator"
                  width={resize.width}
                  reserve="--simulator-dock"
                  ref={panel}
                  id={panelId}
                  role="dialog"
                  aria-label="Simulator"
                  aria-modal="false"
                  tabIndex={-1}
                  data-slot="simulator-popover"
                  data-docked
                  style={{ top: dock?.top ?? 40, right: (dock?.right ?? 0) + 12, bottom: dock?.bottom ?? 12 }}
                  className="fixed z-[42] focus:outline-none"
                  panelClassName="overflow-hidden rounded-[10px] border border-line bg-surface text-ink shadow-raised"
                >
                  {panelContent}
                </ResizableDockSlide>
              ) : (
                <motion.div
                  key="simulator"
                  // Anchored over its pill, the device list rises from it.
                  initial={reduced ? false : { opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 6, scale: 0.98 }}
                  transition={{ duration: 0.18, ease: EASE_OUT }}
                  ref={panel}
                  id={panelId}
                  role="dialog"
                  aria-label="Simulator"
                  aria-modal="false"
                  tabIndex={-1}
                  data-slot="simulator-popover"
                  style={{ ...bounds, height: selected ? 650 : undefined }}
                  className="fixed z-50 flex flex-col overflow-hidden rounded-[10px] border border-line bg-surface text-ink shadow-raised focus:outline-none"
                >
                  {panelContent}
                </motion.div>
              ))}
          </AnimatePresence>,
          dockLayer(),
        )}
      </PillSlot>
    </AnimatePresence>
  );
}

function SimulatorFrame({
  api,
  device,
  chatId,
  onClose,
  onConnection,
}: {
  api: SimulatorApi;
  device: SimulatorDevice;
  chatId: string;
  onClose(): void;
  onConnection(connection: SimulatorConnection): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const deviceId = device.id;
  // The keyed viewer lasts for this device. Discovery metadata must not reload its active stream.
  const [html] = useState(() => createSimulatorReceiverHtml({ deviceId, device, theme: viewerTheme() }));
  const syncTheme = useCallback(() => frame.current?.contentWindow?.postMessage({ channel: "milagre-simulator-theme", theme: viewerTheme() }, "*"), []);
  useEffect(() => {
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [syncTheme]);
  useEffect(() => {
    const bridge = createSimulatorBridge(
      (method, args) => (api[method] as (request: unknown) => Promise<unknown>)(method === "open" ? { ...(args as object), chatId } : args),
      (reply) => frame.current?.contentWindow?.postMessage(reply, "*"),
    );
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.channel === "milagre-simulator" && event.data.event === "state" && Object.hasOwn(SIMULATOR_CONNECTION_LABELS, event.data.state)) {
        onConnection({ deviceId, state: event.data.state as SimulatorConnectionState });
        return;
      }
      if (event.data?.channel === "milagre-simulator" && event.data.event === "close") {
        onClose();
        return;
      }
      void bridge.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      bridge.dispose();
    };
  }, [api, deviceId, chatId, onClose, onConnection]);
  return (
    <iframe
      ref={frame}
      onLoad={syncTheme}
      title="Live simulator"
      data-slot="simulator-frame"
      srcDoc={html}
      // oxlint-disable-next-line react/iframe-missing-sandbox -- flagged for review, see PR body
      sandbox="allow-scripts allow-same-origin"
      allow="autoplay"
      className="min-h-0 w-full flex-1 border-0 bg-surface"
    />
  );
}
