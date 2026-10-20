import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BACKGROUND_ITEM_LABELS, plainTaskOutput, type BackgroundItem } from "@milagre/shared/chat-activity";
import { useTaskOutput } from "@milagre/shared/use-task-output";
import { bridgeForKey } from "../../lib/computer-bridge";
import { BackgroundIndicator } from "../ThinkingIndicator";
import { ScrollArea } from "../primitives/ScrollArea";
import { SubagentDetail } from "./SubagentTrack";

function CommandOutput({ chatKey, taskId, running }: { chatKey: string; taskId: string; running: boolean }) {
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const read = useCallback(() => bridgeForKey(chatKey).readTaskOutput(chatKey, taskId), [chatKey, taskId]);
  const { output, error } = useTaskOutput(read, visible, running);
  return (
    <div className="flex flex-col gap-2 p-2 text-[12px] text-ink-2">
      {error && (
        <p role="alert" className="text-red">
          {error}
        </p>
      )}
      {output?.truncated && <p className="text-ink-3">Showing the latest output.</p>}
      <pre data-task-output className="whitespace-pre-wrap break-words font-mono text-[12px] select-text">
        {output ? plainTaskOutput(output.output) || "No output yet." : error ? "" : "Loading output..."}
      </pre>
    </div>
  );
}

/** The background line opens the work it counts, including commands that have no subagent pill. */
export function BackgroundWork({
  items,
  chatKey,
  mark,
  showIndicator,
}: {
  items: BackgroundItem[];
  chatKey?: string | null;
  mark: ReactNode;
  showIndicator: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<BackgroundItem | null>(null);
  const current = items.find((item) => item.type === selected?.type && item.id === selected.id);
  const child = current ?? (selected?.type === "command" ? selected : undefined);
  // The line hides when all that is left serves a port: the Ports pill shows it.
  const indicator = showIndicator && items.length > 0;
  if (!indicator && !(open && child)) return null;
  return (
    <div className="w-full min-w-0">
      {indicator && <BackgroundIndicator count={items.length} startedAt={items[0]?.startedAt} mark={mark} expanded={open} onClick={() => setOpen(!open)} />}
      {open && (
        <div data-background-tasks className="mt-1 ml-3 flex max-h-[360px] min-h-0 flex-col rounded-control border border-line bg-surface text-ink-2">
          {child ? (
            <>
              <header className="flex shrink-0 items-center gap-2 border-b border-line p-2 text-[12px]">
                <button type="button" onClick={() => setSelected(null)} className="rounded px-1 py-0.5 hover:bg-hover">
                  Back to tasks
                </button>
                <span className="min-w-0 flex-1 truncate font-medium">{child.title}</span>
                {!current && <span>No longer running</span>}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setSelected(null);
                  }}
                  className="rounded px-1 py-0.5 hover:bg-hover"
                >
                  Close
                </button>
              </header>
              <ScrollArea chainScroll>
                {child.agent ? (
                  <SubagentDetail chatKey={chatKey} agent={child.agent} />
                ) : child.type === "command" && chatKey ? (
                  <CommandOutput key={`${chatKey}:${child.id}`} chatKey={chatKey} taskId={child.id} running={Boolean(current)} />
                ) : (
                  <p className="p-3 text-[12px]">This task reports its progress back to the Chat.</p>
                )}
              </ScrollArea>
            </>
          ) : (
            <ScrollArea as="ul" chainScroll className="p-1">
              {items.map((item) => (
                <li key={`${item.type}:${item.id}`}>
                  <button
                    type="button"
                    data-background-task={item.id}
                    onClick={() => setSelected(item)}
                    className="flex w-full flex-col gap-1 rounded-control px-2 py-2 text-left text-[12.5px] hover:bg-hover"
                  >
                    <span className="break-words">{item.title}</span>
                    <span className="text-[11px] text-ink-3">{BACKGROUND_ITEM_LABELS[item.type]} · Running</span>
                  </button>
                </li>
              ))}
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  );
}
