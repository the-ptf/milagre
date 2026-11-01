import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { htmlRenderShell, htmlRenderHeight, HTML_RENDER_MESSAGE, readHtmlRenderMessage, type HtmlRenderTheme } from "@milagre/shared/html-render";
import type { ArtifactRef } from "../../model";
import { ARTIFACT_CSP, type Artifact } from "@milagre/shared/artifact";
import { THEME_EVENT } from "../../lib/theme-sheet";
import { readArtifact } from "./ArtifactCanvas";

const TOKENS = {
  surface: "surface",
  field: "field",
  ink: "ink",
  ink2: "ink-2",
  muted: "ink-3",
  line: "line",
  lineStrong: "line-strong",
  accent: "accent",
  accentInk: "accent-ink",
  accentTint: "accent-tint",
  green: "green",
  orange: "orange",
  red: "red",
  purple: "purple",
};

const scheme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/**
 * The transcript around the reply: its chat text and the app's colors, so the page reads as part of it. The page is
 * transparent, so whatever the transcript sits on (page, grid tile, window stripes) shows through.
 */
function theme(host: HTMLElement | null): HtmlRenderTheme {
  const root = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(Object.entries(TOKENS).map(([key, token]) => [key, root.getPropertyValue(`--${token}`).trim()]));
  const text = getComputedStyle(host ?? document.body);
  const size = parseFloat(text.fontSize);
  const leading = parseFloat(text.lineHeight) / size;
  const tracking = parseFloat(text.letterSpacing) / size;
  return {
    ...colors,
    background: "transparent",
    scheme: scheme(),
    tracking: Number.isFinite(tracking) ? Math.round(tracking * 1000) / 1000 : undefined,
    font: text.fontFamily,
    mono: root.getPropertyValue("--font-mono").trim() || undefined,
    size: Number.isFinite(size) ? size : undefined,
    leading: Number.isFinite(leading) ? Math.round(leading * 100) / 100 : undefined,
  };
}

function HtmlFrame({
  html,
  title,
  initialTheme,
  host,
  onHeight,
  onEscape,
}: {
  html: string;
  title: string;
  /** The reader theme when the page loaded; later changes are sent to the running page. */
  initialTheme: HtmlRenderTheme;
  host: RefObject<HTMLElement | null>;
  onHeight?: (height: number) => void;
  onEscape?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const source = useMemo(() => htmlRenderShell(html, initialTheme), [html, initialTheme]);
  const [registered, setRegistered] = useState<{ source: string; attempt: number; url: string }>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const isolated = !!window.milagre?.createArtifactPreview;
  const url = registered?.source === source && registered.attempt === attempt ? registered.url : undefined;
  useEffect(() => {
    if (!isolated) return;
    let live = true;
    let createdUrl: string | undefined;
    // A protocol response owns its CSP. srcdoc would inherit the packaged app's script restrictions and block both
    // the relay and the author's scripts, although the same document runs in html_preview and native WebViews.
    void window.milagre.createArtifactPreview(source, { inline: true }).then(
      (value) => {
        createdUrl = value;
        if (live) setRegistered({ source, attempt, url: value });
        else void window.milagre.releaseArtifactPreview(value);
        return null;
      },
      () => {
        if (live) setError(true);
        return null;
      },
    );
    return () => {
      live = false;
      if (createdUrl) void window.milagre.releaseArtifactPreview(createdUrl);
    };
  }, [source, isolated, attempt]);
  useEffect(() => {
    const changed = () => {
      if (frame.current) frame.current.style.colorScheme = scheme();
      frame.current?.contentWindow?.postMessage({ channel: HTML_RENDER_MESSAGE, type: "theme", theme: theme(host.current) }, "*");
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = readHtmlRenderMessage(event.data);
      if (message?.type === "ready") changed();
      if (message?.type === "size") onHeight?.(message.height);
      if (message?.type === "escape") onEscape?.();
      if (message?.type === "link") window.open(message.url, "_blank", "noopener,noreferrer");
    };
    window.addEventListener(THEME_EVENT, changed);
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener(THEME_EVENT, changed);
      window.removeEventListener("message", receive);
    };
  }, [host, onHeight, onEscape]);
  if (isolated && !url)
    return (
      <div role="status" className="text-ink-3">
        {error ? (
          <button
            type="button"
            className="text-accent-ink hover:underline"
            onClick={() => {
              setError(false);
              setAttempt((n) => n + 1);
            }}
          >
            Could not load this page. Retry
          </button>
        ) : (
          "Loading page"
        )}
      </div>
    );
  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={isolated ? url : undefined}
      srcDoc={isolated ? undefined : source}
      {...{ csp: ARTIFACT_CSP }}
      // Matches the page's scheme so Chromium keeps the transparent page see-through.
      style={{ colorScheme: scheme() }}
      className="block size-full border-0 bg-transparent"
    />
  );
}

/** Immutable pages are read by their own id, never through the live Artifact catalog. */
export function HtmlReply({ chatId, page }: { chatId: string | null; page: ArtifactRef }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key?: string; artifact?: Artifact; theme?: HtmlRenderTheme; error?: string }>({});
  const host = useRef<HTMLElement>(null);
  const key = `${chatId}:${page.id}:${page.version}:${attempt}`;
  const { artifact, theme: initialTheme, error } = loaded.key === key ? loaded : {};
  useEffect(() => {
    let live = true;
    if (chatId)
      readArtifact(chatId, page.id, page.version).then(
        // The page loads after its message is on screen, so the transcript is there to read the theme from.
        (value) => live && setLoaded({ key, artifact: value, theme: theme(host.current) }),
        () => live && setLoaded({ key, error: "Could not load this page." }),
      );
    return () => {
      live = false;
    };
  }, [chatId, page.id, page.version, key]);
  const [height, setHeight] = useState(() => htmlRenderHeight(page.height));
  // No frame, title or toolbar: the page sits in the reply like its text. Loading keeps the measured height so the
  // transcript doesn't jump; only a failure shows words.
  return (
    <section ref={host} data-slot="html-reply" aria-label={page.title} className="mb-2">
      {artifact && initialTheme ? (
        <div style={{ height }}>
          <HtmlFrame html={artifact.html} title={page.title} initialTheme={initialTheme} host={host} onHeight={setHeight} />
        </div>
      ) : error ? (
        <p className="text-ink-3" role="status">
          {error}{" "}
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="text-accent-ink hover:underline">
            Retry
          </button>
        </p>
      ) : (
        <div style={{ height }} role="status" aria-label={chatId ? "Loading page" : "Open this Chat to see the page"} />
      )}
    </section>
  );
}
