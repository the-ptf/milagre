import { useEffect, useRef, useState } from "react";
import { LaptopIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import { privatePairingLink } from "@milagre/shared/pairing-link";
import { Switch } from "./primitives/Switch";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { FIELD, FIELD_LABEL } from "./primitives/Field";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import type { AddComputerResult, ComputerPreview, ComputerView } from "../electron";

/**
 * Add computer (design add-computer v1): paste another Mac's pairing link, see the computer it names, and pair with it,
 * waiting while its owner clicks Allow there. Mounted only while open: other screens look for the page's one dialog.
 */
export function AddComputerDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (computer: ComputerView) => void }) {
  const [link, setLink] = useState("");
  const [privateOnly, setPrivateOnly] = useState(false);
  let selectedLink = link.trim();
  let selectionError = "";
  try {
    if (selectedLink && privateOnly) selectedLink = privatePairingLink(selectedLink);
  } catch (cause) {
    selectionError = ipcErrorMessage(cause);
  }
  const [preview, setPreview] = useState<ComputerPreview | null>(null);
  const [name, setName] = useState("");
  const typedName = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const reads = useRef(0);

  useEffect(() => window.milagre.onComputerAddPending(() => setWaiting(true)), []);
  // A parent that unmounts the dialog mid-pairing still stops it: nothing is left waiting on the other Mac's Allow.
  const addingNow = useRef(false);
  useEffect(() => {
    addingNow.current = adding;
  }, [adding]);
  useEffect(
    () => () => {
      if (addingNow.current) void window.milagre.computers.cancelAdd();
    },
    [],
  );

  // Each change to the link is read again before anything is sent; an older answer that arrives late is dropped.
  useEffect(() => {
    const text = selectedLink;
    const read = ++reads.current;
    setPreview(null);
    setError(null);
    if (selectionError) return setError(selectionError);
    if (!text) return;
    window.milagre.computers.preview(text).then(
      (found) => {
        if (read !== reads.current) return;
        setPreview(found);
        if (!typedName.current) setName(found.name);
      },
      (cause) => {
        if (read === reads.current) setError(ipcErrorMessage(cause));
      },
    );
  }, [selectedLink, selectionError]);

  const close = () => {
    if (adding) void window.milagre.computers.cancelAdd();
    onClose();
  };
  async function add() {
    if (!preview || adding) return;
    setAdding(true);
    setWaiting(false);
    setError(null);
    const result: AddComputerResult = await window.milagre.computers.add(selectedLink, { name: name.trim() || preview.name }).catch((cause: unknown) => ({
      ok: false as const,
      code: "failed",
      message: ipcErrorMessage(cause),
    }));
    // Cleared before onAdded unmounts the dialog, or the unmount cleanup would cancel a pairing that already succeeded.
    addingNow.current = false;
    setAdding(false);
    setWaiting(false);
    if (result.ok) onAdded(result.computer);
    else if (result.code !== "cancelled") setError(result.message);
  }
  async function paste() {
    try {
      setLink(await navigator.clipboard.readText());
    } catch {
      /* the field still takes ⌘V */
    }
  }

  return (
    <Dialog
      data-add-computer
      title="Add computer"
      description="See and drive another Mac's Chats from this window."
      onClose={close}
      // A press on the scrim closes it, unless a pairing is under way; Esc and the × cancel the pairing.
      dismissOnScrim={!adding}
      width={460}
      actions={
        waiting && preview ? (
          <>
            <p role="status" data-add-computer-waiting className="mr-auto self-center text-13 text-ink-2">
              Waiting for {preview.name} to allow this Mac…
            </p>
            <Button variant="ghost" onClick={() => void window.milagre.computers.cancelAdd()}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!preview || adding} onClick={() => void add()}>
              {adding ? "Connecting…" : "Add computer"}
            </Button>
          </>
        )
      }
    >
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-13 text-ink-2">
        <li>On the other Mac, open Milagre Settings › Devices.</li>
        <li>Click Pair a device, then Copy link.</li>
        <li>Paste it here. The link works for 10 minutes.</li>
      </ol>
      <label className={`mt-4 block ${FIELD_LABEL}`} htmlFor="add-computer-link">
        Pairing link
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          id="add-computer-link"
          aria-label="Pairing link"
          value={link}
          disabled={adding}
          spellCheck={false}
          autoFocus
          placeholder="milagre://pair?…"
          onChange={(event) => setLink(event.target.value)}
          className={`${FIELD} font-mono`}
        />
        <Button variant="secondary" disabled={adding} onClick={() => void paste()}>
          Paste
        </Button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-13">
        <span>LAN or Tailscale only</span>
        <Switch
          label="LAN or Tailscale only"
          checked={privateOnly}
          disabled={adding}
          onChange={(value) => {
            if (!adding) setPrivateOnly(value);
          }}
        />
      </div>
      <p className="mt-1 text-12 text-ink-3">Automatic tries private routes first. Private pairing needs both devices on the same network or tailnet.</p>
      {preview && (
        <div data-add-computer-found className="mt-3 flex items-center gap-3 rounded-card bg-hover p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-hover-2 text-ink-2">
            <Icon icon={LaptopIcon} size={18} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-13 font-medium">{preview.name}</span>
            <span className="block text-12 text-ink-3">Reached through {preview.relayHost} · end-to-end encrypted</span>
          </span>
        </div>
      )}
      {preview && (
        <>
          <label className={`mt-4 block ${FIELD_LABEL}`} htmlFor="add-computer-name">
            Show it as
          </label>
          <input
            id="add-computer-name"
            aria-label="Show it as"
            value={name}
            disabled={adding}
            onChange={(event) => {
              typedName.current = true;
              setName(event.target.value);
            }}
            className={`${FIELD} mt-1.5`}
          />
        </>
      )}
      {preview && (
        <p className="mt-3 text-12 text-ink-3">
          This window gets full control of {preview.name}'s Projects, like its own window. Remove it any time from {preview.name}'s Settings › Devices.
        </p>
      )}
      <InlineError size={12} data-add-computer-error className="mt-3">
        {error}
      </InlineError>
    </Dialog>
  );
}
