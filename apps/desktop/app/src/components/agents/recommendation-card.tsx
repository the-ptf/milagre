import { useState } from "react";
import type { RecommendationOption } from "../../lib/recommendation";
import { Button } from "../primitives/Button";
import { SectionLabel } from "../primitives/SectionLabel";

interface RecommendationCardProps {
  question: string;
  options: RecommendationOption[];
  onSelect: (option: RecommendationOption) => void;
}

function RecommendedBars() {
  return (
    <span className="flex items-end gap-0.5 text-green-ink" aria-hidden="true">
      {[0, 1, 2].map((bar) => (
        <span key={bar} className="w-1 rounded-full bg-current" style={{ height: `${8 + bar * 3}px` }} />
      ))}
    </span>
  );
}

export function RecommendationCard({ question, options, onSelect }: RecommendationCardProps) {
  const [showAlternatives, setShowAlternatives] = useState(false);
  const recommendation = options.find((option) => option.recommended);
  const others = options.filter((option) => option !== recommendation);
  if (options.length === 0) return null;
  // A heading and divider only earn their space when there are several alternatives to introduce.
  const separate = Boolean(recommendation) && others.length >= 2;
  const visible = showAlternatives ? others : others.slice(0, 2);
  const rows = others.length > 0 && (
    <>
      <div className="grid gap-1">
        {visible.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(option)}
            className="flex items-center gap-2 rounded-control bg-inset px-3 py-2 text-left transition-colors hover:bg-hover active:bg-hover-2"
          >
            <span className="min-w-0 flex-1 text-13 text-ink">{option.label}</span>
          </button>
        ))}
      </div>
      {others.length > 2 && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button variant="secondary" size={28} onClick={() => setShowAlternatives((current) => !current)}>
            {showAlternatives ? "Hide alternatives" : "Alternatives"}
          </Button>
        </div>
      )}
    </>
  );
  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-card" aria-label="Agent recommendation">
      <div className="px-3 py-3">
        <p className="text-13 font-medium text-ink">{question}</p>
        {recommendation && (
          <button
            type="button"
            onClick={() => onSelect(recommendation)}
            className="mt-2 flex w-full items-start gap-2 rounded-control bg-inset px-3 py-2 text-left transition-colors hover:bg-hover active:bg-hover-2"
          >
            <RecommendedBars />
            <span className="min-w-0 flex-1 text-13 text-ink">{recommendation.label}</span>
            <span className="shrink-0 rounded-full bg-field px-1.5 py-0.5 text-10 font-medium text-ink-2">Recommended</span>
          </button>
        )}
        {!separate && others.length > 0 && <div className={recommendation ? "mt-1" : "mt-3"}>{rows}</div>}
      </div>
      {separate && (
        <div className="border-t border-line px-3 py-2">
          <SectionLabel as="div" className="mb-1.5">
            Other options
          </SectionLabel>
          {rows}
        </div>
      )}
    </section>
  );
}
