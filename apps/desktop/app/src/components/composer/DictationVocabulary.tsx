import { useEffect, useState } from "react";
import type { VocabularyCorrection } from "@milagre/shared/dictation";
import { useBridge } from "../../lib/computer-bridge";
import { Dialog } from "../primitives/Dialog";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Field";

export function DictationVocabulary({ cwd, correction, onClose }: { cwd: string; correction: VocabularyCorrection; onClose(): void }) {
  const bridge = useBridge();
  const [items, setItems] = useState<VocabularyCorrection[]>([]);
  const [heard, setHeard] = useState(correction.heard);
  const [spelling, setSpelling] = useState(correction.spelling);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    bridge
      .dictationCorrections(cwd)
      .then(
        (words) => {
          if (live) setItems(words);
        },
        (e) => {
          if (live) setError(String(e));
        },
      )
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [bridge, cwd]);
  async function save(phrase: string, replacement: string) {
    setBusy(true);
    try {
      await bridge.setDictationCorrection(cwd, phrase, replacement);
      setItems(await bridge.dictationCorrections(cwd));
      setHeard("");
      setSpelling("");
      setError("");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Project dictation vocabulary"
      description="Save how a name was heard and how this Project spells it."
      onClose={onClose}
      as="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && heard.trim() && spelling.trim()) void save(heard, spelling);
      }}
      actions={
        <Button type="submit" disabled={busy || !heard.trim() || !spelling.trim()}>
          Save correction
        </Button>
      }
    >
      <div className="mt-3 grid gap-2">
        <label>
          Heard as
          <Input value={heard} maxLength={128} onChange={(event) => setHeard(event.target.value)} />
        </label>
        <label>
          Write as
          <Input value={spelling} maxLength={128} onChange={(event) => setSpelling(event.target.value)} />
        </label>
        {items.map((item) => (
          <div key={item.heard} className="flex items-center justify-between gap-2 text-13">
            <span>
              {item.heard} → {item.spelling}
            </span>
            <Button variant="quiet" disabled={busy} aria-label={`Remove ${item.heard}`} onClick={() => void save(item.heard, "")}>
              Remove
            </Button>
          </div>
        ))}
        {error && (
          <p role="alert" className="text-red-ink">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
