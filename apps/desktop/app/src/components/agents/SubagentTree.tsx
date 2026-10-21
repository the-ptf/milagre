import { type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { motion } from "motion/react";
import { flattenSubagentTree, type SubagentNode, type SubagentTree as Tree } from "@milagre/shared/subagent-tree";
import { useMotionScale } from "../../lib/ease";
import { ProviderLogo } from "../ProviderLogo";
import type { ModelProvider } from "../../model";

/** Root siblings share columns; deeper descendants remain an outline inside their branch. */
export function SubagentTree({
  tree,
  arriving,
  collapsed,
  rootCollapsed,
  onToggleRoot,
  onToggle,
  provider,
  model,
  activity,
  plan,
  renderCard,
}: {
  tree: Tree;
  arriving: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  rootCollapsed: boolean;
  onToggleRoot: () => void;
  onToggle: (id: string) => void;
  provider: ModelProvider;
  model?: string;
  activity?: string;
  plan?: string;
  renderCard: (node: SubagentNode) => ReactNode;
}) {
  const scale = useMotionScale();
  const flat = flattenSubagentTree(tree, collapsed);
  const branches: { node: SubagentNode; depth: number }[][] = [];
  for (const row of flat) {
    if (row.depth === 0) branches.push([]);
    branches.at(-1)!.push(row);
  }
  return (
    <div data-subagent-tree className="min-w-0 px-2 pt-1 pb-3">
      <button
        type="button"
        aria-label={`${rootCollapsed ? "Expand" : "Collapse"} Chat agent branch`}
        aria-expanded={!rootCollapsed}
        onClick={onToggleRoot}
        className="mx-auto flex w-full max-w-80 items-center gap-2 rounded-lg border border-line-strong bg-hover p-3 text-left focus-visible:outline-2"
      >
        <ProviderLogo provider={provider} size={18} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[13px] font-medium">
            Chat agent <span className="font-normal text-ink-3 capitalize">{activity}</span>
          </span>
          {model && <span className="truncate text-[11px] text-ink-3">{model}</span>}
          {plan && <span className="line-clamp-2 text-[11px] text-ink-2">{plan}</span>}
          <span className="text-[11px] text-ink-3">{tree.counts.total} subagents</span>
        </span>
        <HugeiconsIcon icon={rootCollapsed ? ArrowRight01Icon : ArrowDown01Icon} size={14} aria-hidden />
      </button>
      {!rootCollapsed && branches.length > 0 && (
        <div className="pt-4 relative before:absolute before:top-0 before:left-1/2 before:h-4 before:border-l before:border-line">
          <div className="grid gap-x-3 border-t border-line" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))" }}>
            {branches.map((branch) => (
              <div
                key={branch[0]!.node.agent.id}
                className="relative min-w-0 pt-3 before:absolute before:top-0 before:left-1/2 before:h-3 before:border-l before:border-line"
              >
                {branch.map(({ node, depth }) => (
                  <motion.div
                    key={node.agent.id}
                    initial={{ opacity: scale && arriving.has(node.agent.id) ? 0 : 1 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.16 * scale }}
                    className={`relative mb-2 min-w-0 ${depth ? "border-l border-line pl-2" : ""}`}
                    style={{ marginLeft: Math.min(depth, 3) * 10 }}
                  >
                    {depth > 0 && <span aria-hidden className="absolute top-5 left-0 w-2 border-t border-line" />}
                    <div className="rounded-lg border border-line bg-surface p-2 focus-within:ring-1 focus-within:ring-line-strong">
                      {renderCard(node)}
                      {node.children.length > 0 && (
                        <button
                          type="button"
                          aria-expanded={!collapsed.has(node.agent.id)}
                          aria-label={`${collapsed.has(node.agent.id) ? "Expand" : "Collapse"} branch ${node.agent.title}`}
                          onClick={() => onToggle(node.agent.id)}
                          className="mt-2 flex w-full items-center gap-1 border-t border-line pt-2 text-left text-[11px] text-ink-3 hover:text-ink focus-visible:outline-2"
                        >
                          <HugeiconsIcon icon={collapsed.has(node.agent.id) ? ArrowRight01Icon : ArrowDown01Icon} size={12} aria-hidden />
                          {node.counts.total - 1} in branch{node.counts.failed ? ` · ${node.counts.failed} failed` : ""}
                          {node.counts.waiting ? ` · ${node.counts.waiting} waiting` : ""}
                        </button>
                      )}
                      {depth > 3 && <span className="text-[10px] text-ink-3">Depth {depth + 1}</span>}
                    </div>
                  </motion.div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
