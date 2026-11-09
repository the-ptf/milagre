import { useId, useMemo, useState } from "react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CircleIcon,
  FrameIcon,
  Image01Icon,
  Layers01Icon,
  SquareIcon,
  StarIcon,
  TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { DesignDocument, DesignNode } from "@milagre/shared/design";
import { ScrollArea } from "../primitives/ScrollArea";
import { IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { SectionLabel } from "../primitives/SectionLabel";

const tools = [
  { type: "frame", label: "Add frame", icon: FrameIcon },
  { type: "rectangle", label: "Add rectangle", icon: SquareIcon },
  { type: "ellipse", label: "Add ellipse", icon: CircleIcon },
  { type: "text", label: "Add text", icon: TextFontIcon },
  { type: "image", label: "Add image", icon: Image01Icon },
  { type: "icon", label: "Add icon", icon: StarIcon },
] as const;

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
        <IconButton
          label={`${collapsed.has(node.id) ? "Expand" : "Collapse"} ${node.name ?? node.id}`}
          icon={collapsed.has(node.id) ? ArrowRight01Icon : ArrowDown01Icon}
          size={20}
          aria-expanded={!collapsed.has(node.id)}
          onClick={() =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(node.id)) next.delete(node.id);
              else next.add(node.id);
              return next;
            })
          }
        />
      ) : (
        <span className="w-5 shrink-0" />
      )}
      <button
        type="button"
        data-node-id={node.id}
        aria-label={`Select ${node.name ?? node.id}`}
        aria-pressed={selectedIds.includes(node.id)}
        onClick={(event) => onSelect(node.id, event.shiftKey || event.metaKey || event.ctrlKey)}
        className={`my-0.5 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left text-12 transition-colors ${selectedIds.includes(node.id) ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
      >
        <span aria-hidden className="w-3 shrink-0 text-center text-10">
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
                    : node.type === "icon"
                      ? "✦"
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
        className="absolute left-4 top-4 z-10 flex flex-col gap-1 rounded-card bg-surface p-1 shadow-raised"
      >
        <IconButton
          label="Layers"
          icon={Layers01Icon}
          size={32}
          aria-expanded={open}
          aria-controls={panelId}
          data-slot="design-layers-toggle"
          onClick={onToggle}
        />
        <div className="mx-1 my-0.5 border-t border-line" />
        {tools.map((tool) => (
          <IconButton key={tool.type} label={tool.label} icon={tool.icon} size={32} disabled={saving} onClick={() => onAdd(tool.type)} />
        ))}
      </div>
      {open && (
        <aside
          id={panelId}
          aria-label="Layers"
          data-slot="design-layers-panel"
          className="absolute left-[72px] top-4 z-10 flex max-h-[calc(100%_-_2rem)] w-56 flex-col overflow-hidden rounded-card bg-surface shadow-raised"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <span className="flex-1 text-12 font-medium">
              Layers <span className="ml-1 font-normal text-ink-3">{layerCount}</span>
            </span>
            <IconButton label="Close Layers" icon={Cancel01Icon} size={24} onClick={onClose} />
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
                      className={`my-0.5 flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-12 transition-colors ${design.id === activeId ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
                      onClick={() => {
                        onActivate(design.id);
                        requestAnimationFrame(() =>
                          window.document
                            .querySelector<HTMLButtonElement>(`[data-slot="design-layer-root"][data-design-id="${CSS.escape(design.id)}"]`)
                            ?.focus(),
                        );
                      }}
                    >
                      <Icon icon={design.id === activeId ? ArrowDown01Icon : ArrowRight01Icon} className="shrink-0 text-ink-3" size={12} />
                      <Icon icon={FrameIcon} className="shrink-0 text-ink-3" size={14} />
                      <span className="min-w-0 flex-1 truncate font-medium">{design.title}</span>
                      <span className="shrink-0 text-11 text-ink-3">{design.document.nodes.length}</span>
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
              <SectionLabel as="div" variant="menu" className="px-3 pt-3">
                Components
              </SectionLabel>
              <ScrollArea className="max-h-40 p-2" aria-label="Reusable components">
                {components.map((component) => (
                  <button
                    key={component.id}
                    type="button"
                    aria-label={`Insert ${component.name ?? component.id} instance`}
                    className="mb-1 h-7 w-full truncate rounded-control px-2 text-left text-12 text-ink-2 transition-colors enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-40"
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
