import { Children, createContext, isValidElement, memo, useContext, useState, useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { ImageAttachment } from "@milagre/shared/model";
import remarkGfm from "remark-gfm";
import { codeLanguageFromClassName } from "../../lib/code-languages";
import { fileLinkTarget } from "../../lib/file-links";
import { localFileLink } from "@milagre/shared/file-link";
import { isGenuiFence } from "@milagre/shared/genui";
import { useFileOpener, useFilesRoot } from "../editor-links";
import { lazyView } from "../../lib/lazy-view";
import { closeOpenMarkdown } from "../../lib/streaming-markdown";
import { isMermaidFence } from "@milagre/shared/diagram";
import { isMarkdownFence } from "@milagre/shared/markdown-fence";
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
import { remoteImageDataUrl } from "../../lib/remote-media";
import { MediaLightbox } from "../motion/LazyMediaLightbox";

const AttachmentPreview = lazyView(() => import("../AttachmentPreview").then((module) => module.AttachmentPreview));

const CODE_CLASS = "rounded-[4px] bg-field px-1 py-px font-mono text-[0.92em] text-ink";
const MarkdownImages = createContext<ImageAttachment[] | undefined>(undefined);

function ImageLink({ src, alt }: { src?: string; alt?: string }) {
  const images = useContext(MarkdownImages);
  const root = useFilesRoot();
  const file = src ? localFileLink(src, root ?? undefined) : null;
  const saved = images?.find((image) => image.sourcePath === file?.path || image.path === file?.path);
  return <Link href={saved?.path ?? src}>{alt || src || "image"}</Link>;
}

// Inline code that names a file of the chat's folder opens it in the editor; the click asks main, which says
// when the file isn't there. Everything else stays plain code.
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

// A localhost link that a Chat on another computer wrote opens at that computer's LAN or tailnet IP, the address this
// Mac reaches it on; one over the relay, or to a server the Chat's ports show on loopback only, stays as written. A
// bare URL shows where it now goes.
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
    // Only remote images are loaded via data URLs; videos are too large.
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

// A link to a file on the chat's computer (an absolute path, a file:// URL or a path relative to the chat's folder)
// opens it in the file viewer; a browser would get nothing. Web and mail links leave the app as before.
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const root = useFilesRoot();
  const [open, setOpen] = useState(false);
  const file = href ? localFileLink(href, root ?? undefined) : null;
  const scope = useScope();
  const reachable = useReachableHref(file ? undefined : href);

  if (!file)
    return (
      <a href={reachable} title={reachable} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {reachable !== href && Children.toArray(children).join("") === href ? reachable : children}
      </a>
    );

  const name = file.path.split("/").pop() || file.path;
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

// Raw HTML in a reply is shown as text (react-markdown's default), and unsafe link protocols are dropped.
const components: Components = {
  pre: MarkdownPre,
  code: InlineCode,
  a({ href, children }) {
    return <Link href={href}>{children}</Link>;
  },
  // Remote images in a reply would load without asking; show them as links instead.
  img({ src, alt }) {
    const href = typeof src === "string" ? src : undefined;
    return <ImageLink src={href} alt={alt} />;
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

function parseMarkdown(text: string): ReactElement {
  // react-markdown's sync component uses no hooks: called directly it parses now and returns the element tree, whose
  // components (links, code blocks) still render, and read their context, wherever the tree is mounted.
  return ReactMarkdown({ children: text, remarkPlugins: REMARK_PLUGINS, components });
}

// Parsed bodies outlive their Chat's transcript, so reopening a Chat (or a transcript slot remounting) reuses them
// instead of parsing every message again. react-markdown doesn't expose its syntax tree, so this keeps the element tree
// it returns per text: a few times the text's size in memory, bounded by entries and by the total length of the texts.
const CACHE_ENTRIES = 500;
const CACHE_CHARS = 2_000_000;
// A body this long would push out hundreds of others; it parses on each mount as before.
const CACHE_MAX_TEXT = 200_000;
const parsedBodies = new Map<string, ReactElement>();
let parsedChars = 0;

function cachedMarkdown(text: string): ReactElement {
  const hit = parsedBodies.get(text);
  if (hit) {
    // Most recently used last: Map keeps insertion order.
    parsedBodies.delete(text);
    parsedBodies.set(text, hit);
    return hit;
  }
  const parsed = parseMarkdown(text);
  if (text.length > CACHE_MAX_TEXT) return parsed;
  parsedBodies.set(text, parsed);
  parsedChars += text.length;
  for (const key of parsedBodies.keys()) {
    if (parsedBodies.size <= CACHE_ENTRIES && parsedChars <= CACHE_CHARS) break;
    parsedBodies.delete(key);
    parsedChars -= key.length;
  }
  return parsed;
}

// Parsed output of one block of text; memoized so a block that stopped changing never parses again. A block still
// being written (`cache={false}`) changes on every batch, so it stays out of the cache it would only churn.
const MarkdownBody = memo(function MarkdownBody({ text, cache = true }: { text: string; cache?: boolean }) {
  return cache ? cachedMarkdown(text) : parseMarkdown(text);
});

const WRAPPER = "markdown break-words [overflow-wrap:anywhere]";

export const Markdown = memo(function Markdown({ text, images }: { text: string; images?: ImageAttachment[] }) {
  return (
    <MarkdownImages.Provider value={images}>
      <div className={WRAPPER}>
        <MarkdownBody text={text} />
      </div>
    </MarkdownImages.Provider>
  );
});

// A streamed answer can arrive in dozens of batches a second; parsing the block being written faster than this shows
// nothing new. The last batch always renders, after at most this long.
const STREAM_RENDER_MS = 50;

/** `value`, changing at most once per `interval` ms while it keeps changing; the latest value always follows. */
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

/**
 * The answer of a running turn. Its finished blocks render from memo, and only the block being written is
 * parsed (with its open bold or code span closed), so a long answer costs no more per batch than a short one.
 * One wrapper keeps the spacing between blocks the same as when the whole text is a single `Markdown`. Batches
 * render at most every STREAM_RENDER_MS, so a fast stream doesn't parse the open block more often than it can show.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  return <StreamingBlocks text={useThrottledValue(text, STREAM_RENDER_MS)} />;
});
