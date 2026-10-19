import { FileChip, SkillChip } from "../PromptChip";

const DIFF_LINES = [
  { sign: " ", text: 'test("surface renders", async () => {', kind: "context" },
  { sign: "-", text: "  await sleep(500);", kind: "remove" },
  { sign: "+", text: "  await waitFor(() => surface.ready);", kind: "add" },
  { sign: " ", text: "});", kind: "context" },
] as const;

/** A live sample of the Appearance settings: a prompt with chips at the chat size, and a diff at the code size in the mono font. */
export function AppearancePreview() {
  return (
    <div data-slot="appearance-preview" className="mt-3 grid gap-3 rounded-[12px] bg-surface p-4 shadow-card">
      <p data-preview-text className="leading-relaxed text-ink" style={{ fontSize: "var(--chat-size)" }}>
        Use <SkillChip name="frontend-design" /> to fix the flaky test in <FileChip path="src/surface.test.ts" /> and align the header with{" "}
        <FileChip path="src/SettingsPanels.tsx" /> before shipping.
      </p>
      <div data-preview-diff className="overflow-hidden rounded-[8px] border border-line font-mono leading-relaxed" style={{ fontSize: "var(--code-size)" }}>
        {DIFF_LINES.map((line) => (
          <div
            key={`${line.sign}${line.text}`}
            data-diff-line={line.kind}
            className={`flex gap-3 px-3 whitespace-pre ${line.kind === "add" ? "text-diff-add" : line.kind === "remove" ? "text-diff-remove" : "text-ink-2"}`}
            style={line.kind === "add" ? { background: "var(--diff-add)" } : line.kind === "remove" ? { background: "var(--diff-remove)" } : undefined}
          >
            <span aria-hidden>{line.sign}</span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
