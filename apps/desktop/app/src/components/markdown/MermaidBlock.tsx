import { useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowExpand01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { diagramLabel, resolveDiagramSvg } from "@milagre/shared/diagram";
import { MarkdownStreamingContext } from "../genui/GenerativeUI";
import { MediaLightbox } from "../motion/LazyMediaLightbox";
import { CodeBlock } from "./CodeBlock";
import { IconButton } from "../primitives/Button";

let pele: Promise<typeof import("pele")> | null = null;
const loadPele = () => (pele ??= import("pele"));

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
      return [name, name === "--pele-font" ? style.getPropertyValue(name).trim().replace(/"/g, "'") : getComputedStyle(probe).color];
    }),
  );
  probe.remove();
  return resolved;
}

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
        fontSize: 16,
      });
      const theme = plainTheme(element);
      const pad = 24;
      const framed = resolveDiagramSvg(svg, theme)
        .replace(/^<svg\b([^>]*?)\sviewBox="[^"]*"/, `<svg$1 viewBox="${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}"`)
        .replace(/\swidth="[\d.]+"/, ` width="${width + pad * 2}"`)
        .replace(/\sheight="[\d.]+"/, ` height="${height + pad * 2}"`)
        .replace(/^(<svg\b[^>]*>)/, `$1<rect x="${-pad}" y="${-pad}" width="${width + pad * 2}" height="${height + pad * 2}" fill="${theme["--pele-bg"]}"/>`);
      setExpanded(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(framed)}`);
    } catch {}
  };

  const label = diagramLabel(type);
  const tab = (on: boolean) =>
    `rounded-chip px-2 py-0.5 text-11 font-medium transition-colors ${on ? "bg-surface text-ink shadow-card dark:bg-hover-2" : "text-ink-2 hover:text-ink"}`;
  return (
    <div data-slot="mermaid-block" className="markdown-code my-2 overflow-hidden rounded-control border border-line bg-inset">
      <div className="flex h-7 items-center gap-1 border-b border-line pr-1 pl-2.5 text-11 text-ink-3">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <div role="group" aria-label="Show" className="flex items-center gap-0.5 rounded-control bg-field p-0.5">
          <button type="button" aria-pressed={!source} onClick={() => setSource(false)} className={tab(!source)}>
            Diagram
          </button>
          <button type="button" aria-pressed={source} onClick={() => setSource(true)} className={tab(source)}>
            Source
          </button>
        </div>
        <IconButton label={copied ? "Copied" : "Copy diagram source"} icon={copied ? Tick02Icon : Copy01Icon} size={24} onClick={copy} />
        <IconButton label="Expand diagram" icon={ArrowExpand01Icon} size={24} disabled={source || !!error} onClick={() => void expand()} />
      </div>
      {source || error ? (
        <>
          {error && !source && (
            <p role="alert" className="px-3 pt-2 text-12 text-red-ink">
              The diagram didn't draw: {error}
            </p>
          )}
          <pre className="overflow-x-auto px-3 py-3 font-mono text-[length:var(--code-size)] leading-[1.6]">
            <code>{code}</code>
          </pre>
        </>
      ) : null}
      <div ref={box} data-slot="mermaid-diagram" hidden={source || !!error} aria-label={label} className="px-3 py-3 text-13" style={THEME} />
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
