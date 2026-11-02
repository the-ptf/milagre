import { BubbleChatQuestionIcon } from "@hugeicons/core-free-icons";
import type { AnsweredQuestion } from "../../model";
import { Icon } from "../primitives/Icon";

/** The user's answers to the agent's questions, shown as each question with what was picked or typed instead of the text the agent reads. */
export function AnswerCard({ answered }: { answered: AnsweredQuestion[] }) {
  return (
    <div data-slot="answer-card" className="w-full max-w-md overflow-hidden rounded-card border border-line bg-surface text-13">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-12 text-ink-2">
        <Icon icon={BubbleChatQuestionIcon} size={14} />
        {answered.length === 1 ? "Answered the question" : `Answered ${answered.length} questions`}
      </div>
      {answered.map((item, index) => (
        <div key={index} data-slot="answer-card-row" className="border-t border-line px-3 py-2 first:border-t-0">
          <span className="block text-12 text-ink-3">{item.question}</span>
          <span className="block font-medium text-ink">{item.answers.join(", ")}</span>
        </div>
      ))}
    </div>
  );
}
