import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { resolveCodeLanguage } from "../../lib/code-languages";
import { diffRows } from "../../lib/message-fences";
import { highlight, isLanguageReady, loadLanguage } from "./highlighter";
import { useCopied } from "../../lib/use-copied";

const ROW_TINT = { add: "bg-[var(--diff-add)]", remove: "bg-[var(--diff-remove)]", context: "" } as const;
const ROW_MARKER = { add: "+", remove: "−", context: " " } as const;
const MARKER_COLOR = { add: "text-diff-add", remove: "text-diff-remove", context: "" } as const;

// A block highlights once it is within this distance of the viewport; far ones stay plain text of the same size.
const NEAR_MARGIN = 800;

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * A fenced block with its language's colours. With `diff`, a block whose lines all start with `+`, `-` or a space
 * (a diff snippet, as diff comments send) shows tinted rows and highlights the code without the markers.
 */
export function CodeBlock({ code, fence, diff = false }: { code: string; fence?: string; diff?: boolean }) {
  const rows = useMemo(() => (diff ? diffRows(code) : null), [code, diff]);
  const source = rows ? rows.map((row) => row.text).join("\n") : code;
  const language = resolveCodeLanguage(fence);
  const [, setLoadedCount] = useState(0);
  const { copied, copy } = useCopied(code);
  const languageReady = language !== undefined && isLanguageReady(language);

  // Highlighting a whole long chat on open is the cost; only blocks that come near the viewport pay it, and
  // they stay highlighted afterwards. The layout effect checks the first position so a visible block never flashes plain.
  const frame = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node || near) return;
    // The chat scrolls inside its own viewport, whose edge clips what an observer on the window would see.
    const root = scrollParent(node);
    const area = root?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const rect = node.getBoundingClientRect();
    if (rect.bottom > area.top - NEAR_MARGIN && rect.top < area.bottom + NEAR_MARGIN) {
      setNear(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root, rootMargin: `${NEAR_MARGIN}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || !language || languageReady) return;
    let live = true;
    loadLanguage(language).then(
      () => {
        if (live) setLoadedCount((count) => count + 1);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [near, language, languageReady]);

  const lines = useMemo(() => (near && language && languageReady ? highlight(source, language) : undefined), [near, source, language, languageReady]);

  return (
    <div ref={frame} className="markdown-code my-2 overflow-hidden rounded-control border border-line bg-inset">
      <div className="flex h-7 items-center justify-between border-b border-line pr-1 pl-2.5 text-[11px] text-ink-3">
        <span className="font-mono">{fence?.toLowerCase() || "text"}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={copy}
          className="flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.8} color="currentColor" />
        </button>
      </div>
      {rows ? (
        <pre className="overflow-x-auto py-1.5 font-mono text-[length:var(--code-size)] leading-[1.6]">
          <code className="block min-w-max">
            {rows.map((row, index) => (
              <span key={index} className={`flex pr-3 ${ROW_TINT[row.kind]}`}>
                <span aria-hidden className={`w-6 shrink-0 select-none text-center ${MARKER_COLOR[row.kind]}`}>
                  {ROW_MARKER[row.kind]}
                </span>
                <span className="whitespace-pre">
                  {lines?.[index]
                    ? lines[index].map((token, tokenIndex) => (
                        <span key={tokenIndex} className="code-token" style={token.htmlStyle as CSSProperties}>
                          {token.content}
                        </span>
                      ))
                    : row.text || "\u200b"}
                </span>
                {index < rows.length - 1 && "\n"}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[length:var(--code-size)] leading-[1.6]">
          <code>
            {/* Lines stay joined by real newlines so a hand selection copies blank lines too. */}
            {lines
              ? lines.map((line, index) => (
                  <Fragment key={index}>
                    {index > 0 && "\n"}
                    {line.map((token, tokenIndex) => (
                      <span key={tokenIndex} className="code-token" style={token.htmlStyle as CSSProperties}>
                        {token.content}
                      </span>
                    ))}
                  </Fragment>
                ))
              : code}
          </code>
        </pre>
      )}
    </div>
  );
}
