import { useState } from "react";
import { findingsLabel, reviewCounts, type PrReview, type ReviewFinding } from "@milagre/shared/pr-review";
import type { MilagreBridge } from "../../electron";
import { Button } from "../primitives/Button";

export function ReviewFindings({ review, bridge }: { review: PrReview; bridge: MilagreBridge }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(finding: ReviewFinding, action: "fix" | "dismissed" | "open") {
    setError("");
    setBusy(true);
    try {
      if (action === "fix") await bridge.fixPrReviewFinding({ url: review.url, id: finding.id });
      else await bridge.setPrReviewStatus({ url: review.url, ids: [finding.id], status: action });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this finding.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="py-2 text-12">
      <summary className="cursor-pointer font-medium text-ink">Review findings · {findingsLabel(reviewCounts(review).open)}</summary>
      {review.summary && <p className="my-2 text-ink-2">{review.summary}</p>}
      {review.findings.map((f) => (
        <div key={f.id} className="space-y-1 border-t border-line py-2">
          <p className="break-words text-ink-3">
            <span className={f.severity === "high" ? "text-red-ink" : "text-ink-2"}>{f.severity}</span> · {f.path}
            {f.line ? `:${f.line}` : ""}
          </p>
          <p className="font-medium text-ink">{f.title}</p>
          {f.status === "dismissed" ? (
            <Button size={24} variant="link" disabled={busy} onClick={() => void act(f, "open")}>
              Restore finding
            </Button>
          ) : (
            <>
              {f.body && <p className="text-ink-2">{f.body}</p>}
              {f.suggestion && <p className="text-ink-2">{f.suggestion}</p>}
              <div className="flex items-center gap-2">
                {f.status === "open" ? (
                  <Button size={24} variant="link" disabled={busy} onClick={() => void act(f, "fix")}>
                    Fix in Chat
                  </Button>
                ) : (
                  <span className="text-ink-3">Sent for a fix</span>
                )}
                <Button size={24} variant="link" disabled={busy} onClick={() => void act(f, "dismissed")}>
                  Dismiss
                </Button>
              </div>
            </>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-red-ink">
          {error}
        </p>
      )}
    </details>
  );
}
