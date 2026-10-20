import { useMemo, type CSSProperties } from "react";
import { fileLanguage, highlightFile, MAX_SYNTAX_CHARACTERS } from "@milagre/shared/file-syntax";

export function FileCode({ text, name }: { text: string; name: string }) {
  const tokens = useMemo(() => highlightFile(text, name), [text, name]);
  return (
    <>
      <pre
        data-file-code
        data-language={fileLanguage(name)}
        className="whitespace-pre-wrap break-words font-mono text-[length:var(--code-size)] leading-relaxed"
      >
        <code>
          {tokens.map((token, index) => (
            <span key={index} data-syntax={token.kind} className="code-token" style={{ "--shiki-light": `var(--syntax-${token.kind})` } as CSSProperties}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
      {text.length > MAX_SYNTAX_CHARACTERS && <p className="mt-4 text-xs text-ink-2">Large file shown without syntax colors.</p>}
    </>
  );
}
