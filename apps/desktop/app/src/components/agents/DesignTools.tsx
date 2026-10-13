import { useId, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CircleIcon,
  FrameIcon,
  Image01Icon,
  Layers01Icon,
  SquareIcon,
  TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { DesignDocument, DesignNode } from "@milagre/shared/design";
import Tooltip from "../primitives/Tooltip";
import { ScrollArea } from "../primitives/ScrollArea";

const tools = [
  { type: "frame", label: "Add frame", icon: FrameIcon },
  { type: "rectangle", label: "Add rectangle", icon: SquareIcon },
  { type: "ellipse", label: "Add ellipse", icon: CircleIcon },
  { type: "text", label: "Add text", icon: TextFontIcon },
  { type: "image", label: "Add image", icon: Image01Icon },
] as const;
const iconButton =
  "flex size-9 items-center justify-center rounded-control text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

/** The layer panel is a persistent, optional workspace panel, so inspecting a layer does not dismiss it. */
export function DesignTools({
  document,
  designs,
  activeId,
  onActivate,
  selectedIds,
  saving,
  open,
  onToggle,
  onClose,
  onSelect,
  onAdd,
  onInsertInstance,
}: {
  document: DesignDocument;
  designs: { id: string; title: string; document: DesignDocument }[];
  activeId: string;
  onActivate: (id: string) => void;
  selectedIds: string[];
  saving: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (id: string, additive: boolean) => void;
  onAdd: (type: DesignNode["type"]) => void;
  onInsertInstance: (node: DesignNode) => void;
}) {
  const panelId = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const { rows, components } = useMemo(() => {
    const children = new Map<string | undefined, DesignNode[]>();
    for (const node of document.nodes) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const visibleRows: { node: DesignNode; depth: number; hasChildren: boolean }[] = [];
    const visit = (node: DesignNode, depth: number) => {
      const nested = children.get(node.id) ?? [];
      visibleRows.push({ node, depth, hasChildren: nested.length > 0 });
      if (!collapsed.has(node.id)) for (const child of nested) visit(child, depth + 1);
    };
    for (const node of children.get(undefined) ?? []) visit(node, 0);
    return { rows: visibleRows, components: document.nodes.filter((node) => node.component) };
  }, [document.nodes, collapsed]);
  const layerCount = designs.reduce((total, design) => total + design.document.nodes.length, 0);
  const layerRows = rows.map(({ node, depth, hasChildren }) => (
    <li key={node.id} className="flex items-center gap-0.5" style={{ paddingLeft: Math.min(depth, 8) * 12 }}>
      {hasChildren ? (
        <button
          type="button"
          aria-label={`${collapsed.has(node.id) ? "Expand" : "Collapse"} ${node.name ?? node.id}`}
          aria-expanded={!collapsed.has(node.id)}
          className="flex size-5 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-hover"
          onClick={() =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(node.id)) next.delete(node.id);
              else next.add(node.id);
              return next;
            })
          }
        >
          <HugeiconsIcon icon={collapsed.has(node.id) ? ArrowRight01Icon : ArrowDown01Icon} size={12} aria-hidden />
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}
      <button
        type="button"
        data-node-id={node.id}
        aria-label={`Select ${node.name ?? node.id}`}
        aria-pressed={selectedIds.includes(node.id)}
        onClick={(event) => onSelect(node.id, event.shiftKey || event.metaKey || event.ctrlKey)}
        className={`my-0.5 flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1.5 text-left text-[12px] ${selectedIds.includes(node.id) ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-hover"}`}
      >
        <span aria-hidden className="w-3 shrink-0 text-center text-[10px]">
          {node.component
            ? "◆"
            : node.componentId
              ? "◇"
              : node.type === "text"
                ? "T"
                : node.type === "frame"
                  ? "#"
                  : node.type === "image"
                    ? "▧"
                    : node.type === "ellipse"
                      ? "○"
                      : "□"}
        </span>
        <span className={`min-w-0 truncate ${node.hidden ? "opacity-50" : ""}`}>{node.name ?? node.id}</span>
      </button>
    </li>
  ));
  return (
    <>
      <div
        role="toolbar"
        aria-label="Design tools"
        aria-orientation="vertical"
        data-slot="design-tool-rail"
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
        className="absolute left-4 top-4 z-10 flex flex-col gap-1 rounded-xl border border-line bg-surface p-1 shadow-overlay"
      >
        <Tooltip label="Layers">
          <button
            type="button"
            aria-label="Layers"
            aria-expanded={open}
            aria-controls={panelId}
            data-slot="design-layers-toggle"
            className={`${iconButton} ${open ? "bg-accent/10 text-accent" : ""}`}
            onClick={onToggle}
          >
            <HugeiconsIcon icon={Layers01Icon} size={18} strokeWidth={1.7} aria-hidden />
          </button>
        </Tooltip>
        <div className="mx-1 my-0.5 border-t border-line" />
        {tools.map((tool) => (
          <Tooltip key={tool.type} label={tool.label}>
            <button type="button" aria-label={tool.label} className={iconButton} disabled={saving} onClick={() => onAdd(tool.type)}>
              <HugeiconsIcon icon={tool.icon} size={18} strokeWidth={1.7} aria-hidden />
            </button>
          </Tooltip>
        ))}
      </div>
      {open && (
        <aside
          id={panelId}
          aria-label="Layers"
          data-slot="design-layers-panel"
          className="absolute left-[72px] top-4 z-10 flex max-h-[calc(100%_-_2rem)] w-56 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-overlay"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <span className="flex-1 text-[12px] font-medium">
              Layers <span className="ml-1 font-normal text-ink-3">{layerCount}</span>
            </span>
            <Tooltip label="Close Layers">
              <button
                type="button"
                aria-label="Close Layers"
                className="flex size-6 items-center justify-center rounded-control text-ink-3 hover:bg-hover hover:text-ink"
                onClick={onClose}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
              </button>
            </Tooltip>
          </header>
          <ScrollArea as="ul" className="min-h-0 flex-1 p-1" aria-label="Design layers">
            {designs.length <= 1
              ? layerRows
              : designs.map((design) => (
                  <li key={design.id}>
                    <button
                      type="button"
                      data-slot="design-layer-root"
                      data-design-id={design.id}
                      aria-label={`Show layers for ${design.title}`}
                      aria-expanded={design.id === activeId}
                      aria-pressed={design.id === activeId}
                      className={`my-0.5 flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-[12px] ${design.id === activeId ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"}`}
                      onClick={() => {
                        onActivate(design.id);
                        requestAnimationFrame(() =>
                          window.document
                            .querySelector<HTMLButtonElement>(`[data-slot="design-layer-root"][data-design-id="${CSS.escape(design.id)}"]`)
                            ?.focus(),
                        );
                      }}
                    >
                      <HugeiconsIcon icon={design.id === activeId ? ArrowDown01Icon : ArrowRight01Icon} className="shrink-0 text-ink-3" size={12} aria-hidden />
                      <HugeiconsIcon icon={FrameIcon} className="shrink-0 text-ink-3" size={14} aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-medium">{design.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-3">{design.document.nodes.length}</span>
                    </button>
                    {design.id === activeId && (
                      <ul aria-label={`${design.title} layers`} className="ml-2 border-l border-line pl-1">
                        {layerRows}
                      </ul>
                    )}
                  </li>
                ))}
          </ScrollArea>
          {components.length > 0 && (
            <div className="shrink-0 border-t border-line">
              <div className="px-3 pt-3 text-[11px] font-medium text-ink-3">Components</div>
              <ScrollArea className="max-h-40 p-2" aria-label="Reusable components">
                {components.map((component) => (
                  <button
                    key={component.id}
                    type="button"
                    aria-label={`Insert ${component.name ?? component.id} instance`}
                    className="mb-1 w-full truncate rounded-control px-2 py-1.5 text-left text-[12px] text-ink-2 hover:bg-hover disabled:opacity-40"
                    disabled={saving}
                    onClick={() => onInsertInstance(component)}
                  >
                    ◇ {component.name ?? component.id}
                  </button>
                ))}
              </ScrollArea>
            </div>
          )}
        </aside>
      )}
    </>
  );
}
