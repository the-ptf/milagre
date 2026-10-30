import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert02Icon, ArrowDown01Icon, Cancel01Icon, SecurityCheckIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { SPRING_SWAP } from "../../lib/ease";
import { ScrollArea } from "../primitives/ScrollArea";
import { Icon } from "../primitives/Icon";
import { Button } from "../primitives/Button";
import { SectionLabel } from "../primitives/SectionLabel";
import { SpinnerRing } from "../primitives/SpinnerRing";

export type ToolApprovalStatus = "pending" | "approving" | "approved" | "denied" | "running" | "complete" | "error";

type ToolApprovalCodeLanguage = "text" | "bash" | "diff" | "json" | "tsx" | "typescript";

export interface ToolApprovalParameter {
  id: string;
  label: ReactNode;
  value: ReactNode;
}

export interface ToolApprovalCodeProps {
  code: string;
  language?: ToolApprovalCodeLanguage;
  className?: string;
  plain?: boolean;
}

export interface ToolApprovalProps {
  variant?: "card" | "inline";
  tool: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  parameters?: ToolApprovalParameter[];
  status?: ToolApprovalStatus;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onApprove?: () => void;
  onAlwaysAllow?: () => void;
  /** Label for the always-allow button. */
  alwaysAllowLabel?: ReactNode;
  approveLabel?: ReactNode;
  denyLabel?: ReactNode;
  onDeny?: () => void;
  className?: string;
}

const NO_PARAMETERS: ToolApprovalParameter[] = [];

const STATUS_COPY: Record<ToolApprovalStatus, string> = {
  pending: "Approval required",
  approving: "Approving",
  approved: "Approved",
  denied: "Denied",
  running: "Running",
  complete: "Completed",
  error: "Failed",
};

function statusTone(status: ToolApprovalStatus) {
  if (status === "error" || status === "denied") return "border-red/30 bg-red-tint text-red-ink";
  if (status === "approved" || status === "complete") return "border-green/30 bg-green-tint text-green-ink";
  if (status === "approving" || status === "running") return "border-accent/30 bg-accent-tint text-accent-ink";
  return "border-orange/30 bg-orange-tint text-orange-ink";
}

function StatusIcon({ status }: { status: ToolApprovalStatus }) {
  if (status === "error") return <Icon icon={Alert02Icon} size={14} />;
  if (status === "denied") return <Icon icon={Cancel01Icon} size={14} />;
  if (status === "approved" || status === "complete") return <Icon icon={Tick02Icon} size={14} />;
  if (status === "approving" || status === "running") {
    return <SpinnerRing size={14} stroke={1.8} color="currentColor" />;
  }
  return <Icon icon={SecurityCheckIcon} size={14} />;
}

export function ToolApprovalCode({ code, language = "bash", className = "", plain = false }: ToolApprovalCodeProps) {
  if (plain)
    return (
      <pre className={`min-w-0 whitespace-pre-wrap break-words text-12 leading-5 text-ink-2 ${className}`}>
        <code>{code}</code>
      </pre>
    );
  return (
    <div className={`min-w-0 overflow-hidden rounded-control border border-line bg-inset ${className}`}>
      <SectionLabel as="div" variant="menu" className="border-b border-line px-3 py-1">
        {language}
      </SectionLabel>
      <pre className="max-h-44 overflow-auto px-3 py-2 text-11 leading-5 text-ink-2">
        <code className="whitespace-pre-wrap break-words">{code}</code>
      </pre>
    </div>
  );
}

export function ToolApproval({
  variant = "card",
  tool,
  title = "Allow this tool to run?",
  description,
  parameters = NO_PARAMETERS,
  status = "pending",
  open,
  defaultOpen = false,
  onOpenChange,
  onApprove,
  onAlwaysAllow,
  alwaysAllowLabel = "Always allow",
  approveLabel = "Allow once",
  denyLabel = "Deny",
  onDeny,
  className = "",
}: ToolApprovalProps) {
  const reduce = useReducedMotion();
  const inline = variant === "inline";
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const detailsOpen = open ?? internalOpen;
  const isPending = status === "pending";
  const isBusy = status === "approving" || status === "running";

  useEffect(() => {
    if (!isPending && detailsOpen) {
      setInternalOpen(false);
      onOpenChange?.(false);
    }
  }, [detailsOpen, isPending, onOpenChange]);

  function setDetailsOpen(next: boolean) {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }

  return (
    <motion.section
      role={inline ? "group" : "dialog"}
      aria-label="Tool approval"
      aria-busy={isBusy}
      initial={reduce || inline ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, y: 6, scale: 0.985 }}
      transition={reduce ? { duration: 0 } : SPRING_SWAP}
      className={`${inline ? "flex w-full flex-col gap-4" : "flex max-h-[min(72vh,620px)] w-full flex-col overflow-hidden rounded-card bg-surface shadow-overlay"} ${className}`}
    >
      <div className={`flex items-start gap-3 ${inline ? "" : "p-4"}`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-11 font-medium text-ink-3">{tool}</p>
              <h2 className={`mt-0.5 ${inline ? "text-13" : "text-15"} font-semibold text-ink`}>{title}</h2>
            </div>
            {!inline && (
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-chip border px-2 py-1 text-10 font-semibold ${statusTone(status)}`}>
                <StatusIcon status={status} />
                {STATUS_COPY[status]}
              </span>
            )}
          </div>
          {description && <p className="mt-2 text-12 leading-5 text-ink-2">{description}</p>}
          {inline && isBusy && (
            <p role="status" className="mt-2 text-12 text-ink-3">
              Sending decision…
            </p>
          )}
        </div>
      </div>

      {inline && parameters.length > 0 && (
        <div className="grid gap-3">
          {parameters.map((parameter) => (
            <div key={parameter.id} className="grid gap-1 text-12">
              <span className="font-medium text-ink-3">{parameter.label}</span>
              <div className="min-w-0 break-words text-ink-2">{parameter.value}</div>
            </div>
          ))}
        </div>
      )}
      {!inline && parameters.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(!detailsOpen)}
            className="flex h-9 w-full items-center justify-between gap-3 px-4 text-left text-12 font-medium text-ink-2 transition-colors duration-fast hover:bg-hover"
          >
            <span>{detailsOpen ? "Hide details" : "View details"}</span>
            <motion.span animate={{ rotate: detailsOpen ? 180 : 0 }} transition={reduce ? { duration: 0 } : SPRING_SWAP}>
              <Icon icon={ArrowDown01Icon} size={14} />
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {detailsOpen && (
              <motion.div
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduce ? undefined : { opacity: 0, height: 0 }}
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <ScrollArea className="[scrollbar-gutter:stable]">
                  <div className="grid gap-2 border-t border-line bg-inset px-4 py-3">
                    {parameters.map((parameter) => (
                      <div key={parameter.id} className="grid gap-1 text-12">
                        <span className="font-medium text-ink-3">{parameter.label}</span>
                        <div className="min-w-0 break-words text-ink-2">{parameter.value}</div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence initial={false}>
        {isPending && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 6 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className={inline ? "flex flex-wrap justify-end gap-2" : "flex flex-wrap justify-end gap-2 border-t border-line bg-inset px-4 py-3"}
          >
            <Button variant="secondary" onClick={onDeny} className="enabled:active:scale-press">
              {denyLabel}
            </Button>
            {onAlwaysAllow && (
              <Button variant="secondary" onClick={onAlwaysAllow} className="enabled:active:scale-press">
                {alwaysAllowLabel}
              </Button>
            )}
            <Button onClick={onApprove} className="enabled:active:scale-press">
              {approveLabel}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
