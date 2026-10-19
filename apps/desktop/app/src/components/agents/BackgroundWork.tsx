import { useCallback, useState, type ReactNode } from "react";
import { BACKGROUND_ITEM_LABELS, plainTaskOutput, type BackgroundItem } from "@milagre/shared/chat-activity";
import { useTaskOutput } from "@milagre/shared/use-task-output";
import { bridgeForKey } from "../../lib/computer-bridge";
import { BackgroundIndicator } from "../ThinkingIndicator";
import { ScrollArea } from "../primitives/ScrollArea";
import { SubagentDetail } from "./SubagentTrack";

function CommandOutput({ chatKey, taskId }: { chatKey: string; taskId: string }) {
  const read = useCallback(() => bridgeForKey(chatKey).readTaskOutput(chatKey, taskId), [chatKey, taskId]);
  const { output, error } = useTaskOutput(read);
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
export function BackgroundWork({ items, chatKey, mark }: { items: BackgroundItem[]; chatKey?: string | null; mark: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const child = items.find((item) => `${item.type}:${item.id}` === selected);
  return (
    <div className="min-w-0">
      <BackgroundIndicator count={items.length} startedAt={items[0]?.startedAt} mark={mark} expanded={open} onClick={() => setOpen(!open)} />
      {open && (
        <div data-background-tasks className="mt-1 ml-3 flex max-h-[360px] min-h-0 flex-col rounded-control border border-line bg-surface text-ink-2">
          {child ? (
            <>
              <header className="flex shrink-0 items-center gap-2 border-b border-line p-2 text-[12px]">
                <button type="button" onClick={() => setSelected(null)} className="rounded px-1 py-0.5 hover:bg-hover">
                  Back to tasks
                </button>
                <span className="min-w-0 truncate font-medium">{child.title}</span>
              </header>
              <ScrollArea chainScroll>
                {child.agent ? (
                  <SubagentDetail chatKey={chatKey} agent={child.agent} />
                ) : child.type === "command" && chatKey ? (
                  <CommandOutput key={`${chatKey}:${child.id}`} chatKey={chatKey} taskId={child.id} />
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
                    onClick={() => setSelected(`${item.type}:${item.id}`)}
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
