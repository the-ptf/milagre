import { useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpand01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { diagramLabel, resolveDiagramSvg } from "@milagre/shared/diagram";
import { MarkdownStreamingContext } from "../genui/GenerativeUI";
import { MediaLightbox } from "../motion/LazyMediaLightbox";
import { CodeBlock } from "./CodeBlock";

// Pele (pele.run) loads with the first diagram: a reply without one doesn't pay for it.
let pele: Promise<typeof import("pele")> | null = null;
const loadPele = () => (pele ??= import("pele"));

// The diagram in the chat's colours: its surfaces mixed from the ink over the block's background, so light and dark
// themes both read. Pele reads these on every redraw; a theme change repaints it without drawing it again.
const THEME = {
  "--pele-bg": "var(--inset)",
  "--pele-fg": "var(--ink)",
  "--pele-muted": "var(--ink-3)",
  "--pele-line": "var(--ink-2)",
  "--pele-surface": "color-mix(in srgb, var(--ink) 6%, var(--inset))",
  "--pele-surface-alt": "color-mix(in srgb, var(--ink) 11%, var(--inset))",
  "--pele-border": "color-mix(in srgb, var(--ink) 28%, var(--inset))",
  "--pele-accent": "var(--accent)",
  "--pele-font": "var(--font-sans)",
} as CSSProperties;

/** The theme as plain colours, for the SVG on its own (the lightbox's image sees no CSS). */
function plainTheme(element: HTMLElement) {
  const style = getComputedStyle(element);
  const probe = document.createElement("span");
  element.append(probe);
  const resolved = Object.fromEntries(
    Object.keys(THEME).map((name) => {
      probe.style.color = `var(${name})`;
      // A font list may quote its names; the SVG carries them inside double-quoted attributes.
      return [name, name === "--pele-font" ? style.getPropertyValue(name).trim().replace(/"/g, "'") : getComputedStyle(probe).color];
    }),
  );
  probe.remove();
  return resolved;
}

/**
 * A ```mermaid block in a reply, drawn by Pele: as wide as the reply, laid out again as it narrows (a wide flowchart
 * turns top-down), with its source a toggle away. The block being written stays code until its fence closes, and a
 * diagram that doesn't parse shows its code with the reason. Expand opens it in the lightbox, where it zooms.
 */
export function MermaidBlock({ code }: { code: string }) {
  const streaming = useContext(MarkdownStreamingContext);
  const box = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(false);
  const [type, setType] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  useEffect(() => {
    const element = box.current;
    if (streaming || source || !element) return;
    let live = true;
    let mounted: { destroy(): void } | null = null;
    loadPele().then(
      ({ mount, detectType }) => {
        if (!live) return;
        setType(detectType(code));
        mounted = mount(element, code, {
          // Expand opens the diagram to zoom; in the reply it just fits.
          zoom: false,
          onRender: () => setError(""),
          onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
        });
      },
      () => live && setError("The diagram renderer didn't load."),
    );
    return () => {
      live = false;
      mounted?.destroy();
    };
  }, [code, streaming, source]);

  if (streaming) return <CodeBlock code={code} fence="mermaid" />;

  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  const expand = async () => {
    const element = box.current;
    if (!element) return;
    const { render } = await loadPele();
    const style = getComputedStyle(element);
    try {
      const { svg, width, height } = render(code, {
        maxWidth: Math.max(640, window.innerWidth - 160),
        fontFamily: style.fontFamily,
        // Larger than the reply's text: the lightbox has the room, and zooms from there.
        fontSize: 16,
      });
      const theme = plainTheme(element);
      // On its own the SVG has no page behind it: a backdrop of the block's colour, with room around the drawing.
      const pad = 24;
      const framed = resolveDiagramSvg(svg, theme)
        .replace(/^<svg\b([^>]*?)\sviewBox="[^"]*"/, `<svg$1 viewBox="${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}"`)
        .replace(/\swidth="[\d.]+"/, ` width="${width + pad * 2}"`)
        .replace(/\sheight="[\d.]+"/, ` height="${height + pad * 2}"`)
        .replace(/^(<svg\b[^>]*>)/, `$1<rect x="${-pad}" y="${-pad}" width="${width + pad * 2}" height="${height + pad * 2}" fill="${theme["--pele-bg"]}"/>`);
      setExpanded(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(framed)}`);
    } catch {
      // A diagram that doesn't draw has nothing to expand.
    }
  };

  const label = diagramLabel(type);
  const tab = (on: boolean) => `rounded-[5px] px-2 py-0.5 text-[11px] transition-colors ${on ? "bg-field text-ink" : "text-ink-3 hover:text-ink"}`;
  return (
    <div data-slot="mermaid-block" className="markdown-code my-2 overflow-hidden rounded-control border border-line bg-inset">
      <div className="flex h-8 items-center gap-1 border-b border-line pr-1 pl-2.5 text-[11px] text-ink-3">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <div role="group" aria-label="Show" className="flex items-center gap-0.5 rounded-[7px] bg-surface p-0.5">
          <button type="button" aria-pressed={!source} onClick={() => setSource(false)} className={tab(!source)}>
            Diagram
          </button>
          <button type="button" aria-pressed={source} onClick={() => setSource(true)} className={tab(source)}>
            Source
          </button>
        </div>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy diagram source"}
          onClick={copy}
          className="flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.8} color="currentColor" />
        </button>
        <button
          type="button"
          aria-label="Expand diagram"
          disabled={source || !!error}
          onClick={() => void expand()}
          className="flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          <HugeiconsIcon icon={ArrowExpand01Icon} size={13} strokeWidth={1.8} color="currentColor" />
        </button>
      </div>
      {source || error ? (
        <>
          {error && !source && (
            <p role="alert" className="px-3 pt-2 text-[12px] text-red-ink">
              The diagram didn't draw: {error}
            </p>
          )}
          <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[1.6]">
            <code>{code}</code>
          </pre>
        </>
      ) : null}
      <div ref={box} data-slot="mermaid-diagram" hidden={source || !!error} aria-label={label} className="px-3 py-3 text-[13px]" style={THEME} />
      {expanded && (
        <MediaLightbox
          items={[{ id: "diagram", name: label, src: expanded, kind: "image" }]}
          start={0}
          thumbFor={() => box.current}
          close={() => setExpanded(null)}
        />
      )}
    </div>
  );
}
