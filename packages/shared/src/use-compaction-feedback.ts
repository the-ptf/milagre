import { useEffect, useRef, useState } from "react";
import { compactionContext } from "./compaction.mjs";
import { formatTokens } from "./tokens.mjs";

/** A brief receipt for a compaction observed live. Opening an old Chat never replays it. */
export function useCompactionFeedback(message?: { id: number; context?: unknown }, scope?: string | number | null) {
  const context = compactionContext(message);
  const previous = useRef({ scope, id: message?.id, status: context?.status });
  const [receipt, setReceipt] = useState<{ scope: typeof scope; percent: number; freed: string } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { scope, id: message?.id, status: context?.status };
    if (before.scope !== scope) {
      setReceipt(null);
      return;
    }
    if (
      before.id !== message?.id ||
      before.status !== "preparing" ||
      context?.status !== "done" ||
      context.quiet ||
      context.after === undefined ||
      context.before === undefined ||
      !context.size
    )
      return;
    setReceipt({ scope, percent: Math.round((context.after / context.size) * 100), freed: formatTokens(Math.max(0, context.before - context.after)) });
  }, [scope, message?.id, context?.status, context?.after, context?.before, context?.size, context?.quiet]);
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => setReceipt(null), 4000);
    return () => clearTimeout(timer);
  }, [receipt]);
  return receipt?.scope === scope ? receipt : null;
}
