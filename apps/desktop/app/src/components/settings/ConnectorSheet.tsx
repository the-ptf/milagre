import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { CONNECTOR_CATEGORIES, EMAIL_PRESET, searchConnectorPresets, type ConnectorCategory, type ConnectorPreset } from "@milagre/shared/connectors";
import { Icon } from "../primitives/Icon";
import { ConnectorGallery } from "./ConnectorGallery";
import { ConnectorSetup, type SetupHandlers } from "./ConnectorSetup";

const NONE: ReadonlySet<string> = new Set();

type Step = { kind: "gallery" } | { kind: "setup"; preset: ConnectorPreset | null };

function Rail({
  category,
  onCategory,
  onCustom,
  custom,
}: {
  category: ConnectorCategory | null;
  onCategory: (category: ConnectorCategory | null) => void;
  onCustom: () => void;
  custom: boolean;
}) {
  const row = (on: boolean) =>
    `flex h-8 w-full items-center justify-between rounded-control px-2.5 text-left text-13 font-medium transition-colors ${on ? "bg-hover-2 text-ink" : "text-ink hover:bg-hover"}`;
  const entries: { id: ConnectorCategory | null; label: string; count: number }[] = [
    { id: null, label: "All", count: searchConnectorPresets("").length },
    ...CONNECTOR_CATEGORIES.map((item) => ({ ...item, count: searchConnectorPresets("", item.id).length })),
  ];
  return (
    <nav aria-label="Categories" className="flex w-46 shrink-0 flex-col gap-0.5 border-r border-line bg-page px-2.5 py-5">
      <h2 className="px-2.5 pb-3 text-17 font-semibold text-ink">Add connector</h2>
      {entries.map((entry) => (
        <button
          key={entry.id ?? "all"}
          type="button"
          data-connector-category={entry.id ?? "all"}
          aria-current={!custom && category === entry.id ? "true" : undefined}
          className={row(!custom && category === entry.id)}
          onClick={() => onCategory(entry.id)}
        >
          {entry.label}
          <span className="text-12 font-normal text-ink-3">{entry.count}</span>
        </button>
      ))}
      <div className="flex-1" />
      <button type="button" data-connector-custom className={`${row(custom)} h-12 justify-start gap-2.5`} onClick={onCustom}>
        <Icon icon={PlusSignIcon} size={16} className="text-ink-3" />
        <span>
          <span className="block">Custom</span>
          <span className="block text-11 font-normal text-ink-3">Any MCP server</span>
        </span>
      </button>
    </nav>
  );
}

/** Add connector: a category rail and a gallery of services; picking one shows its setup in place. */
export function ConnectorSheet({
  onAdd,
  onLinear,
  onEmail,
  email = false,
  added = NONE,
  onClose,
}: Omit<SetupHandlers, "onClose"> & {
  /** Opens straight on the Email form, from the Email drawer's Add mailbox. */
  email?: boolean;
  /** Preset ids already added on this computer, marked in the gallery. */
  added?: ReadonlySet<string>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>(email ? { kind: "setup", preset: EMAIL_PRESET } : { kind: "gallery" });
  const [category, setCategory] = useState<ConnectorCategory | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const title = step.kind === "gallery" ? "Add connector" : step.preset ? `Add ${step.preset.name}` : "Custom connector";
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => event.target === dialog.current && onClose()}
      className="m-auto h-[620px] max-h-[calc(100dvh-64px)] w-[860px] max-w-[calc(100vw-32px)] overflow-hidden rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <div data-connector-sheet className="flex h-full">
        <Rail
          category={category}
          custom={step.kind === "setup" && step.preset === null}
          onCategory={(next) => {
            setCategory(next);
            setStep({ kind: "gallery" });
          }}
          onCustom={() => setStep({ kind: "setup", preset: null })}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            aria-label="Close"
            className="absolute top-4 right-4 z-10 flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-hover"
            onClick={onClose}
          >
            <Icon icon={Cancel01Icon} size={16} />
          </button>
          {step.kind === "gallery" ? (
            <div className="flex min-h-0 flex-1 flex-col pt-1 pr-10">
              <ConnectorGallery
                query={query}
                onQuery={setQuery}
                category={category}
                added={added}
                onChoose={(preset) => setStep({ kind: "setup", preset })}
                onCustom={() => setStep({ kind: "setup", preset: null })}
              />
            </div>
          ) : (
            <ConnectorSetup
              key={step.preset?.id ?? "custom"}
              preset={step.preset}
              onBack={() => setStep({ kind: "gallery" })}
              handlers={{ onAdd, onLinear, onEmail, onClose }}
            />
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
