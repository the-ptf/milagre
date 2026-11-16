import { Children, createContext, isValidElement, memo, useContext, useState, useEffect, useRef } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import type { ImageAttachment } from "@milagre/shared/model";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { codeLanguageFromClassName } from "../../lib/code-languages";
import { fileLinkName, fileLinkTarget, isWindowsPath, localFileLink } from "@milagre/shared/file-link";
import { isGenuiFence } from "@milagre/shared/genui";
import { useFileOpener, useFilesRoot } from "../editor-links";
import { lazyView } from "../../lib/lazy-view";
import { closeOpenMarkdown } from "../../lib/streaming-markdown";
import { isMermaidFence } from "@milagre/shared/diagram";
import { isMarkdownFence } from "@milagre/shared/markdown-fence";
import { orderedListDigits } from "@milagre/shared/ordered-list";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { GenerativeUI, MarkdownStreamingContext } from "../genui/GenerativeUI";
import { splitStreamingBlocks } from "./streaming-blocks";
import { mediaKind, mediaUrl } from "../../lib/media";
import { isRemoteKey, useScope } from "../../lib/computer-bridge";
import { useComputers } from "../../lib/computers";
import { LoopbackPortsContext } from "../../lib/ports";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { reachableUrl } from "@milagre/shared/loopback-url";
import { openInBrowserPanel } from "../../lib/browser-panel";
import { opensInPanel } from "../../lib/link-target";
import { remoteImageDataUrl } from "../../lib/remote-media";
import { MediaLightbox } from "../motion/LazyMediaLightbox";

const AttachmentPreview = lazyView(() => import("../AttachmentPreview").then((module) => module.AttachmentPreview));

export const CODE_CHIP = "rounded-inline bg-hover-2 px-1 py-px font-mono text-[0.875em] text-ink";
const CODE_CLASS = CODE_CHIP;
const MarkdownImages = createContext<ImageAttachment[] | undefined>(undefined);
export type MarkdownImageLoader = (src: string) => Promise<string> | null;
const ImageLoader = createContext<MarkdownImageLoader | undefined>(undefined);

function LoadedImage({ load, src, alt, width }: { load: Promise<string>; src: string; alt?: string; width?: string | number }) {
  const [state, setState] = useState<{ load: Promise<string>; url: string | null; failed: boolean }>({ load, url: null, failed: false });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    load.then(
      (url) => live && setState({ load, url, failed: false }),
      () => live && setState({ load, url: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  const current = state.load === load ? state : { url: null, failed: false };
  if (current.failed) return <ImageLink src={src} alt={alt} />;
  const size = Number(width) > 0 ? { width: Number(width) } : undefined;
  if (!current.url)
    return (
      <span
        data-markdown-image-loading=""
        className="inline-block h-24 max-w-full rounded-chip bg-hover-2 align-middle motion-safe:animate-pulse"
        style={size ?? { width: 160 }}
      />
    );
  const name = alt || "Image";
  return (
    <>
      <button
        type="button"
        aria-label={`Open ${name}`}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        className="inline-block max-w-full cursor-zoom-in rounded-chip align-middle"
      >
        <img src={current.url} alt={alt} title={alt} style={size} className="block h-auto max-w-full rounded-chip" />
      </button>
      {open && (
        <MediaLightbox
          items={[{ id: src, name, src: current.url, kind: "image", file: current.url }]}
          start={0}
          close={() => setOpen(false)}
          thumbFor={() => null}
        />
      )}
    </>
  );
}

function MarkdownImage({ src, alt, width }: { src?: string; alt?: string; width?: string | number }) {
  const loader = useContext(ImageLoader);
  const load = src ? loader?.(src) : null;
  return load && src ? <LoadedImage load={load} src={src} alt={alt} width={width} /> : <ImageLink src={src} alt={alt} />;
}

function ImageLink({ src, alt }: { src?: string; alt?: string }) {
  const images = useContext(MarkdownImages);
  const root = useFilesRoot();
  const file = src ? localFileLink(src, root ?? undefined) : null;
  const saved = images?.find((image) => image.sourcePath === file?.path || image.path === file?.path);
  return <Link href={saved?.path ?? src}>{alt || src || "image"}</Link>;
}

function InlineCode({ children }: { children?: ReactNode }) {
  const opener = useFileOpener();
  const text = Children.toArray(children).join("");
  const target = opener ? fileLinkTarget(text) : null;
  if (!opener || !target) return <code className={CODE_CLASS}>{children}</code>;
  return (
    <button
      type="button"
      title={opener.title}
      onClick={() => opener.open(target.path, target.line)}
      className={`${CODE_CLASS} cursor-pointer text-left decoration-ink-3 underline-offset-2 hover:underline`}
    >
      {children}
    </button>
  );
}

function useReachableHref(href: string | undefined) {
  const scope = useScope();
  const { computers } = useComputers();
  const loopbackOnly = useContext(LoopbackPortsContext);
  if (!href || !scope || !isRemoteKey(scope)) return href;
  return reachableUrl(href, computers.find((computer) => computer.id === computerOfKey(scope))?.address, loopbackOnly);
}

const LINK_CLASS = "text-accent-ink underline decoration-accent-ink/40 underline-offset-2 hover:decoration-accent-ink";

function MediaLinkLightbox({ path, name, kind, close }: { path: string; name: string; kind: "image" | "video"; close: () => void }) {
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const [src, setSrc] = useState<string | null>(remote ? null : mediaUrl(path));

  useEffect(() => {
    if (remote && scope && kind === "image") {
      let live = true;
      remoteImageDataUrl(scope, path)
        .then((url) => live && setSrc(url))
        .catch(() => {
          if (live) close();
        });
      return () => {
        live = false;
      };
    }
  }, [remote, scope, path, kind, close]);

  if (!src) return null;

  return <MediaLightbox items={[{ id: path, name, src, kind, file: remote ? src : path }]} start={0} close={close} thumbFor={() => null} />;
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const root = useFilesRoot();
  const [open, setOpen] = useState(false);
  const file = href ? localFileLink(href, root ?? undefined) : null;
  const scope = useScope();
  const reachable = useReachableHref(file ? undefined : href);

  if (!file)
    return (
      <a
        href={reachable}
        title={reachable}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!reachable || !/^https?:\/\//i.test(reachable) || event.shiftKey || !opensInPanel(event)) return;
          event.preventDefault();
          if (!openInBrowserPanel(isRemoteKey(scope) && href ? href : reachable)) window.open(reachable, "_blank", "noreferrer");
        }}
        className={LINK_CLASS}
      >
        {reachable !== href && Children.toArray(children).join("") === href ? reachable : children}
      </a>
    );

  const name = fileLinkName(file.path);
  const kind = mediaKind(file.path);
  const remote = isRemoteKey(scope);
  const supportedMedia = kind && (!remote || kind === "image");

  return (
    <>
      <a
        href={href}
        title={file.path}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        onMouseEnter={supportedMedia ? undefined : AttachmentPreview.preload}
        className={`${LINK_CLASS} cursor-pointer`}
      >
        {children}
      </a>
      {open && supportedMedia ? (
        <MediaLinkLightbox path={file.path} name={name} kind={kind} close={() => setOpen(false)} />
      ) : open ? (
        <AttachmentPreview path={file.path} name={name} close={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const streaming = useContext(MarkdownStreamingContext);
  const code = Children.toArray(children).find(isValidElement) as { props: { className?: string; children?: ReactNode } } | undefined;
  const text = String(code?.props.children ?? "").replace(/\n$/, "");
  const fence = codeLanguageFromClassName(code?.props.className);
  if (isMarkdownFence(fence)) return streaming ? <MarkdownBody text={closeOpenMarkdown(text)} cache={false} /> : <MarkdownBody text={text} />;
  if (isMermaidFence(fence)) return <MermaidBlock code={text} />;
  const plain = <CodeBlock code={text} fence={fence} streaming={streaming} />;
  return isGenuiFence(fence) ? <GenerativeUI code={text} fallback={plain} /> : plain;
}

const components: Components = {
  pre: MarkdownPre,
  code: InlineCode,
  a({ href, children }) {
    return <Link href={href}>{children}</Link>;
  },
  img({ src, alt, width }) {
    return <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} width={width} />;
  },
  // The marker gutter widens with the list's widest number (styles.css), so "10." shows whole.
  ol({ node, children, ...props }) {
    const items = node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
    const digits = orderedListDigits(props.start, items, Boolean(props.reversed));
    return (
      <ol {...props} style={digits > 1 ? ({ ...props.style, "--marker-digits": digits } as CSSProperties) : props.style}>
        {children}
      </ol>
    );
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table>{children}</table>
      </div>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm];
const urlTransform = (url: string) => (isWindowsPath(url) ? url : defaultUrlTransform(url));
const HTML_PLUGINS = [rehypeRaw, rehypeSanitize];
const HTML_KEY = "\0html\0";

function parseMarkdown(text: string, html = false): ReactElement {
  return ReactMarkdown({ children: text, remarkPlugins: REMARK_PLUGINS, rehypePlugins: html ? HTML_PLUGINS : undefined, components, urlTransform });
}

const CACHE_ENTRIES = 500;
const CACHE_CHARS = 2_000_000;
const CACHE_MAX_TEXT = 200_000;
const parsedBodies = new Map<string, ReactElement>();
let parsedChars = 0;

function cachedMarkdown(text: string, html = false): ReactElement {
  const key = html ? HTML_KEY + text : text;
  const hit = parsedBodies.get(key);
  if (hit) {
    parsedBodies.delete(key);
    parsedBodies.set(key, hit);
    return hit;
  }
  const parsed = parseMarkdown(text, html);
  if (text.length > CACHE_MAX_TEXT) return parsed;
  parsedBodies.set(key, parsed);
  parsedChars += key.length;
  for (const oldest of parsedBodies.keys()) {
    if (parsedBodies.size <= CACHE_ENTRIES && parsedChars <= CACHE_CHARS) break;
    parsedBodies.delete(oldest);
    parsedChars -= oldest.length;
  }
  return parsed;
}

const MarkdownBody = memo(function MarkdownBody({ text, cache = true, html = false }: { text: string; cache?: boolean; html?: boolean }) {
  return cache ? cachedMarkdown(text, html) : parseMarkdown(text, html);
});

const WRAPPER = "markdown break-words [overflow-wrap:anywhere]";

export const Markdown = memo(function Markdown({
  text,
  images,
  html,
  loadImage,
}: {
  text: string;
  images?: ImageAttachment[];
  html?: boolean;
  loadImage?: MarkdownImageLoader;
}) {
  return (
    <MarkdownImages.Provider value={images}>
      <ImageLoader.Provider value={loadImage}>
        <div className={WRAPPER}>
          <MarkdownBody text={text} html={html} />
        </div>
      </ImageLoader.Provider>
    </MarkdownImages.Provider>
  );
});

const STREAM_RENDER_MS = 50;

function useThrottledValue<T>(value: T, interval: number): T {
  const [shown, setShown] = useState(value);
  const shownAt = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const show = () => {
      shownAt.current = performance.now();
      setShown(value);
    };
    const wait = shownAt.current + interval - performance.now();
    if (wait <= 0) {
      show();
      return;
    }
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [value, shown, interval]);
  return shown;
}

const StreamingBlocks = memo(function StreamingBlocks({ text }: { text: string }) {
  const blocks = splitStreamingBlocks(text);
  return (
    <div className={WRAPPER}>
      {blocks.map((block, index) =>
        index === blocks.length - 1 ? (
          <MarkdownStreamingContext key={index} value={true}>
            <MarkdownBody text={closeOpenMarkdown(block)} cache={false} />
          </MarkdownStreamingContext>
        ) : (
          <MarkdownBody key={index} text={block} />
        ),
      )}
    </div>
  );
});

export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  return <StreamingBlocks text={useThrottledValue(text, STREAM_RENDER_MS)} />;
});
