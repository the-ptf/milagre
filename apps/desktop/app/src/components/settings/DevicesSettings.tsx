import { DesignPageShareDialog } from "../agents/DesignPageShareDialog";
import { PRIVACY_URL, SUPPORT_URL } from "@milagre/shared/site-links";
import { SettingCheckbox } from "../primitives/Checkbox";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useCallback, useEffect, useRef, useState } from "react";
import { LaptopIcon, SmartphoneIcon } from "@hugeicons/core-free-icons";
import { routeLine, seenAgo, useComputers } from "../../lib/computers";
import type { ComputerView, PairedDevice, PhoneStatus } from "../../electron";
import { updateSettings, useSettings } from "../../lib/settings";
import { bridgeFor } from "../../lib/computer-bridge";
import { cloudflarePhonesNote, pairingWindow, phoneLanLine, phoneQrSrc, phoneStatusLine } from "../../lib/phone";
import { deviceName, deviceSeenLine, devicesByKind, newDeviceKeys, removeDeviceQuestion } from "../../lib/devices";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { ComputerResourceList, type ResourceComputer } from "./ComputerResources";
import { SimlockSettings } from "./SimlockSettings";
import { ComputerUseRow, ComputerUseSettings } from "./ComputerUseSettings";
import { thisComputer } from "../../lib/shortcut-hints";
import { Icon, SECONDARY_BUTTON, DANGER_BUTTON } from "./settings-parts";

/** Every public link to a design or artifact this computer published, revocable even after its Chat is deleted. */
function PublishedPagesSettings() {
  const [publishedPages, setPublishedPages] = useState(false);
  return (
    <div data-slot="published-pages-setting">
      <Row label="Published pages" description="Manage public links to designs and artifacts, including pages from deleted Chats.">
        <button type="button" className="rounded-control border border-line px-3 py-1.5 text-12 hover:bg-hover" onClick={() => setPublishedPages(true)}>
          Manage
        </button>
      </Row>
      {publishedPages && <DesignPageShareDialog onClose={() => setPublishedPages(false)} />}
    </div>
  );
}

/** Who can reach this computer and what it shares: device access and pairing, simulators, published pages. */
export function PhoneSharingPage({ title }: { title?: string }) {
  return (
    <>
      <h1 className="text-22 font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <DevicesSettings />
      <Group title="Simulators">
        <SimlockSettings />
      </Group>
      <Group title="Designs and artifacts">
        <PublishedPagesSettings />
      </Group>
    </>
  );
}

/** This computer's own page: its memory and disk, the other computers it drives, and Computer use. */
export function ThisMacPage({ title, onAddComputer }: { title?: string; onAddComputer?: () => void }) {
  const [page, setPage] = useState<"this-mac" | "computer-use">("this-mac");
  if (page === "computer-use") return <ComputerUseSettings parent={title} onBack={() => setPage("this-mac")} />;
  return (
    <div data-this-mac-settings>
      <h1 className="text-22 font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <DeviceResources />
      <OtherComputersSetting onAddComputer={onAddComputer} />
      <Group title="Automation">
        <ComputerUseRow onOpen={() => setPage("computer-use")} />
      </Group>
    </div>
  );
}

/** Settings › This Mac: memory and disk on this Mac and on every computer it drives, Milagre's share marked. */
/** A paired computer as a memory and disk row: its route while it answers, else when it was last seen. */
export function resourceComputer(computer: ComputerView, now: number): ResourceComputer {
  const online = computer.state === "online";
  const seen = seenAgo(computer.lastSeen, now);
  return {
    id: computer.id,
    name: computer.name,
    detail: online ? routeLine(computer, now) : "Offline",
    bridge: bridgeFor(computer.id),
    online,
    seen: seen ? `Seen ${seen}` : null,
  };
}

/** Settings › This Mac: memory and disk on this Mac and on every computer it drives. */
function DeviceResources() {
  const { otherComputers } = useSettings();
  const { thisMac, computers } = useComputers();
  // "Seen 2h ago" keeps counting while the page stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const rows: ResourceComputer[] = [
    {
      id: "this-mac",
      name: thisMac,
      detail: "This computer",
      bridge: window.milagre,
      online: true,
    },
    ...(otherComputers ? computers.map((computer) => resourceComputer(computer, now)) : []),
  ];
  return (
    <Group>
      <ComputerResourceList computers={rows} />
    </Group>
  );
}

function OtherComputersSetting({ onAddComputer }: { onAddComputer?: () => void }) {
  const { otherComputers } = useSettings();
  return (
    <Group>
      <Row label="Drive other computers" description="Drive the chats of other computers running Milagre from this window. Their Projects join the sidebar.">
        <SettingCheckbox label="Drive other computers" checked={otherComputers} onChange={(next) => updateSettings({ otherComputers: next })} />
      </Row>
      {otherComputers && onAddComputer && (
        <Row
          label="Add computer"
          description="Pair with another computer using the link from its Settings › Phone & sharing. The laptop button in the sidebar adds one too."
        >
          <button type="button" data-settings-add-computer onClick={onAddComputer} className={SECONDARY_BUTTON}>
            Add computer…
          </button>
        </Row>
      )}
    </Group>
  );
}

/* ─────────────────────────────────────────────────────────
 * DEVICES
 * The host runs the bridge the Milagre phone app talks to.
 * Turning it on shows a QR code that carries the access token;
 * resetting makes a new token, so every paired device pairs again.
 * Below it, the phones and computers paired to this Mac.
 * ───────────────────────────────────────────────────────── */
function usePhoneStatus() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let pushed = false;
    // An update that arrives while the first read is in flight is newer than that read.
    const off = window.milagre.onPhoneStatus((next) => {
      pushed = true;
      setStatus(next);
    });
    window.milagre.getPhoneStatus().then(
      (next) => {
        // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
        if (live && !pushed) setStatus(next);
      },
      (error) => {
        if (live) setLoadError(`Couldn't read device access: ${ipcErrorMessage(error)}`);
      },
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  return { status, setStatus, loadError };
}

/**
 * The paired devices. A pairing, a removal or a reset arrives as a phone status, which reads the list again; a device
 * connecting or leaving doesn't, so it is also read every 15 seconds while the section is open.
 * `fresh`: phones that paired since the owner last looked (a phone may pair while Milagre is closed). They stay marked
 * New while the section is open; the host hears at once that they were shown, so the next visit doesn't mark them.
 */
function usePairedDevices() {
  const [list, setList] = useState<PairedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const show = useCallback((devices: PairedDevice[]) => {
    setList(devices);
    setError(null);
    setNow(Date.now());
    const keys = newDeviceKeys(devices);
    if (!keys.length) return;
    setFresh((current) => (keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys])));
    // Only the keys shown here: a phone that pairs after this read stays New until it is shown too.
    void window.milagre.acknowledgeDevices(keys).catch(() => {});
  }, []);
  useEffect(() => {
    let live = true;
    const read = () => {
      window.milagre.listDevices().then(
        (devices) => {
          if (live) show(devices);
        },
        (failure) => {
          if (live) setError(`Couldn't read paired devices: ${ipcErrorMessage(failure)}`);
        },
      );
    };
    read();
    const off = window.milagre.onPhoneStatus(read);
    const timer = window.setInterval(read, 15_000);
    return () => {
      live = false;
      off();
      window.clearInterval(timer);
    };
  }, [show]);
  // `replace`: a list the caller already has (a removal's answer), shown at once; an earlier read error no longer applies.
  return { list, replace: show, error, now, fresh };
}

function DeviceGroup({
  devices,
  fresh,
  now,
  busy,
  empty,
  error,
  footer,
  onRemove,
}: {
  devices: PairedDevice[];
  /** Keys marked New. */
  fresh: ReadonlySet<string>;
  now: number;
  busy: boolean;
  empty?: string;
  error?: string | null;
  footer?: string | null;
  onRemove: (key: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Group>
      {error ? (
        <p data-devices-error className="break-words px-4 py-3 text-12 text-red-ink">
          {error}
        </p>
      ) : (
        devices.length === 0 &&
        empty && (
          <p data-devices-empty className="px-4 py-3 text-12 text-ink-3">
            {empty}
          </p>
        )
      )}
      {devices.map((device) => {
        const asking = confirming === device.key;
        return (
          <div key={device.key} data-device-row={device.kind} data-device-key={device.key} className="flex min-h-12 items-center gap-3 px-4 py-2">
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-control bg-hover text-ink-2">
              <Icon icon={device.kind === "computer" ? LaptopIcon : SmartphoneIcon} size={15} />
              <span
                aria-hidden
                className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface ${device.route ? "bg-green" : "bg-ink-3"}`}
              />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-13 font-medium text-ink">{deviceName(device)}</span>
                {fresh.has(device.key) && (
                  <span
                    data-device-new
                    title="Paired since you last looked"
                    className="shrink-0 rounded-full bg-accent-tint px-1.5 py-px text-10 font-semibold text-accent-ink"
                  >
                    New
                  </span>
                )}
              </span>
              <span data-device-line className="text-12 text-ink-3">
                {asking ? removeDeviceQuestion(device) : deviceSeenLine(device, now)}
              </span>
            </div>
            {asking ? (
              <span className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => setConfirming(null)} className={SECONDARY_BUTTON}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  data-device-remove-confirm
                  onClick={() => {
                    setConfirming(null);
                    onRemove(device.key);
                  }}
                  className={DANGER_BUTTON}
                >
                  Remove
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                data-device-remove
                onClick={() => setConfirming(device.key)}
                className="shrink-0 rounded-control px-2 py-1 text-12 text-red-ink transition-colors hover:bg-red/5 disabled:cursor-default disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
      {footer && (
        <p data-devices-note className="px-4 py-3 text-12 text-ink-3">
          {footer}
        </p>
      )}
    </Group>
  );
}

function DevicesSettings() {
  const { status, setStatus, loadError } = usePhoneStatus();
  const paired = usePairedDevices();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pairingRoute, setPairingRoute] = useState("automatic");
  const pairingOption = status?.pairingOptions?.find((option) => option.id === pairingRoute) ?? status?.pairingOptions?.[0];
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const run = (action: () => Promise<PhoneStatus>) => {
    setBusy(true);
    setError(null);
    action()
      .then(setStatus, (failure) => setError(ipcErrorMessage(failure)))
      .finally(() => setBusy(false));
  };
  const removeDevice = (key: string) => {
    setBusy(true);
    setError(null);
    window.milagre
      .removeDevice(key)
      .then(paired.replace, (failure) => setError(ipcErrorMessage(failure)))
      .finally(() => setBusy(false));
  };
  const copyLink = () => {
    const link = pairingOption?.link ?? status?.computerLink ?? status?.pairingLink;
    if (!link) return;
    void navigator.clipboard.writeText(link).then(
      () => {
        setCopied(true);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };

  const on = status?.state === "on" && status.qrSvg && status.pairingLink;
  // Showing the QR is what invites a new device to pair, so it opens the window; a status that arrives later keeps the countdown honest.
  const showingQr = Boolean(on) && status?.pairingUntil !== undefined;
  useEffect(() => {
    if (!showingQr) return;
    let live = true;
    window.milagre.openPhonePairing().then(
      (next) => {
        // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
        if (live) setStatus(next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [showingQr, setStatus]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!showingQr) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [showingQr, status?.pairingUntil]);
  const pairing = pairingWindow(status, now);
  const { computers, phones } = devicesByKind(paired.list ?? []);
  return (
    <>
      <p className="mt-1 text-13 text-ink-2">Phones and other computers that can see and drive {thisComputer}'s chats, and what you share.</p>
      <Group>
        <Row label="Allow devices to connect" description={loadError ?? phoneStatusLine(status)}>
          <SettingCheckbox
            label="Allow devices to connect"
            checked={status?.enabled === true}
            onChange={(enabled) => {
              if (!busy && status) run(() => window.milagre.setPhoneEnabled(enabled));
            }}
          />
        </Row>
        {status?.enabled && status.lan && (
          <Row label="Allow on local network" description={phoneLanLine(status) ?? ""}>
            <SettingCheckbox
              label="Allow on local network"
              checked={status.lan.enabled}
              onChange={(enabled) => {
                if (!busy) run(() => window.milagre.setPhoneLan(enabled));
              }}
            />
          </Row>
        )}
        {status?.state === "on" && status.remote === "none" && (
          <p data-phone-local-only className="px-4 py-3 text-12 text-ink-3">
            Only a phone simulator on {thisComputer} can connect. Set up a Cloudflare tunnel with npm run mobile:cloudflare to reach {thisComputer} from any
            network.
          </p>
        )}
        {status?.state === "error" && status.error && (
          <p data-phone-error className="break-words px-4 py-3 text-12 text-red-ink">
            {status.error}
          </p>
        )}
        {error && (
          <p data-phone-action-error className="break-words px-4 py-3 text-12 text-red-ink">
            Couldn't change device access: {error}
          </p>
        )}
      </Group>
      {on && (
        <PhonePairingGroup
          status={status}
          pairingOption={pairingOption}
          onPairingRoute={setPairingRoute}
          copied={copied}
          onCopy={copyLink}
          pairing={pairing}
          busy={busy}
          onAllowPairing={() => run(() => window.milagre.openPhonePairing())}
        />
      )}
      {computers.length > 0 && <DeviceGroup devices={computers} fresh={paired.fresh} now={paired.now} busy={busy} onRemove={removeDevice} />}
      <DeviceGroup
        devices={phones}
        fresh={paired.fresh}
        now={paired.now}
        busy={busy}
        empty={paired.list === null ? undefined : "No phones yet"}
        error={paired.error}
        footer={cloudflarePhonesNote(status)}
        onRemove={removeDevice}
      />
      {status?.enabled && (
        <ResetAccessGroup
          status={status}
          busy={busy}
          confirmReset={confirmReset}
          onConfirmReset={setConfirmReset}
          onReset={() => run(() => window.milagre.resetPhoneAccess())}
        />
      )}
    </>
  );
}

function PhonePairingGroup({
  status,
  pairingOption,
  onPairingRoute,
  copied,
  onCopy,
  pairing,
  busy,
  onAllowPairing,
}: {
  status: PhoneStatus;
  pairingOption: NonNullable<PhoneStatus["pairingOptions"]>[number] | undefined;
  onPairingRoute: (route: string) => void;
  copied: boolean;
  onCopy: () => void;
  pairing: ReturnType<typeof pairingWindow>;
  busy: boolean;
  onAllowPairing: () => void;
}) {
  return (
    <Group>
      {(status.pairingOptions?.length ?? 0) > 1 && (
        <Row
          label="Connect through"
          description="Automatic tries LAN and Tailscale before the remote connection. Private pairing needs both devices on the same network or tailnet."
        >
          <Select
            label="Pairing connection"
            value={pairingOption?.id ?? "automatic"}
            options={status.pairingOptions!.map(({ id, label }) => ({
              value: id,
              label,
            }))}
            onChange={onPairingRoute}
          />
        </Row>
      )}
      <div className="flex items-start gap-5 px-4 py-4">
        <img
          data-phone-qr
          src={phoneQrSrc(pairingOption?.qrSvg ?? status.qrSvg!)}
          alt="QR code to pair your phone"
          width={176}
          height={176}
          className="size-44 shrink-0 rounded-card bg-paper"
        />
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <span className="text-13 font-medium text-ink">Scan with the Milagre app</span>
            <span className="text-12 text-ink-3">Open the app on your phone and point its camera at this code.</span>
          </div>
          <div>
            <button type="button" onClick={onCopy} className={SECONDARY_BUTTON}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p data-phone-warning className="text-12 text-ink-2">
            This code gives access to your agents. Don't share it or post a screenshot of it.
          </p>
          <p className="flex gap-4 text-12 underline underline-offset-4">
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Privacy policy
            </a>
            <a href={SUPPORT_URL} target="_blank" rel="noreferrer">
              Support
            </a>
          </p>
          {pairing && (
            <div data-phone-pairing={pairing.open ? "open" : "closed"} className="flex flex-wrap items-center gap-3">
              <span className="text-12 text-ink-3">
                {pairing.open
                  ? `New devices can pair for ${pairing.minutes} more ${pairing.minutes === 1 ? "minute" : "minutes"}`
                  : "Pairing is closed to new devices."}
              </span>
              {!pairing.open && (
                <button type="button" disabled={busy} data-phone-allow-pairing onClick={onAllowPairing} className={SECONDARY_BUTTON}>
                  Allow pairing again
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </Group>
  );
}

function ResetAccessGroup({
  status,
  busy,
  confirmReset,
  onConfirmReset,
  onReset,
}: {
  status: PhoneStatus;
  busy: boolean;
  confirmReset: boolean;
  onConfirmReset: (confirm: boolean) => void;
  onReset: () => void;
}) {
  return (
    <Group>
      <Row
        label="Reset access"
        description={
          confirmReset
            ? "Devices that already paired stop working and must pair again. This can't be undone."
            : "Make a new code. Devices that already paired pair again."
        }
      >
        {confirmReset ? (
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => onConfirmReset(false)} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              data-phone-reset-confirm
              onClick={() => {
                onConfirmReset(false);
                onReset();
              }}
              className={DANGER_BUTTON}
            >
              Reset and disconnect
            </button>
          </span>
        ) : (
          <button type="button" disabled={busy || status.state === "starting"} onClick={() => onConfirmReset(true)} className={SECONDARY_BUTTON}>
            Reset access
          </button>
        )}
      </Row>
    </Group>
  );
}
