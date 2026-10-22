import { Children, createContext, isValidElement, memo, useContext, useState, useEffect } from "react";
import type { ReactNode } from "react";
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

  if (!file)
    return (
      <a href={href} title={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {children}
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
  if (isMarkdownFence(fence)) return <MarkdownBody text={streaming ? closeOpenMarkdown(text) : text} />;
  if (isMermaidFence(fence)) return <MermaidBlock code={text} />;
  const plain = <CodeBlock code={text} fence={fence} />;
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

// Parsed output of one block of text; memoized so a block that stopped changing never parses again.
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
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

/**
 * The answer of a running turn. Its finished blocks render from memo, and only the block being written is
 * parsed (with its open bold or code span closed), so a long answer costs no more per batch than a short one.
 * One wrapper keeps the spacing between blocks the same as when the whole text is a single `Markdown`.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const blocks = splitStreamingBlocks(text);
  return (
    <div className={WRAPPER}>
      {blocks.map((block, index) =>
        index === blocks.length - 1 ? (
          <MarkdownStreamingContext key={index} value={true}>
            <MarkdownBody text={closeOpenMarkdown(block)} />
          </MarkdownStreamingContext>
        ) : (
          <MarkdownBody key={index} text={block} />
        ),
      )}
    </div>
  );
});
