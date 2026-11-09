import { Fragment, useEffect, useMemo, useState } from "react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { resolveCodeLanguage } from "../../lib/code-languages";
import { extensionOf } from "../../lib/diff-comments";
import type { DiffHunk } from "../../lib/diff-parse";
import { useCopied } from "../../lib/use-copied";
import { isLanguageReady, loadLanguage } from "../markdown/highlighter";
import { Content, decorate, MARKER, MARKER_COLOR, TINT } from "../changes/diff-lines";
import { Button, IconButton } from "../primitives/Button";

/** Rows an edit's diff shows before it folds behind "Show all". */
export const STEP_DIFF_ROWS = 14;

/**
 * An edit's diff in the transcript, drawn like the Changes view: tinted rows, changed words marked, the file's syntax
 * colours, old and new line numbers. File headers and hunk ranges are left out; the row above already names the file.
 */
export function StepDiff({ hunks, path, copyText }: { hunks: DiffHunk[]; path: string; copyText: string }) {
  const [all, setAll] = useState(false);
  const [, setLoaded] = useState(0);
  const { copied, copy } = useCopied(copyText);
  const language = resolveCodeLanguage(extensionOf(path));
  const languageReady = language !== undefined && isLanguageReady(language);
  useEffect(() => {
    if (!language || languageReady) return;
    let live = true;
    loadLanguage(language).then(
      () => live && setLoaded((count) => count + 1),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [language, languageReady]);
  const decorations = useMemo(() => decorate(hunks, path, languageReady), [hunks, path, languageReady]);
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const clamped = !all && total > STEP_DIFF_ROWS;
  // Line number columns wide enough for the largest number in the diff.
  const digits = String(Math.max(0, ...hunks.map((hunk) => Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)))).length;
  const gutter = `${Math.max(3, digits)}ch`;

  return (
    <div data-step-diff className="group/diff relative my-1 min-w-0">
      <div
        className={`relative overflow-hidden rounded-control border border-line bg-inset font-mono text-[length:var(--code-size)] leading-5`}
        style={clamped ? { maxHeight: `${STEP_DIFF_ROWS * 20 + 2}px` } : undefined}
      >
        <div className="overflow-x-auto py-1">
          <div className="w-max min-w-full">
            {hunks.map((hunk, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <div aria-hidden data-step-diff-gap className="flex h-5 select-none items-center px-3 text-ink-4">
                    ⋯
                  </div>
                )}
                {hunk.lines.map((line, lineIndex) => (
                  <div key={lineIndex} data-diff-row={line.kind} className={`flex min-h-5 ${TINT[line.kind]}`}>
                    {/* Old and new numbers each in their own right-aligned cell, 1ch apart and 1.5ch before the marker. */}
                    <span className="ml-3 shrink-0 select-none text-right text-ink-3 tabular-nums" style={{ width: gutter }}>
                      {line.oldNumber}
                    </span>
                    <span className="ml-[1ch] shrink-0 select-none text-right text-ink-3 tabular-nums" style={{ width: gutter }}>
                      {line.newNumber}
                    </span>
                    <span className={`ml-[1.5ch] w-[2ch] shrink-0 select-none ${MARKER_COLOR[line.kind]}`}>{MARKER[line.kind]}</span>
                    <span className="min-w-0 flex-1 whitespace-pre pr-3">
                      <Content line={line} decoration={decorations.get(line)} />
                    </span>
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
        {clamped && (
          <div
            aria-hidden
            data-step-diff-fade
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
            style={{ background: "linear-gradient(to bottom, transparent, var(--inset))" }}
          />
        )}
        <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/diff:opacity-100 focus-within:opacity-100">
          <IconButton label={copied ? "Copied" : "Copy diff"} icon={copied ? Tick02Icon : Copy01Icon} size={24} onClick={copy} className="bg-inset" />
        </div>
      </div>
      {clamped && (
        <Button variant="quiet" size={24} onClick={() => setAll(true)} className="mt-1">
          Show all {total} lines
        </Button>
      )}
    </div>
  );
}
