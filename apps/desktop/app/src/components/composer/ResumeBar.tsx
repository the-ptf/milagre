import { Button } from "../primitives/Button";

export function ResumeBar({ onContinue, disabled }: { onContinue: () => void; disabled: boolean }) {
  return (
    <div data-resume-bar className="flex w-full items-center gap-3 rounded-control border border-line px-3 py-2 text-12 text-ink-2">
      <span className="min-w-0 flex-1">Milagre closed while this Chat was working.</span>
      <Button size={24} onClick={onContinue} disabled={disabled}>
        Continue
      </Button>
    </div>
  );
}
