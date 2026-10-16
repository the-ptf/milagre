import { HugeiconsIcon } from "@hugeicons/react";
import { ShieldAlertIcon } from "@hugeicons/core-free-icons";
import type { GateMeta, GateRecord } from "@milagre/shared/bots";

export type GateChoice = "once" | "always" | "deny";

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * A bot's sign-off: the gated action, its exact command and when it expires. Allow once is the primary answer; an
 * expired one says so and can't be answered any more.
 */
export function GateCard({
  gate,
  status = "pending",
  botName,
  answering = null,
  onAnswer,
}: {
  gate: GateMeta;
  status?: GateRecord["status"];
  botName: string;
  /** The answer already sent, while the bot's session takes it. */
  answering?: GateChoice | null;
  onAnswer?: (choice: GateChoice) => void;
}) {
  const open = status === "pending";
  return (
    <section
      data-gate-card
      data-gate-status={status}
      aria-label="Needs your sign-off"
      className={`w-full max-w-xl rounded-[12px] border px-4 py-3 ${open ? "border-orange/30 bg-orange-tint" : "border-line bg-surface"}`}
    >
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className={`flex items-center gap-1.5 font-medium ${open ? "text-orange" : "text-ink-3"}`}>
          <HugeiconsIcon icon={ShieldAlertIcon} size={14} strokeWidth={1.8} color="currentColor" />
          Needs your sign-off
        </span>
        <span data-gate-expiry className="ml-auto tabular-nums text-ink-3">
          {status === "expired" ? "Expired" : open ? `Expires ${clock(gate.expiresAt)}` : null}
        </span>
      </div>
      <h3 className="mt-1.5 text-[15px] font-semibold text-ink">{gate.title}</h3>
      <p data-gate-command className="mt-1 truncate font-mono text-[12px] text-ink-3" title={gate.command}>
        {gate.command}
      </p>
      {open && onAnswer && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={answering !== null}
            onClick={() => onAnswer("once")}
            className="rounded-[8px] bg-ink px-3 py-1.5 text-[13px] font-medium text-surface transition-opacity hover:opacity-85 disabled:opacity-40"
          >
            Allow once
          </button>
          <button
            type="button"
            disabled={answering !== null}
            onClick={() => onAnswer("always")}
            className="rounded-[8px] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40"
          >
            Always for {botName}
          </button>
          <button
            type="button"
            disabled={answering !== null}
            onClick={() => onAnswer("deny")}
            className="rounded-[8px] px-3 py-1.5 text-[13px] font-medium text-red transition-colors hover:bg-red-tint disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      )}
    </section>
  );
}
