import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useCopied } from "../../lib/use-copied";
import Tooltip from "./Tooltip";

export function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopied(text);
  return (
    <Tooltip label={copied ? "Copied" : "Copy"}>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy message"}
        onClick={copy}
        className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors focus-visible:outline-offset-[-2px] hover:bg-hover hover:text-ink"
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={15} strokeWidth={1.8} color="currentColor" />
      </button>
    </Tooltip>
  );
}
