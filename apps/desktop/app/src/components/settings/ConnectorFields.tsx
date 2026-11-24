import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";

export type Pair = { key: string; value: string };
export const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-13 text-ink outline-none";
const pairField = "min-w-0 rounded-control border border-transparent bg-field px-3 py-2 text-13 text-ink outline-none placeholder:text-ink-3";
export const footerButton = "rounded-control px-4 py-2 text-13 transition-colors disabled:opacity-40";
export const label = "block space-y-1.5 text-12 font-medium text-ink-2";
export const headersOf = (pairs: Pair[]) =>
  Object.fromEntries(pairs.filter((pair) => pair.key.trim() && pair.value).map((pair) => [pair.key.trim(), pair.value]));

export function Secret({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={label}>
      {name}
      <input
        type="password"
        aria-label={name}
        autoComplete="off"
        spellCheck={false}
        className={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function CommandFields({
  command,
  args,
  pairs,
  onCommand,
  onArgs,
  onPairs,
}: {
  command: string;
  args: string;
  pairs: Pair[];
  onCommand: (value: string) => void;
  onArgs: (value: string) => void;
  onPairs: (pairs: Pair[]) => void;
}) {
  const shown = pairs.length ? pairs : [{ key: "", value: "" }];
  return (
    <>
      <label className={label}>
        Command
        <input aria-label="Command" className={field} placeholder="npx" value={command} onChange={(event) => onCommand(event.target.value)} />
        <span className="block font-normal text-ink-3">Runs once on the computer for every Chat, and stops when no Chat has used it for a while.</span>
      </label>
      <label className={label}>
        Arguments (optional)
        <textarea
          aria-label="Arguments"
          rows={3}
          className={`${field} resize-y font-mono text-12`}
          placeholder={"-y\n@scope/server"}
          value={args}
          onChange={(event) => onArgs(event.target.value)}
        />
        <span className="block font-normal text-ink-3">One per line.</span>
      </label>
      <div className="space-y-1">
        <span className="block text-12 font-medium text-ink-2">Environment (optional)</span>
        {shown.map((pair, index) => (
          <div key={index} className="flex gap-2">
            <input
              aria-label="Variable"
              className={`${pairField} w-[170px] shrink-0`}
              placeholder="Variable"
              value={pair.key}
              onChange={(event) => onPairs(Object.assign([...shown], { [index]: { ...pair, key: event.target.value } }))}
            />
            <input
              aria-label="Value"
              type="password"
              className={`${pairField} flex-1`}
              placeholder="Value"
              value={pair.value}
              onChange={(event) => onPairs(Object.assign([...shown], { [index]: { ...pair, value: event.target.value } }))}
            />
            <button
              type="button"
              aria-label="Add a variable"
              className={`flex size-9 shrink-0 items-center justify-center rounded-control border border-line-strong bg-surface text-ink-2 hover:bg-hover ${index === shown.length - 1 ? "" : "invisible"}`}
              onClick={() => onPairs([...shown, { key: "", value: "" }])}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.75} color="currentColor" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

export function UrlExtras({
  pairs,
  onPairs,
  clientId,
  onClientId,
  clientSecret,
  onClientSecret,
}: {
  pairs: Pair[];
  onPairs: (pairs: Pair[]) => void;
  clientId: string;
  onClientId: (value: string) => void;
  clientSecret: string;
  onClientSecret: (value: string) => void;
}) {
  const shown = pairs.length ? pairs : [{ key: "", value: "" }];
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer text-12 font-medium text-ink-2">Headers and OAuth app (optional)</summary>
      <div className="space-y-1 pt-3">
        <span className="block text-12 font-medium text-ink-2">Headers, for servers that take an API key</span>
        {shown.map((pair, index) => (
          <div key={index} className="flex gap-2">
            <input
              aria-label="Header"
              className={`${pairField} w-[170px] shrink-0`}
              placeholder="Header"
              value={pair.key}
              onChange={(event) => onPairs(Object.assign([...shown], { [index]: { ...pair, key: event.target.value } }))}
            />
            <input
              aria-label="Value"
              type="password"
              className={`${pairField} flex-1`}
              placeholder="Value"
              value={pair.value}
              onChange={(event) => onPairs(Object.assign([...shown], { [index]: { ...pair, value: event.target.value } }))}
            />
            <button
              type="button"
              aria-label="Add a header"
              className={`flex size-9 shrink-0 items-center justify-center rounded-control border border-line-strong bg-surface text-ink-2 hover:bg-hover ${index === shown.length - 1 ? "" : "invisible"}`}
              onClick={() => onPairs([...shown, { key: "", value: "" }])}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.75} color="currentColor" />
            </button>
          </div>
        ))}
      </div>
      <p className="text-12 text-ink-3">Only for a server that can't register Milagre by itself: the client ID and secret of the app you made for it.</p>
      <label className={label}>
        Client ID
        <input
          aria-label="Client ID"
          autoComplete="off"
          spellCheck={false}
          className={field}
          value={clientId}
          onChange={(event) => onClientId(event.target.value)}
        />
      </label>
      <Secret name="Client Secret" value={clientSecret} onChange={onClientSecret} />
    </details>
  );
}
