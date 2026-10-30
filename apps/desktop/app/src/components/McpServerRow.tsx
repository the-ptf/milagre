import { useState } from "react";
import { Alert02Icon, ArrowDown01Icon, ArrowUp01Icon, CommandLineIcon, FolderGitIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { mcpChipLine, mcpSummary, mcpTransportLine, type McpChip, type McpRow } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { Switch } from "./primitives/Switch";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";

const keyOf = (chip: Pick<McpChip, "provider" | "accountId">) => `${chip.provider}:${chip.accountId}`;

/** The name without the group it already sits under: "notion" for plugin:engineering:notion, "Gmail" for claude.ai Gmail. */
const shortName = (row: McpRow) => (row.source ? row.name.replace(/^plugin:[^:]+:/, "").replace(/^claude\.ai /, "") : row.name);
/** "Claude · personal", or just "Antigravity" when the account has no name of its own. */
const accountName = (chip: McpChip) =>
  chip.label && chip.label !== providerName(chip.provider) ? `${providerName(chip.provider)} · ${chip.label}` : providerName(chip.provider);

function Tile({ row, warn = false }: { row: McpRow; warn?: boolean }) {
  const icon = row.transport === "command" ? CommandLineIcon : Globe02Icon;
  return (
    <span className={`flex size-8 shrink-0 items-center justify-center rounded-control ${warn ? "bg-orange-tint text-orange-ink" : "bg-hover text-ink-2"}`}>
      <Icon icon={icon} size={16} />
    </span>
  );
}

function Failed() {
  return (
    <span data-mcp-failed className="flex shrink-0 text-red-ink">
      <Icon icon={Alert02Icon} size={14} />
    </span>
  );
}

/** A row that needs sign-in: Sign in, or Cancel while the browser is open. Compact inside a group. */
export function McpSignInRow({
  row,
  signingIn,
  remote,
  onSignIn,
  onCancel,
  compact = false,
}: {
  row: McpRow;
  signingIn: boolean;
  remote: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  return (
    <div data-mcp-attention={row.name} className={`flex items-center gap-3 ${compact ? "min-h-12 px-3 py-2" : "min-h-15 px-4 py-3"}`}>
      {!compact && <Tile row={row} warn />}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-13 font-semibold text-ink">{shortName(row)}</span>
        <span className="truncate text-12 text-ink-3">{signingIn ? "Finish in your browser, then come back." : mcpTransportLine(row)}</span>
      </div>
      {remote ? (
        <span className="text-12 text-ink-3">On the Mac</span>
      ) : signingIn ? (
        <Button variant="secondary" data-mcp-cancel={row.name} onClick={onCancel}>
          Cancel
        </Button>
      ) : (
        <Button data-mcp-sign-in={row.name} onClick={onSignIn}>
          Sign in
        </Button>
      )}
    </div>
  );
}

function AccountLines({ row, onSwitch }: { row: McpRow; onSwitch: (chip: McpChip, on: boolean) => void }) {
  return row.chips.map((chip) => (
    <div key={keyOf(chip)} className="flex min-h-10 items-center gap-3">
      <span className="w-64 shrink-0 truncate text-13 text-ink">{accountName(chip)}</span>
      <span className={`min-w-0 flex-1 truncate text-12 ${chip.state === "failed" ? "text-red-ink" : "text-ink-3"}`}>{mcpChipLine(chip)}</span>
      <span data-mcp-switch={`${keyOf(chip)}:${row.name}`} className="flex">
        <Switch
          label={`${row.name} for ${accountName(chip)}`}
          checked={chip.state !== "disabled"}
          disabled={chip.disabledBy === "provider"}
          onChange={(on) => onSwitch(chip, on)}
        />
      </span>
    </div>
  ));
}

/** A server row; open, it lists each account with a switch, then Edit and Remove when editable. Remove asks first,
 * in place, naming where it removes from (`removePlaces`). */
export function McpServerRow({
  row,
  open,
  onToggleOpen,
  onSwitch,
  onEdit,
  onRemove,
  removePlaces = "",
}: {
  row: McpRow;
  open: boolean;
  onToggleOpen: () => void;
  onSwitch: (chip: McpChip, on: boolean) => void;
  onEdit?: () => void;
  onRemove?: () => void;
  removePlaces?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const failed = row.chips.find((chip) => chip.state === "failed");
  const subtitle = failed ? `${providerName(failed.provider)}: ${failed.error ?? "Failed"}` : mcpTransportLine(row);
  return (
    <div data-mcp-row={row.name} data-open={open}>
      <button type="button" aria-expanded={open} onClick={onToggleOpen} className="flex min-h-15 w-full items-center gap-3 px-4 py-3 text-left">
        <Tile row={row} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-13 font-semibold text-ink">{row.name}</span>
          <span className={`truncate text-12 ${failed ? "text-red-ink" : "text-ink-3"}`}>{subtitle}</span>
        </span>
        {row.everywhere && <span className="rounded-chip bg-field px-2 py-0.5 text-11 font-medium text-ink-2">Everywhere</span>}
        <span className="flex items-center gap-1.5 text-12 text-ink-3">
          {failed && <Failed />}
          {mcpSummary(row)}
        </span>
        <Icon icon={open ? ArrowUp01Icon : ArrowDown01Icon} size={16} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div className="px-4 pt-1 pb-3">
          <AccountLines row={row} onSwitch={onSwitch} />
          {confirming && onRemove ? (
            <div data-mcp-remove-question className="mt-1 flex min-h-11 items-center gap-2">
              <span className="min-w-0 flex-1 text-12 text-ink">
                Remove {row.name} from {removePlaces}? Chats stop loading it.
              </span>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                data-mcp-remove-confirm
                onClick={() => {
                  setConfirming(false);
                  onRemove();
                }}
              >
                Remove
              </Button>
            </div>
          ) : (
            (onEdit || onRemove) && (
              <div className="mt-1 flex min-h-11 items-center gap-2">
                <span className="min-w-0 flex-1 text-12 text-ink-3">{row.everywhere ? "Everywhere adds it to providers whose config lacks it." : ""}</span>
                {onEdit && (
                  <Button variant="secondary" data-mcp-edit onClick={onEdit}>
                    Edit
                  </Button>
                )}
                {/* The first step is quiet red text; the confirm is the red-filled danger Button. */}
                {onRemove && (
                  <Button variant="danger-ghost" data-mcp-remove onClick={() => setConfirming(true)}>
                    Remove
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** A row set up outside Milagre. One account: its line and switch sit on the row. Several: it opens like a server row. */
export function McpOutsideRow({
  row,
  open,
  onToggleOpen,
  onSwitch,
}: {
  row: McpRow;
  open: boolean;
  onToggleOpen: () => void;
  onSwitch: (chip: McpChip, on: boolean) => void;
}) {
  const [only] = row.chips;
  const failed = row.chips.some((chip) => chip.state === "failed");
  const name = (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="truncate text-13 font-semibold text-ink">{shortName(row)}</span>
      <span className="truncate text-12 text-ink-3">{mcpTransportLine(row)}</span>
    </span>
  );
  if (only && row.chips.length === 1) {
    const line = only.state === "connected" ? `${providerName(only.provider)} · ${only.tools} tools` : mcpChipLine(only);
    return (
      <div data-mcp-row={row.name} data-open={false} className="flex min-h-12 items-center gap-3 px-3 py-2">
        {name}
        <span className={`flex min-w-0 items-center gap-1.5 truncate text-12 ${failed ? "text-red-ink" : "text-ink-3"}`}>
          {failed && <Failed />}
          {line}
        </span>
        <span data-mcp-switch={`${keyOf(only)}:${row.name}`} className="flex">
          <Switch
            label={`${row.name} for ${accountName(only)}`}
            checked={only.state !== "disabled"}
            disabled={only.disabledBy === "provider"}
            onChange={(on) => onSwitch(only, on)}
          />
        </span>
      </div>
    );
  }
  return (
    <div data-mcp-row={row.name} data-open={open}>
      <button type="button" aria-expanded={open} onClick={onToggleOpen} className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left">
        {name}
        <span className="flex items-center gap-1.5 text-12 text-ink-3">
          {failed && <Failed />}
          {mcpSummary(row)}
        </span>
        <Icon icon={open ? ArrowUp01Icon : ArrowDown01Icon} size={16} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div className="px-3 pb-2">
          <AccountLines row={row} onSwitch={onSwitch} />
        </div>
      )}
    </div>
  );
}

export function McpOtherHeader({ open, count, attention, onToggle }: { open: boolean; count: number; attention: number; onToggle: () => void }) {
  return (
    <button type="button" data-mcp-other aria-expanded={open} onClick={onToggle} className="flex min-h-13 w-full items-center gap-3 px-4 text-left">
      <Icon icon={FolderGitIcon} size={16} className="shrink-0 text-ink-2" />
      <span className="flex-1 text-13 font-medium text-ink">From Projects, plugins and claude.ai</span>
      <span className="text-12 text-ink-3">{attention ? `${count} · ${attention} needs sign-in` : count}</span>
      <Icon icon={open ? ArrowUp01Icon : ArrowDown01Icon} size={16} className="shrink-0 text-ink-3" />
    </button>
  );
}
