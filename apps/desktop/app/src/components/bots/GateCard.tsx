import { ShieldAlertIcon } from "@hugeicons/core-free-icons";
import type { GateMeta, GateRecord } from "@milagre/shared/bots";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import Tooltip from "../primitives/Tooltip";

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
      className={`w-full max-w-xl rounded-card border px-4 py-3 ${open ? "border-transparent bg-orange-tint" : "border-line bg-surface"}`}
    >
      <div className="flex items-center gap-1.5 text-12">
        <span className={`flex items-center gap-1.5 font-medium ${open ? "text-orange-ink" : "text-ink-3"}`}>
          <Icon icon={ShieldAlertIcon} size={14} />
          Needs your sign-off
        </span>
        <span data-gate-expiry className="ml-auto tabular-nums text-ink-3">
          {status === "expired" ? "Expired" : open ? `Expires ${clock(gate.expiresAt)}` : null}
        </span>
      </div>
      <h3 className="mt-1.5 text-15 font-semibold text-ink">{gate.title}</h3>
      <Tooltip label={gate.command} side="bottom" wrap asChild>
        <p data-gate-command className="mt-1 truncate font-mono text-12 text-ink-3">
          {gate.command}
        </p>
      </Tooltip>
      {open && onAnswer && (
        <div className="mt-3 flex items-center gap-2">
          <Button disabled={answering !== null} onClick={() => onAnswer("once")}>
            Allow once
          </Button>
          <Button variant="secondary" disabled={answering !== null} onClick={() => onAnswer("always")}>
            Always for {botName}
          </Button>
          <Button variant="danger-ghost" disabled={answering !== null} onClick={() => onAnswer("deny")}>
            Deny
          </Button>
        </div>
      )}
    </section>
  );
}
